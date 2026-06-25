use soroban_sdk::{contracttype, Address, String, Symbol, Vec};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum number of leaderboard ranks that can receive a prize pool payout.
pub const MAX_REWARD_RANKS: u32 = 5;
/// The reward distribution percentages must sum to exactly this value.
pub const REWARD_PERCENT_TOTAL: u32 = 100;

/// Maximum length for event title (characters)
pub const MAX_TITLE_LEN: u32 = 200;
/// Maximum length for event description (characters)
pub const MAX_DESCRIPTION_LEN: u32 = 1000;
/// Maximum length for team names (characters)
pub const MAX_TEAM_NAME_LEN: u32 = 100;
/// Maximum event duration in seconds (90 days)
pub const MAX_EVENT_DURATION_SECONDS: u64 = 7_776_000;
/// Valid predicted outcome symbols
pub const OUTCOME_TEAM_A: &str = "TEAM_A";
pub const OUTCOME_TEAM_B: &str = "TEAM_B";
pub const OUTCOME_DRAW: &str = "DRAW";

/// Points awarded for predicting the correct 1X2 result (wrong scoreline)
pub const POINTS_CORRECT_RESULT: u32 = 1;
/// Points awarded for predicting the exact scoreline (in addition to result points)
pub const POINTS_EXACT_SCORE: u32 = 3;
/// Maximum allowed points multiplier for a bonus match (inclusive). Caps total
/// points at 3× to keep cumulative leaderboard scores bounded.
pub const MAX_POINTS_MULTIPLIER: u32 = 3;

// ---------------------------------------------------------------------------
// MatchResult
// ---------------------------------------------------------------------------

/// Possible outcomes of a prediction match.
///
/// Encoded as u8 on the wire: 0 = TeamA, 1 = TeamB, 2 = Draw.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MatchResult {
    /// First team / option A wins
    TeamA,
    /// Second team / option B wins
    TeamB,
    /// Match ends in a draw / tie
    Draw,
}

impl MatchResult {
    /// Encode to u8 for compact storage and prediction fields.
    pub fn to_u8(&self) -> u8 {
        match self {
            MatchResult::TeamA => 0,
            MatchResult::TeamB => 1,
            MatchResult::Draw => 2,
        }
    }

    /// Decode from u8.  Returns `None` for any value outside 0–2.
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(MatchResult::TeamA),
            1 => Some(MatchResult::TeamB),
            2 => Some(MatchResult::Draw),
            _ => None,
        }
    }

    /// Convenience alias kept for callers that still use u32.
    pub fn to_u32(&self) -> u32 {
        self.to_u8() as u32
    }

    /// Convenience alias kept for callers that still use u32.
    pub fn from_u32(value: u32) -> Option<Self> {
        if value > u8::MAX as u32 {
            return None;
        }
        Self::from_u8(value as u8)
    }

    /// Derive the 1X2 result from a final scoreline.
    pub fn from_scores(home: u32, away: u32) -> MatchResult {
        use core::cmp::Ordering;
        match home.cmp(&away) {
            Ordering::Greater => MatchResult::TeamA,
            Ordering::Less => MatchResult::TeamB,
            Ordering::Equal => MatchResult::Draw,
        }
    }
}

// ---------------------------------------------------------------------------
// DataKey
// ---------------------------------------------------------------------------

