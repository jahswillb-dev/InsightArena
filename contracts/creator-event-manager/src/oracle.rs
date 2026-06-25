use soroban_sdk::{Address, Env, Symbol};

use crate::admin;
use crate::storage::{self, StorageError};
use crate::storage_types::{Event, Match, MatchResult};

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum OracleError {
    /// Contract is paused; no operations allowed.
    Paused = 1,
    /// No event found for the given event_id.
    EventNotFound = 2,
    /// Event has been cancelled and cannot be processed.
    #[allow(dead_code)]
    EventCancelled = 3,
    /// Not all matches in the event have been resolved yet.
    #[allow(dead_code)]
    MatchesNotComplete = 4,
    /// No creation fee has been set (should not happen after init).
    #[allow(dead_code)]
    CreationFeeNotSet = 5,
    /// Arithmetic overflow occurred during calculation.
    Overflow = 6,
    /// Caller is not the authorized AI agent. (#810)
    Unauthorized = 7,
    /// No match found for the given match_id. (#810)
    MatchNotFound = 8,
    /// A result has already been submitted for this match. (#810)
    ResultAlreadySubmitted = 9,
    /// The match has not started yet (current time < match_time). (#810)
    MatchNotStarted = 10,
}

impl From<StorageError> for OracleError {
    fn from(_: StorageError) -> Self {
        OracleError::EventNotFound
    }
}

// ---------------------------------------------------------------------------
// Event emission
// ---------------------------------------------------------------------------

fn emit_match_result_submitted(
    env: &Env,
    match_id: u64,
    winning_team: &Symbol,
    submitted_by: &Address,
) {
    env.events().publish(
        (
            Symbol::new(env, "match"),
            Symbol::new(env, "result_submitted"),
        ),
        (match_id, winning_team.clone(), submitted_by.clone()),
    );
}

// ---------------------------------------------------------------------------
// submit_match_result (#810, #966)
// ---------------------------------------------------------------------------

/// Submit a match result as the authorized AI oracle agent (#810, #966).
///
/// This is the core oracle function that resolves a match and grades every
/// prediction made for it. Accepts a final scoreline and derives the 1X2 result.
///
/// # Flow
/// 1. Require caller authorization.
/// 2. Reject if the contract is paused.
/// 3. Reject if the caller is not the stored AI agent address.
/// 4. Retrieve the match and verify it exists.
/// 5. Verify a result has not already been submitted.
/// 6. Verify the match has started (`now >= match_time`).
/// 7. Store home_score, away_score, and derive winning_team from the scores.
/// 8. Update the match.
/// 9. Grade every prediction for the match (is_correct, points_earned).
/// 10. Emit a `MatchResultSubmitted` event.
///
/// # Errors
/// * [`OracleError::Paused`] — the contract is paused.
/// * [`OracleError::Unauthorized`] — caller is not the AI agent.
/// * [`OracleError::MatchNotFound`] — no match with the given id.
/// * [`OracleError::ResultAlreadySubmitted`] — result already recorded.
/// * [`OracleError::MatchNotStarted`] — match has not started yet.
pub fn submit_match_result(
    env: &Env,
    caller: Address,
    match_id: u64,
    home_score: u32,
    away_score: u32,
) -> Result<(), OracleError> {
    caller.require_auth();

    // 1. Contract must not be paused.
    if admin::is_paused(env) {
        return Err(OracleError::Paused);
    }

    // 2. Caller must be the authorized AI agent.
    let ai_agent = admin::get_ai_agent(env).ok_or(OracleError::Unauthorized)?;
    if caller != ai_agent {
        return Err(OracleError::Unauthorized);
    }

    // 3. Match must exist.
    let mut match_record: Match =
        storage::get_match(env, match_id).map_err(|_| OracleError::MatchNotFound)?;

    // 4. Result must not already be submitted.
    if match_record.result_submitted {
        return Err(OracleError::ResultAlreadySubmitted);
    }

    // 5. Match must have started.
    let now = env.ledger().timestamp();
    if now < match_record.match_time {
        return Err(OracleError::MatchNotStarted);
    }

    // 6. Derive result from scores and record it on the match.
    let result = MatchResult::from_scores(home_score, away_score);
    match_record
        .submit_result(result.clone(), caller.clone(), now)
        .map_err(|_| OracleError::ResultAlreadySubmitted)?;

    // 7. Store the actual scores.
    match_record.home_score = Some(home_score);
    match_record.away_score = Some(away_score);
    storage::set_match(env, match_id, &match_record);

    // 8. Grade every prediction submitted for this match.
    let prediction_ids = storage::get_match_predictions(env, match_id);
    for prediction_id in prediction_ids.iter() {
        if let Ok(mut prediction) = storage::get_prediction(env, prediction_id) {
            prediction.grade(home_score, away_score, match_record.points_multiplier);
            storage::set_prediction(env, prediction_id, &prediction);
        }
    }

    // 9. Emit the result event using the derived outcome symbol.
    let outcome_symbol = match result {
        MatchResult::TeamA => Symbol::new(env, crate::storage_types::OUTCOME_TEAM_A),
        MatchResult::TeamB => Symbol::new(env, crate::storage_types::OUTCOME_TEAM_B),
        MatchResult::Draw => Symbol::new(env, crate::storage_types::OUTCOME_DRAW),
    };
    emit_match_result_submitted(env, match_id, &outcome_symbol, &caller);

    Ok(())
}

