//! Prize-pool finalization, staged claims, and no-show clawback (#1312).
//!
//! Once an event has ended and every match is resolved, [`finalize_event`]
//! ranks participants and splits the escrowed prize pool according to the
//! event's `reward_distribution` — but instead of transferring winnings
//! immediately, it records a per-winner [`PrizeAllocation`] with a claim
//! deadline. Winners settle their own allocation via [`claim_prize`]; any
//! allocation still unclaimed once the deadline passes may be swept to
//! treasury via [`clawback_unclaimed`]. `finalize_event` remains
//! **permissionless**: anyone may call it once all conditions are met,
//! mirroring the old `verify_event_winners` entry point.

use soroban_sdk::{Address, Env, Symbol, Vec};

use crate::admin;
use crate::event::{self, EventError};
use crate::leaderboard;
use crate::storage::{self, TTL_LEDGERS};
use crate::storage_types::{DataKey, PrizeAllocation, CLAIM_PERIOD_SECONDS};
use crate::token::TokenHelper;

// ---------------------------------------------------------------------------
// finalize_event
// ---------------------------------------------------------------------------

/// Rank participants, split the prize pool, and stage per-winner allocations.
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
/// `amount = prize_pool * reward_distribution[i] / 100`. Rather than
/// transferring this amount immediately, a [`PrizeAllocation`] is recorded
/// under [`DataKey::PrizeAllocation`] for `leaderboard[i].user` — the winner
/// must call [`claim_prize`] to receive it. This is what enables
/// [`clawback_unclaimed`] to reclaim allocations nobody ever claims.
///
/// Any leftover — the unallocated percentage when there are fewer participants
/// than reward ranks, plus integer-division dust — is sent to `event.creator`
/// immediately, in a single transfer (`prize_pool - total_distributed`). With
/// zero participants the entire prize pool is refunded to the creator. This
/// creator refund is not staged: only winner allocations go through
/// claim/clawback.
///
/// On success the event is marked `is_finalized`, the payout vector is stored
/// under [`DataKey::EventPayouts`] for historical queries, the claim deadline
/// (`now + CLAIM_PERIOD_SECONDS`) is stored under [`DataKey::ClaimDeadline`],
/// a `(event, finalized)` event is emitted with
/// `(event_id, winners_paid, total_distributed)`, and the payout vector
/// (allocated amounts, not yet transferred) is returned.
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

    // Recompute and persist the final weighted standings snapshot (#1311).
    // Every match is resolved at this point, so this stores the definitive
    // end-of-event standings. Payouts below intentionally remain driven by the
    // points leaderboard.
    leaderboard::recompute_standings(env, event_id).map_err(|_| EventError::EventNotFound)?;

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

        // Skip zero-value allocations (nothing to claim), but still record
        // the rank so the snapshot reflects every paid position.
        if amount > 0 {
            storage::set_prize_allocation(
                env,
                &PrizeAllocation {
                    winner: entry.user.clone(),
                    event_id,
                    amount,
                    claimed: false,
                },
            );
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

    // Winners have from now until this deadline to claim_prize before their
    // allocation becomes eligible for clawback_unclaimed.
    storage::set_claim_deadline(env, event_id, now + CLAIM_PERIOD_SECONDS);

    env.events().publish(
        (Symbol::new(env, "event"), Symbol::new(env, "finalized")),
        (event_id, payouts.len(), total_distributed),
    );

    Ok(payouts)
}

// ---------------------------------------------------------------------------
// claim_prize (#1312)
// ---------------------------------------------------------------------------