/// Unified storage key enum for every piece of contract state.
///
/// Using a single enum keeps key namespacing explicit and avoids collisions
/// between different storage domains.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    // ── Global admin / config keys ──────────────────────────────────────────
    /// Contract administrator address
    Admin(Address),

    /// AI agent address authorised to submit match results
    AIAgent(Address),

    /// Treasury address that receives creation fees
    Treasury(Address),

    /// XLM creation fee in stroops (i128)
    CreationFee(i128),

    /// Emergency pause flag — when true, sensitive operations are halted
    Paused(bool),

    /// Native XLM token contract address
    XLMToken(Address),

    // ── Global counters ─────────────────────────────────────────────────────
    /// Monotonically increasing event counter → u64
    EventCounter(u64),

    /// Monotonically increasing match counter → u64
    MatchCounter(u64),

    /// Monotonically increasing prediction counter → u64
    PredictionCounter(u64),

    // ── Core entity keys ────────────────────────────────────────────────────
    /// Core event data keyed by event_id
    Event(u64),

    /// Individual match keyed by match_id
    Match(u64),

    /// A user's prediction keyed by prediction_id
    Prediction(u64),

    // ── Relationship / index keys ────────────────────────────────────────────
    /// Vec<u64> of match IDs belonging to an event  (event_id)
    EventMatches(u64),

    /// Vec<u64> of prediction IDs for a match  (match_id)
    MatchPredictions(u64),

    /// Vec<u64> of prediction IDs a user has placed in an event  (user, event_id)
    UserPredictions(Address, u64),

    /// Vec<Address> of participants for an event  (event_id)
    EventParticipants(u64),

    /// Vec<(Address, i128)> snapshot of prize-pool payouts for a finalized
    /// event  (event_id). Written once by `finalize_event`.
    EventPayouts(u64),

    // ── Initialization sentinel ──────────────────────────────────────────────
    /// Set to `true` once `initialize` has been called; prevents re-init.
    Initialized,

    // ── Canonical address lookups (no-payload keys for retrieval) ────────────
    /// Current treasury address — updated by set_treasury; used for fee routing.
    CurrentTreasury,

    /// Current AI agent address — updated by set_ai_agent; used for oracle auth.
    CurrentAIAgent,
    /// Current admin address — set during initialize for canonical retrieval.
    CurrentAdmin,

    // ── Verification keys (#790–#793) ────────────────────────────────────────
    /// Verification status for an address — true = verified, false = not verified.
    VerifiedAddresses(Address),

    // ── Event invite code index (#795) ───────────────────────────────────────
    /// Maps an 8-character invite code Symbol → event_id (u64).
    InviteCode(Symbol),

    // ── Canonical XLM token key (#794) ───────────────────────────────────────
    /// Current XLM token contract address — set during initialize.
    CurrentXLMToken,
}

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

/// Core event struct — all information about a creator's prediction event.
///
/// Stored under `DataKey::Event(event_id)`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Event {
    /// Auto-incremented unique identifier
    pub event_id: u64,

    /// Address of the creator; only they can manage the event
    pub creator: Address,

    /// Human-readable title (max `MAX_TITLE_LEN` chars)
    pub title: String,

    /// Full description / rules (max `MAX_DESCRIPTION_LEN` chars)
    pub description: String,

    /// XLM fee (in stroops) the creator paid to create the event
    pub creation_fee_paid: i128,

    /// Unix timestamp when the event was created
    pub created_at: u64,

    /// Unix timestamp when the event starts accepting predictions
    pub start_time: u64,

    /// Unix timestamp when the event ends and no more predictions are accepted
    pub end_time: u64,

    /// Whether the event is open for new predictions
    pub is_active: bool,

    /// Whether the event has been cancelled
    pub is_cancelled: bool,

    /// 8-character invite code used for private events
    pub invite_code: Symbol,

    /// Hard cap on participants (0 = unlimited)
    pub max_participants: u32,

    /// Current number of confirmed participants
    pub participant_count: u32,

    /// Number of matches that belong to this event
    pub match_count: u32,

    /// XLM prize pool (in stroops) escrowed in the contract for winners.
    /// `0` means this is a "fun event" with no payouts. Grows as paid
    /// participants join (see `entry_fee`).
    pub prize_pool: i128,

    /// XLM fee (in stroops) each participant pays to join. `0` = free to join.
    /// When non-zero, the fee is collected on `join_event` and added to
    /// `prize_pool`.
    pub entry_fee: i128,

    /// Percentage of the prize pool awarded to each leaderboard rank, in
    /// 1-based rank order (index 0 → rank 1). Each entry is 1–100 and the
    /// entries sum to `REWARD_PERCENT_TOTAL` when `prize_pool > 0`; the vector
    /// is empty when `prize_pool == 0`.
    pub reward_distribution: Vec<u32>,

    /// Whether the prize pool has been distributed / the event closed out.
    pub is_finalized: bool,
}

