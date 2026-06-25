//! Prize-pool finalization (#... finalize_event).
//!
//! Once an event has ended and every match is resolved, [`finalize_event`]
//! ranks participants, splits the escrowed prize pool according to the event's
//! `reward_distribution`, and pays the top-N addresses. It is **permissionless**:
//! anyone may call it (it simply triggers the payout once all conditions are
//! met), mirroring the old `verify_event_winners` entry point.

use soroban_sdk::{Address, Env, Symbol, Vec};

use crate::admin;
use crate::event::{self, EventError};
use crate::leaderboard;
use crate::storage::{self, TTL_LEDGERS};
use crate::storage_types::DataKey;
use crate::token::TokenHelper;

// ---------------------------------------------------------------------------
// finalize_event
// ---------------------------------------------------------------------------

/// Rank participants, split the prize pool, and pay out the top-N addresses.
///
/// `caller.require_auth()` is enforced but the call is otherwise permissionless:
/// anyone may finalize an event once its conditions are met.
///
/// # Checks (in order)
/// 1. Contract not paused ([`EventError::Paused`]).
/// 2. Event exists ([`EventError::EventNotFound`]).
/// 3. Event not cancelled ([`EventError::EventCancelled`]).
/// 4. Event not already finalized ([`EventError::AlreadyFinalized`]).
/// 5. Event has ended — `now >= end_time` ([`EventError::EventNotEnded`]).
/// 6. Every match resolved — each match's `result_submitted == true`
///    ([`EventError::MatchesNotComplete`]).
///
/// # Payout
/// The leaderboard ([`leaderboard::get_event_leaderboard`]) is fully
/// deterministic (points → exact_scores → earliest prediction → address), so
/// there are **no shared ranks**: every participant has a distinct rank and
/// therefore a distinct (possibly zero) payout. There is intentionally no
/// "split the rank" logic here — determinism is handled upstream.
///
/// For each paid rank `i` in `0..n.min(leaderboard.len())` (where
/// `n = reward_distribution.len()`):
/// `amount = prize_pool * reward_distribution[i] / 100`, transferred to
/// `leaderboard[i].user`.
///
/// Any leftover — the unallocated percentage when there are fewer participants
/// than reward ranks, plus integer-division dust — is sent to `event.creator`
/// in a single transfer (`prize_pool - total_distributed`). With zero
/// participants the entire prize pool is refunded to the creator. After this
/// call no XLM is left stranded in the contract.
///
/// On success the event is marked `is_finalized`, the payout vector is stored
/// under [`DataKey::EventPayouts`] for historical queries, a
/// `(event, finalized)` event is emitted with
/// `(event_id, winners_paid, total_distributed)`, and the payout vector is
/// returned.
pub fn finalize_event(
    env: &Env,
    caller: Address,
    event_id: u64,
) -> Result<Vec<(Address, i128)>, EventError> {
    // Permissionless: anyone may trigger payout, but they must authorize.
    caller.require_auth();

    // 1. Not paused.
    if admin::is_paused(env) {
        return Err(EventError::Paused);
    }

    // 2. Event exists.
    let mut event = event::get_event(env, event_id)?;

    // 3. Not cancelled.
    if event.is_cancelled {
        return Err(EventError::EventCancelled);
    }

    // 4. Not already finalized.
    if event.is_finalized {
        return Err(EventError::AlreadyFinalized);
    }

    // 5. Event has ended.
    let now = env.ledger().timestamp();
    if !event.has_ended(now) {
        return Err(EventError::EventNotEnded);
    }

    // 6. Every match resolved.
    let match_ids = storage::get_event_matches(env, event_id);
    for match_id in match_ids.iter() {
        match storage::get_match(env, match_id) {
            Ok(m) => {
                if !m.result_submitted {
                    return Err(EventError::MatchesNotComplete);
                }
            }
            // A missing match record is treated as unresolved.
            Err(_) => return Err(EventError::MatchesNotComplete),
        }
    }

    // Ranked, deterministic leaderboard. The event was already loaded above, so
    // the only residual error path here is an (effectively unreachable) points
    // overflow; collapse it onto EventNotFound to stay within EventError.
    let leaderboard =
        leaderboard::get_event_leaderboard(env, event_id).map_err(|_| EventError::EventNotFound)?;

    let xlm_token = admin::get_xlm_token(env).unwrap_or_else(|| panic!("not_initialized"));

    let prize_pool = event.prize_pool;
    let n = event.reward_distribution.len();
    let paid_ranks = n.min(leaderboard.len());

    let mut payouts: Vec<(Address, i128)> = Vec::new(env);
    let mut total_distributed: i128 = 0;

    for i in 0..paid_ranks {
        let percent = event.reward_distribution.get(i).unwrap();
        let entry = leaderboard.get(i).unwrap();
        let amount = prize_pool * percent as i128 / 100;

        // Skip zero-value transfers (the token client rejects amount <= 0), but
        // still record the rank so the snapshot reflects every paid position.
        if amount > 0 {
            TokenHelper::distribute_winnings(env, &xlm_token, &entry.user, amount)
                .map_err(|_| EventError::TransferFailed)?;
            total_distributed += amount;
        }

        payouts.push_back((entry.user.clone(), amount));
    }

    // Refund the unallocated percentage + integer-division dust to the creator
    // in a single transfer. With zero participants this is the full prize pool.
    let refund_to_creator = prize_pool - total_distributed;
    if refund_to_creator > 0 {
        TokenHelper::distribute_winnings(env, &xlm_token, &event.creator, refund_to_creator)
            .map_err(|_| EventError::TransferFailed)?;
    }

    // Mark finalized and persist.
    event.is_finalized = true;
    storage::set_event(env, event_id, &event);

    // Store the payout snapshot for historical queries.
    let payouts_key = DataKey::EventPayouts(event_id);
    env.storage().persistent().set(&payouts_key, &payouts);
    env.storage()
        .persistent()
        .extend_ttl(&payouts_key, TTL_LEDGERS, TTL_LEDGERS);

    env.events().publish(
        (Symbol::new(env, "event"), Symbol::new(env, "finalized")),
        (event_id, payouts.len(), total_distributed),
    );

    Ok(payouts)
}

// ---------------------------------------------------------------------------
// get_event_payouts
// ---------------------------------------------------------------------------

/// Return the stored payout snapshot for an event.
///
/// Returns the `Vec<(Address, i128)>` recorded by [`finalize_event`], or an
/// empty vector when the event has not been finalized (or does not exist).
pub fn get_event_payouts(env: &Env, event_id: u64) -> Vec<(Address, i128)> {
    let key = DataKey::EventPayouts(event_id);
    match env
        .storage()
        .persistent()
        .get::<DataKey, Vec<(Address, i128)>>(&key)
    {
        Some(payouts) => {
            env.storage()
                .persistent()
                .extend_ttl(&key, TTL_LEDGERS, TTL_LEDGERS);
            payouts
        }
        None => Vec::new(env),
    }
}