/// Claim a winner's staged prize allocation from a finalized event.
///
/// Transfers the winner's [`PrizeAllocation::amount`] to `winner` exactly
/// once. Requires `winner.require_auth()` — only the allocated winner may
/// claim their own allocation.
///
/// # Checks (in order)
/// 1. Contract not paused ([`EventError::Paused`]).
/// 2. Event exists ([`EventError::EventNotFound`]).
/// 3. Event is finalized ([`EventError::EventNotFinalized`]).
/// 4. `winner` has a recorded allocation ([`EventError::NoAllocation`]).
/// 5. The allocation has not already been settled — by an earlier
///    `claim_prize` call or by `clawback_unclaimed`
///    ([`EventError::AlreadyClaimed`]).
///
/// On success, marks the allocation `claimed`, transfers the funds, emits a
/// `(prize, claimed)` event with `(event_id, winner, amount)`, and returns
/// the claimed amount.
pub fn claim_prize(env: &Env, winner: Address, event_id: u64) -> Result<i128, EventError> {
    winner.require_auth();

    if admin::is_paused(env) {
        return Err(EventError::Paused);
    }

    let event = event::get_event(env, event_id)?;
    if !event.is_finalized {
        return Err(EventError::EventNotFinalized);
    }

    let mut allocation =
        storage::get_prize_allocation(env, event_id, &winner).ok_or(EventError::NoAllocation)?;

    if allocation.claimed {
        return Err(EventError::AlreadyClaimed);
    }

    let xlm_token = admin::get_xlm_token(env).unwrap_or_else(|| panic!("not_initialized"));
    TokenHelper::distribute_winnings(env, &xlm_token, &winner, allocation.amount)
        .map_err(|_| EventError::TransferFailed)?;

    allocation.claimed = true;
    storage::set_prize_allocation(env, &allocation);

    env.events().publish(
        (Symbol::new(env, "prize"), Symbol::new(env, "claimed")),
        (event_id, winner, allocation.amount),
    );

    Ok(allocation.amount)
}

// ---------------------------------------------------------------------------
// clawback_unclaimed (#1312)
// ---------------------------------------------------------------------------

/// Sweep every still-unclaimed prize allocation for a finalized event to
/// treasury, once the event's claim deadline has passed.
///
/// Permissionless — like `finalize_event`, anyone may trigger the sweep, but
/// they must authorize the call. Only allocations with `claimed == false` are
/// swept; allocations already claimed by their winner are left untouched.
/// Calling this again after a full sweep is a harmless no-op (every
/// allocation is already `claimed`, so nothing more moves).
///
/// # Checks (in order)
/// 1. Contract not paused ([`EventError::Paused`]).
/// 2. Event exists ([`EventError::EventNotFound`]).
/// 3. Event is finalized ([`EventError::EventNotFinalized`]).
/// 4. The claim deadline has passed — `now >= claim_deadline`
///    ([`EventError::ClaimPeriodNotExpired`]).
///
/// Returns the total amount swept to treasury (`0` if nothing was
/// unclaimed).
pub fn clawback_unclaimed(env: &Env, caller: Address, event_id: u64) -> Result<i128, EventError> {
    caller.require_auth();

    if admin::is_paused(env) {
        return Err(EventError::Paused);
    }

    let event = event::get_event(env, event_id)?;
    if !event.is_finalized {
        return Err(EventError::EventNotFinalized);
    }

    let deadline = storage::get_claim_deadline(env, event_id).unwrap_or(u64::MAX);
    let now = env.ledger().timestamp();
    if now < deadline {
        return Err(EventError::ClaimPeriodNotExpired);
    }

    let treasury = admin::get_treasury(env).unwrap_or_else(|| panic!("not_initialized"));
    let xlm_token = admin::get_xlm_token(env).unwrap_or_else(|| panic!("not_initialized"));

    let payouts = get_event_payouts(env, event_id);
    let mut swept: i128 = 0;

    for (winner, amount) in payouts.iter() {
        if amount <= 0 {
            continue;
        }
        let mut allocation = match storage::get_prize_allocation(env, event_id, &winner) {
            Some(a) => a,
            None => continue,
        };
        if allocation.claimed {
            continue;
        }
        allocation.claimed = true;
        storage::set_prize_allocation(env, &allocation);
        swept += allocation.amount;
    }

    if swept > 0 {
        TokenHelper::distribute_winnings(env, &xlm_token, &treasury, swept)
            .map_err(|_| EventError::TransferFailed)?;
    }

    env.events().publish(
        (Symbol::new(env, "prize"), Symbol::new(env, "clawed_back")),
        (event_id, swept),
    );

    Ok(swept)
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