impl Event {
    /// Construct a new active, uncancelled event.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        event_id: u64,
        creator: Address,
        title: String,
        description: String,
        creation_fee_paid: i128,
        created_at: u64,
        start_time: u64,
        end_time: u64,
        invite_code: Symbol,
        max_participants: u32,
        prize_pool: i128,
        reward_distribution: Vec<u32>,
        entry_fee: i128,
    ) -> Self {
        Self {
            event_id,
            creator,
            title,
            description,
            creation_fee_paid,
            created_at,
            start_time,
            end_time,
            is_active: true,
            is_cancelled: false,
            invite_code,
            max_participants,
            participant_count: 0,
            match_count: 0,
            prize_pool,
            entry_fee,
            reward_distribution,
            is_finalized: false,
        }
    }

    /// `true` once `current_time >= end_time`.
    pub fn has_ended(&self, current_time: u64) -> bool {
        current_time >= self.end_time
    }

    /// `true` if `time` falls within `[start_time, end_time]` (inclusive).
    pub fn is_within_window(&self, time: u64) -> bool {
        time >= self.start_time && time <= self.end_time
    }

    /// Returns `true` when the event can still accept new participants.
    pub fn can_accept_participants(&self) -> bool {
        if !self.is_active || self.is_cancelled {
            return false;
        }
        // max_participants == 0 means unlimited
        self.max_participants == 0 || self.participant_count < self.max_participants
    }

    /// Close the event for new predictions without cancelling it.
    pub fn deactivate(&mut self) {
        self.is_active = false;
    }

    /// Cancel the event entirely.
    pub fn cancel(&mut self) {
        self.is_active = false;
        self.is_cancelled = true;
    }

    /// Register a new participant.  Returns `Err` if the event is full or inactive.
    pub fn add_participant(&mut self) -> Result<(), &'static str> {
        if self.is_cancelled {
            return Err("Event is cancelled");
        }
        if !self.is_active {
            return Err("Event is not active");
        }
        if self.max_participants > 0 && self.participant_count >= self.max_participants {
            return Err("Event has reached maximum participants");
        }
        self.participant_count += 1;
        Ok(())
    }

    /// Increment the match counter when a new match is added.
    pub fn add_match(&mut self) {
        self.match_count += 1;
    }

    /// Age of the event in seconds relative to `current_timestamp`.
    pub fn get_age_seconds(&self, current_timestamp: u64) -> u64 {
        current_timestamp.saturating_sub(self.created_at)
    }

    /// Validate title and description lengths.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.title.is_empty() {
            return Err("Title cannot be empty");
        }
        if self.title.len() > MAX_TITLE_LEN {
            return Err("Title exceeds maximum length");
        }
        if self.description.len() > MAX_DESCRIPTION_LEN {
            return Err("Description exceeds maximum length");
        }
        Ok(())
    }

    /// Returns true when the title length is within the 200-character limit.
    pub fn is_valid_title(title: &String) -> bool {
        title.len() <= MAX_TITLE_LEN
    }

    /// Returns true when the description length is within the 1000-character limit.
    pub fn is_valid_description(description: &String) -> bool {
        description.len() <= MAX_DESCRIPTION_LEN
    }
}

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------

/// A single prediction match within an event.
///
/// Stored under `DataKey::Match(match_id)`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Match {
    /// Unique identifier (global, assigned via MatchCounter)
    pub match_id: u64,

    /// ID of the parent event
    pub event_id: u64,

    /// Name of the first team / option (max `MAX_TEAM_NAME_LEN` chars)
    pub team_a: String,

    /// Name of the second team / option (max `MAX_TEAM_NAME_LEN` chars)
    pub team_b: String,

    /// Scheduled start time (Unix timestamp in seconds)
    pub match_time: u64,

    /// Whether a result has been submitted
    pub result_submitted: bool,

    /// The winning outcome; `None` until a result is submitted.
    /// Stored as `Option<u32>` (0=TeamA, 1=TeamB, 2=Draw) because Soroban's
    /// `#[contracttype]` does not support `Option<EnumType>` directly.
    /// Derived from home_score and away_score.
    pub winning_team: Option<u32>,

    /// Address of the oracle / admin that submitted the result
    pub submitted_by: Option<Address>,

    /// Unix timestamp when the result was submitted
    pub submitted_at: Option<u64>,

    /// Final score for team A (home team)
    pub home_score: Option<u32>,

    /// Final score for team B (away team)
    pub away_score: Option<u32>,

    /// Points multiplier for this match (1 = normal, 2 = double, 3 = triple).
    /// Must be in the range 1..=MAX_POINTS_MULTIPLIER. Grading multiplies the
    /// base points by this value so a 2× final can award 0 / 2 / 8 points.
    pub points_multiplier: u32,
}