// ---------------------------------------------------------------------------
// get_user_score (#800)
// ---------------------------------------------------------------------------

/// Calculate a user's score (points and statistics) for an event.
///
/// # Flow
/// 1. Retrieve user's predictions for the event.
/// 2. Sum total_points earned from all predictions.
/// 3. Count predictions where the result (1X2) was correct.
/// 4. Count predictions where the exact score was correct.
/// 5. Get total match count for the event.
/// 6. Return tuple: (total_points, correct_results, exact_scores, total_matches).
///
/// # Returns
/// A tuple `(total_points, correct_results, exact_scores, total_matches)` where:
/// - `total_points`: Sum of points_earned from all predictions.
/// - `correct_results`: Number of matches with correct 1X2 result.
/// - `exact_scores`: Number of matches with exact scoreline prediction.
/// - `total_matches`: Total number of matches in the event.
pub fn get_user_score(
    env: &Env,
    user: Address,
    event_id: u64,
) -> Result<(u32, u32, u32, u32), OracleError> {
    // Retrieve event to get total match count
    let event: Event = storage::get_event(env, event_id)?;
    let total_matches = event.match_count;

    // Retrieve user's predictions for the event
    let user_predictions = storage::get_user_predictions(env, &user, event_id);

    // Calculate scores and stats
    let mut total_points: u32 = 0;
    let mut correct_results: u32 = 0;
    let mut exact_scores: u32 = 0;

    for prediction_id in user_predictions.iter() {
        if let Ok(prediction) = storage::get_prediction(env, prediction_id) {
            // Add earned points
            if let Some(points) = prediction.points_earned {
                total_points = total_points
                    .checked_add(points)
                    .ok_or(OracleError::Overflow)?;
            }
            // Count correct results
            if prediction.is_correct == Some(true) {
                correct_results = correct_results
                    .checked_add(1)
                    .ok_or(OracleError::Overflow)?;
            }
            // Count exact scores: load the match to compare actual vs predicted scores.
            // This is multiplier-agnostic — an exact score is one where both predicted
            // scores match the actual scores, regardless of the points multiplier.
            if let Ok(match_record) = storage::get_match(env, prediction.match_id) {
                if let (Some(actual_home), Some(actual_away)) =
                    (match_record.home_score, match_record.away_score)
                {
                    if prediction.predicted_home_score == actual_home
                        && prediction.predicted_away_score == actual_away
                    {
                        exact_scores = exact_scores.checked_add(1).ok_or(OracleError::Overflow)?;
                    }
                }
            }
        }
    }

    Ok((total_points, correct_results, exact_scores, total_matches))
}

// ---------------------------------------------------------------------------
// get_creation_fee (#801)
// ---------------------------------------------------------------------------

/// Retrieve the current XLM fee required to create an event.
///
/// # Flow
/// 1. Retrieve CreationFee from storage.
/// 2. Return i128 value.
/// 3. Return default if not set (should not happen after init).
///
/// # Returns
/// The creation fee in stroops (i128).
#[allow(dead_code)]
pub fn get_creation_fee(env: &Env) -> Result<i128, OracleError> {
    admin::get_creation_fee(env).ok_or(OracleError::CreationFeeNotSet)
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    // Note: Unit tests for oracle functions require Soroban contract context.
    // Integration tests are provided in tests/ directory.
    // To run integration tests: cargo test --test oracle_integration_tests
    //
    // Unit tests would require wrapping all storage access with env.as_contract(),
    // which is better handled in integration tests with proper contract setup.
}
