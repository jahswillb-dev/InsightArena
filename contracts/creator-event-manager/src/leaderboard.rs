//! Ranked event leaderboard computation.
//!
//! This module provides the core leaderboard functionality for events, ranking
//! participants by total points with deterministic tie-breaking. The leaderboard
//! is computed on-demand (live) and can be called before all matches are resolved,
//! with unresolved matches contributing 0 points.

use soroban_sdk::{Env, Vec};

use crate::event::{self, EventError};
use crate::storage;
use crate::storage_types::LeaderboardEntry;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum LeaderboardError {
    /// No event found for the given event_id.
    EventNotFound = 1,
    /// Arithmetic overflow during calculation.
    Overflow = 2,
}

impl From<EventError> for LeaderboardError {
    fn from(_: EventError) -> Self {
        LeaderboardError::EventNotFound
    }
}

// ---------------------------------------------------------------------------
// get_event_leaderboard (#967)
// ---------------------------------------------------------------------------

/// Retrieve a ranked leaderboard for an event, sorted by total points.
///
/// This function computes a live leaderboard based on all participants' total
/// points earned from predictions. The leaderboard is available before all
/// matches are resolved; predictions for unresolved matches contribute 0 points.
///
/// # Ranking Rules (all in order):
/// 1. **Higher total_points** — primary sort key (descending).
/// 2. **Higher exact_scores** — tiebreaker (descending).
/// 3. **Earlier last_prediction_time** — tiebreaker (ascending).
/// 4. **Address byte comparison** — final deterministic tiebreaker.
///
/// # Flow:
/// 1. Verify the event exists.
/// 2. Retrieve all participants for the event.
/// 3. For each participant:
///    - Sum `points_earned` from all their predictions → `total_points`.
///    - Count predictions where `is_correct == Some(true)` → `correct_results`.
///    - Count predictions where `points_earned == Some(4)` → `exact_scores`.
///    - Count total predictions submitted → `matches_played`.
///    - Find max `predicted_at` → `last_prediction_time`.
/// 4. Sort entries by the ranking rules above.
/// 5. Assign rank 1..N in sorted order.
/// 6. Return the sorted leaderboard.
///
/// # Returns
/// A `Vec<LeaderboardEntry>` sorted by total points descending, with all
/// tiebreakers applied and ranks assigned. Returns an empty `Vec` if the
/// event has no participants.
///
/// # Errors
/// * [`LeaderboardError::EventNotFound`] — no event with the given event_id.
/// * [`LeaderboardError::Overflow`] — arithmetic overflow during calculation.
pub fn get_event_leaderboard(
    env: &Env,
    event_id: u64,
) -> Result<Vec<LeaderboardEntry>, LeaderboardError> {
    // 1. Verify event exists
    let _event = event::get_event(env, event_id)?;

    // 2. Retrieve all participants
    let participants = storage::get_event_participants(env, event_id);

    // 3. Build leaderboard entries
    let mut entries: Vec<LeaderboardEntry> = Vec::new(env);

    for participant in participants.iter() {
        let user_predictions = storage::get_user_predictions(env, &participant, event_id);

        let mut total_points: u32 = 0;
        let mut correct_results: u32 = 0;
        let mut exact_scores: u32 = 0;
        let mut last_prediction_time: u64 = 0;

        // Calculate stats from all predictions
        for prediction_id in user_predictions.iter() {
            if let Ok(prediction) = storage::get_prediction(env, prediction_id) {
                // Add earned points (None counts as 0)
                if let Some(points) = prediction.points_earned {
                    total_points = total_points
                        .checked_add(points)
                        .ok_or(LeaderboardError::Overflow)?;
                }

                // Count correct results
                if prediction.is_correct == Some(true) {
                    correct_results = correct_results
                        .checked_add(1)
                        .ok_or(LeaderboardError::Overflow)?;
                }

                // Count exact scores (4 points means exact score)
                if prediction.points_earned
                    == Some(
                        crate::storage_types::POINTS_CORRECT_RESULT
                            + crate::storage_types::POINTS_EXACT_SCORE,
                    )
                {
                    exact_scores = exact_scores
                        .checked_add(1)
                        .ok_or(LeaderboardError::Overflow)?;
                }

                // Track latest prediction time
                if prediction.predicted_at > last_prediction_time {
                    last_prediction_time = prediction.predicted_at;
                }
            }
        }

        // Create entry (rank will be assigned after sorting)
        let matches_played = user_predictions.len();
        let entry = LeaderboardEntry::new(
            participant.clone(),
            event_id,
            total_points,
            correct_results,
            exact_scores,
            matches_played,
            last_prediction_time,
        );
        entries.push_back(entry);
    }

    // 4. Sort entries using insertion sort (stable and suitable for small lists)
    let len = entries.len();
    for i in 1..len {
        let mut j = i;
        while j > 0 {
            let prev = entries.get(j - 1).unwrap();
            let curr = entries.get(j).unwrap();
            if prev.outranks(&curr) {
                // prev ranks higher, no swap needed
                break;
            } else {
                // curr ranks higher, swap
                entries.set(j - 1, curr);
                entries.set(j, prev);
                j -= 1;
            }
        }
    }

    // 5. Assign ranks (1-based)
    for i in 0..len {
        let mut entry = entries.get(i).unwrap();
        entry.rank = (i as u32) + 1;
        entries.set(i, entry);
    }

    Ok(entries)
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    // Note: Unit tests for leaderboard functions require Soroban contract context.
    // Integration tests are provided in tests/ directory.
}