impl Match {
    /// Create a new pending match.
    pub fn new(
        match_id: u64,
        event_id: u64,
        team_a: String,
        team_b: String,
        match_time: u64,
        points_multiplier: u32,
    ) -> Self {
        Self {
            match_id,
            event_id,
            team_a,
            team_b,
            match_time,
            result_submitted: false,
            winning_team: None,
            submitted_by: None,
            submitted_at: None,
            home_score: None,
            away_score: None,
            points_multiplier,
        }
    }

    // -----------------------------------------------------------------------
    // Result management
    // -----------------------------------------------------------------------

    /// Submit a result for this match.
    ///
    /// # Errors
    /// Returns `Err` if a result has already been submitted.
    pub fn submit_result(
        &mut self,
        result: MatchResult,
        submitted_by: Address,
        timestamp: u64,
    ) -> Result<(), &'static str> {
        if self.result_submitted {
            return Err("Result already submitted for this match");
        }
        self.winning_team = Some(result.to_u32());
        self.submitted_by = Some(submitted_by);
        self.submitted_at = Some(timestamp);
        self.result_submitted = true;
        Ok(())
    }

    /// Return the winning `MatchResult`, or `None` if not yet submitted.
    pub fn get_winner(&self) -> Option<MatchResult> {
        self.winning_team.and_then(MatchResult::from_u32)
    }

    /// `true` once a result has been recorded.
    pub fn is_completed(&self) -> bool {
        self.result_submitted
    }

    // -----------------------------------------------------------------------
    // Timing helpers
    // -----------------------------------------------------------------------

    /// `true` if `current_time >= match_time`.
    pub fn has_started(&self, current_time: u64) -> bool {
        current_time >= self.match_time
    }

    /// `true` if the match has started but no result has been submitted yet.
    pub fn is_ready_for_result(&self, current_time: u64) -> bool {
        self.has_started(current_time) && !self.result_submitted
    }

    /// Seconds until the match starts; 0 if already started.
    pub fn time_until_start(&self, current_time: u64) -> u64 {
        self.match_time.saturating_sub(current_time)
    }

    /// Seconds since the result was submitted; 0 if no result yet.
    pub fn time_since_result(&self, current_time: u64) -> u64 {
        match self.submitted_at {
            Some(t) => current_time.saturating_sub(t),
            None => 0,
        }
    }

    // -----------------------------------------------------------------------
    // Prediction window
    // -----------------------------------------------------------------------

    /// `true` if predictions are still open.
    ///
    /// Predictions close `prediction_cutoff_minutes` before `match_time` and
    /// are always closed once a result has been submitted.
    pub fn allows_predictions(&self, current_time: u64, prediction_cutoff_minutes: u64) -> bool {
        let cutoff = self
            .match_time
            .saturating_sub(prediction_cutoff_minutes * 60);
        current_time < cutoff && !self.result_submitted
    }

    // -----------------------------------------------------------------------
    // Validation
    // -----------------------------------------------------------------------

    /// Validate team names and internal state consistency.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.team_a.is_empty() {
            return Err("Team A name cannot be empty");
        }
        if self.team_a.len() > MAX_TEAM_NAME_LEN {
            return Err("Team A name exceeds maximum length");
        }
        if self.team_b.is_empty() {
            return Err("Team B name cannot be empty");
        }
        if self.team_b.len() > MAX_TEAM_NAME_LEN {
            return Err("Team B name exceeds maximum length");
        }
        if self.team_a == self.team_b {
            return Err("Team names must be different");
        }

        // Result consistency
        if self.result_submitted {
            if self.winning_team.is_none() {
                return Err("Result submitted but winning_team is None");
            }
            if self.submitted_by.is_none() {
                return Err("Result submitted but submitted_by is None");
            }
            if self.submitted_at.is_none() {
                return Err("Result submitted but submitted_at is None");
            }
            if let Some(v) = self.winning_team {
                if v > 2 {
                    return Err("winning_team value must be 0 (TeamA), 1 (TeamB), or 2 (Draw)");
                }
            }
        } else {
            if self.winning_team.is_some() {
                return Err("winning_team set but result_submitted is false");
            }
            if self.submitted_at.is_some() {
                return Err("submitted_at set but result_submitted is false");
            }
        }

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

