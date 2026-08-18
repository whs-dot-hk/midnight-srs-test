//! SM-2 parameters, mirroring `contracts/src/srs.compact` exactly.
//!
//! Every constant here has a counterpart `pure circuit` of the same name in the contract.
//! They must not drift: the contract re-derives each schedule transition and rejects the
//! transaction if the client's proposal disagrees. [`crate::verify`] is a faithful port of
//! those checks, and the property tests in `tests/invariants.rs` assert that every schedule
//! this crate produces passes them.

/// Ease is stored scaled by this factor to keep all arithmetic integral (`2500` == 2.5).
///
/// The contract has no division operator, so it verifies interval growth multiplicatively
/// against this scale rather than computing it.
pub const EASE_SCALE: u32 = 1000;

/// Ease floor. SM-2 stops punishing a card below this or intervals collapse to nothing.
pub const EASE_MIN: u16 = 1300;

/// Ease ceiling. Not part of classical SM-2; it bounds the multiplicative growth so
/// `interval * ease` stays comfortably inside 64 bits in the circuit.
pub const EASE_MAX: u16 = 4000;

/// Ease for a freshly started card (2.5).
pub const EASE_START: u16 = 2500;

/// The lowest grade that still counts as a successful recall. Below this is a lapse.
pub const GRADE_PASS: u8 = 3;

/// The highest grade a learner may report.
pub const GRADE_MAX: u8 = 5;

/// First interval, in days. Fixed by SM-2 rather than derived from ease.
pub const INTERVAL_FIRST: u32 = 1;

/// Second interval, in days. Also fixed by SM-2.
pub const INTERVAL_SECOND: u32 = 6;

/// Interval ceiling, in days (100 years). Beyond this the schedule is meaningless and the
/// circuit's exact-floor check is relaxed to a lower bound only.
pub const INTERVAL_MAX_DAYS: u32 = 36500;

/// Seconds in a day. Intervals are stored in days and converted at the boundary.
pub const DAY_SECS: u64 = 86_400;

/// How long after `due_at` a learner becomes slashable (48h).
pub const GRACE_SECS: u64 = 172_800;

/// Unbonding delay (7 days) — long enough that a pending slash cannot be dodged by racing
/// a withdrawal.
pub const UNBOND_COOLDOWN_SECS: u64 = 604_800;

/// Default slack subtracted from a proposed due date, in seconds (1 hour).
///
/// The contract pins a proposed `due_at` into `(now, now + window]` where `now` is *block*
/// time, using two comparison predicates. A client whose clock runs ahead of chain time
/// would propose a `due_at` whose lower edge has not been reached yet, and
/// `blockTimeGte(due_at - window)` would reject the transaction. Subtracting this margin
/// moves the proposal off both edges of the window, so the transaction survives clock skew
/// in either direction and the proving delay before it is applied.
///
/// The cost is that each interval is short by this much — negligible against a one-day
/// minimum interval, and always in the safe direction (slightly early, never late).
pub const DEFAULT_SKEW_MARGIN_SECS: u64 = 3_600;