/// A user's prediction for a single match inside an event.
///
/// Stored under `DataKey::Prediction(prediction_id)`.
///
/// The `predicted_outcome` field uses a `Symbol` with one of three values:
/// `"TEAM_A"`, `"TEAM_B"`, or `"DRAW"` (see `OUTCOME_*` constants).
/// It is now derived from `predicted_home_score` and `predicted_away_score` at submission
/// time for backward compatibility.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Prediction {
    /// Global unique identifier assigned via PredictionCounter
    pub prediction_id: u64,

    /// Match this prediction is for
    pub match_id: u64,

    /// Parent event identifier
    pub event_id: u64,

    /// Address of the user who placed this prediction
    pub predictor: Address,

    /// Predicted outcome: Symbol of "TEAM_A", "TEAM_B", or "DRAW" (derived, kept for backward compatibility)
    pub predicted_outcome: Symbol,

    /// Predicted score for team A (home team)
    pub predicted_home_score: u32,

    /// Predicted score for team B (away team)
    pub predicted_away_score: u32,

    /// Unix timestamp when the prediction was submitted
    pub predicted_at: u64,

    /// `Some(true)` = correct 1X2 result, `Some(false)` = wrong result, `None` = not yet graded
    /// This tracks whether the result (1X2) was correct, separate from exact score.
    pub is_correct: Option<bool>,

    /// Points earned: `None` until graded, then `Some(0|1|4)` based on accuracy
    /// - 0 = wrong result
    /// - 1 = correct result, wrong score
    /// - 4 = exact score (includes result point)
    pub points_earned: Option<u32>,
}

impl Prediction {
    /// Create a new ungraded prediction from a scoreline.
    pub fn new(
        prediction_id: u64,
        match_id: u64,
        event_id: u64,
        predictor: Address,
        predicted_home_score: u32,
        predicted_away_score: u32,
        predicted_at: u64,
        env: &soroban_sdk::Env,
    ) -> Self {
        let predicted_outcome =
            MatchResult::from_scores(predicted_home_score, predicted_away_score).to_u8();
        let outcome_symbol = match predicted_outcome {
            0 => Symbol::new(env, OUTCOME_TEAM_A),
            1 => Symbol::new(env, OUTCOME_TEAM_B),
            _ => Symbol::new(env, OUTCOME_DRAW),
        };

        Self {
            prediction_id,
            match_id,
            event_id,
            predictor,
            predicted_outcome: outcome_symbol,
            predicted_home_score,
            predicted_away_score,
            predicted_at,
            is_correct: None,
            points_earned: None,
        }
    }

    /// Validate that `predicted_outcome` is one of the three legal symbols.
    ///
    /// Valid values: `"TEAM_A"`, `"TEAM_B"`, `"DRAW"`.
    pub fn validate_outcome(env: &soroban_sdk::Env, outcome: &Symbol) -> Result<(), &'static str> {
        let team_a = Symbol::new(env, OUTCOME_TEAM_A);
        let team_b = Symbol::new(env, OUTCOME_TEAM_B);
        let draw = Symbol::new(env, OUTCOME_DRAW);

        if *outcome == team_a || *outcome == team_b || *outcome == draw {
            Ok(())
        } else {
            Err("predicted_outcome must be TEAM_A, TEAM_B, or DRAW")
        }
    }

    /// Grade this prediction against the actual match result.
    ///
    /// Awards base points multiplied by `points_multiplier`:
    /// - 0 points if result is wrong
    /// - 1 × multiplier if result is correct but score is wrong
    /// - 4 × multiplier if score is exactly correct (1 for result + 3 for exact score)
    pub fn grade(&mut self, actual_home: u32, actual_away: u32, points_multiplier: u32) {
        let actual_result = MatchResult::from_scores(actual_home, actual_away);
        let predicted_result =
            MatchResult::from_scores(self.predicted_home_score, self.predicted_away_score);

        let result_correct = predicted_result == actual_result;
        let exact_correct =
            self.predicted_home_score == actual_home && self.predicted_away_score == actual_away;

        self.is_correct = Some(result_correct);
        let base_points = if exact_correct {
            POINTS_CORRECT_RESULT + POINTS_EXACT_SCORE
        } else if result_correct {
            POINTS_CORRECT_RESULT
        } else {
            0
        };
        self.points_earned = Some(base_points * points_multiplier);
    }

    /// `true` if the prediction has been graded and was correct.
    pub fn is_winner(&self) -> bool {
        self.is_correct == Some(true)
    }

    /// Returns `true` if `predicted_at` is strictly before `match_time`.
    ///
    /// Used to verify the prediction was placed before the match started.
    pub fn is_before_match_time(&self, match_time: u64) -> bool {
        self.predicted_at < match_time
    }
}

// ---------------------------------------------------------------------------
// LeaderboardEntry
// ---------------------------------------------------------------------------

/// Ranked leaderboard entry for an event participant.
///
/// Represents a user's performance in an event with full ranking information
/// and deterministic tie-breaking. This replaces the binary Winner model to
/// support top-N prize splits and flexible reward distributions.
///
/// Stored in Vec<LeaderboardEntry> (typically temporary, computed on-demand).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LeaderboardEntry {
    /// Address of the participant
    pub user: Address,

    /// Event identifier
    pub event_id: u64,

    /// Total points earned from all predictions (0, 1, or 4 per match)
    pub total_points: u32,

    /// Number of predictions with correct 1X2 result
    pub correct_results: u32,

    /// Number of predictions with exact scoreline (4-point predictions)
    pub exact_scores: u32,

    /// Total number of predictions this user submitted for the event
    pub matches_played: u32,

    /// Unix timestamp of this user's most recent prediction
    /// (used as tiebreaker — earlier submission = higher rank)
    pub last_prediction_time: u64,

    /// 1-based rank after sorting (1 is the top-ranked participant).
    /// Set by `get_event_leaderboard` after sorting all entries.
    pub rank: u32,
}

impl LeaderboardEntry {
    /// Construct a new leaderboard entry (rank will be assigned later).
    pub fn new(
        user: Address,
        event_id: u64,
        total_points: u32,
        correct_results: u32,
        exact_scores: u32,
        matches_played: u32,
        last_prediction_time: u64,
    ) -> Self {
        Self {
            user,
            event_id,
            total_points,
            correct_results,
            exact_scores,
            matches_played,
            last_prediction_time,
            rank: 0, // Will be assigned during leaderboard finalization
        }
    }

    /// Returns `true` if this entry outranks `other` according to the tiebreaker rules.
    ///
    /// Sort order (all descending except last_prediction_time):
    /// 1. Higher `total_points` wins
    /// 2. On tie: Higher `exact_scores` wins
    /// 3. On tie: Earlier `last_prediction_time` wins (lower timestamp = better rank)
    /// 4. On tie: Compare addresses (deterministic final tiebreaker)
    pub fn outranks(&self, other: &LeaderboardEntry) -> bool {
        // Primary: higher total_points
        if self.total_points != other.total_points {
            return self.total_points > other.total_points;
        }

        // Secondary: higher exact_scores
        if self.exact_scores != other.exact_scores {
            return self.exact_scores > other.exact_scores;
        }

        // Tertiary: earlier last_prediction_time (lower = better)
        if self.last_prediction_time != other.last_prediction_time {
            return self.last_prediction_time < other.last_prediction_time;
        }

        // Final tiebreaker: address comparison (deterministic)
        // Compare the addresses directly; Soroban Address implements Ord
        self.user < other.user
    }
}
