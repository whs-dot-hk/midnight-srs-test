//! A faithful port of the contract's `review` checks.
//!
//! This module computes nothing. It exists so the client can answer "would the chain accept
//! this?" without paying for a proof, and so the property tests in `tests/invariants.rs` can
//! assert the stronger claim: that [`crate::sched::Sched::advance`] *never* produces a
//! schedule the contract would reject.
//!
//! Each [`Rejection`] carries the contract's own assertion message verbatim, so a failure
//! here names the exact `assert` that would have fired on-chain.

use crate::params::{
    DAY_SECS, EASE_SCALE, GRADE_MAX, INTERVAL_FIRST, INTERVAL_MAX_DAYS,
    INTERVAL_SECOND,
};
use crate::sched::{Grade, Sched, ease_after};

/// A check the contract would have failed, carrying its assertion message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    /// `grade > GRADE_MAX`.
    GradeOutOfRange,
    /// The proposed ease is not the one SM-2 derives.
    IllegalEase,
    /// The proposed repetition count is not the one SM-2 derives.
    IllegalReps,
    /// The proposed lapse count is not the one SM-2 derives.
    IllegalLapses,
    /// Interval below [`INTERVAL_FIRST`].
    IntervalBelowMinimum,
    /// Interval above [`INTERVAL_MAX_DAYS`].
    IntervalAboveMaximum,
    /// A lapse must send the interval back to [`INTERVAL_FIRST`].
    LapseMustResetInterval,
    /// The first interval is fixed at [`INTERVAL_FIRST`].
    FirstIntervalWrong,
    /// The second interval is fixed at [`INTERVAL_SECOND`].
    SecondIntervalWrong,
    /// `interval' * SCALE > interval * ease'` — grew faster than the floor allows.
    IntervalGrewTooFast,
    /// `interval * ease' >= (interval' + 1) * SCALE` — grew slower than the floor requires.
    IntervalGrewTooSlow,
    /// The proposed timestamp is not strictly after block time.
    TimestampNotInFuture,
    /// The proposed timestamp is smaller than the window, so `t - window` would underflow.
    TimestampPrecedesWindow,
    /// The proposed timestamp is beyond `now + window`.
    TimestampTooFarOut,
    /// The card's `due_at` has not been reached.
    CardNotDue,
    /// The proposed timestamp is smaller than the delay, so `t - delay` would underflow.
    TimestampPrecedesDelay,
    /// The proposed timestamp is not at least `delay` in the future.
    TimestampTooSoon,
}

impl Rejection {
    /// The contract's assertion message for this check.
    #[must_use]
    pub const fn message(self) -> &'static str {
        match self {
            Self::GradeOutOfRange => "Grade out of range",
            Self::IllegalEase => "Illegal ease transition",
            Self::IllegalReps => "Illegal repetition count",
            Self::IllegalLapses => "Illegal lapse count",
            Self::IntervalBelowMinimum => "Interval must be at least one day",
            Self::IntervalAboveMaximum => "Interval exceeds maximum",
            Self::LapseMustResetInterval => "A lapse must reset the interval",
            Self::FirstIntervalWrong => "First interval must be one day",
            Self::SecondIntervalWrong => "Second interval must be six days",
            Self::IntervalGrewTooFast => "Interval grew faster than ease allows",
            Self::IntervalGrewTooSlow => "Interval grew slower than ease requires",
            Self::TimestampNotInFuture => "Timestamp must be in the future",
            Self::TimestampPrecedesWindow => "Timestamp precedes the window",
            Self::TimestampTooFarOut => "Timestamp is too far in the future",
            Self::CardNotDue => "Card is not due yet",
            Self::TimestampPrecedesDelay => "Timestamp precedes the delay",
            Self::TimestampTooSoon => "Timestamp must be at least the delay in the future",
        }
    }
}

impl std::fmt::Display for Rejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for Rejection {}

/// Run every check the contract's `review` runs, in the same order.
///
/// `now` stands in for block time. On-chain the two differ — the client's clock is not the
/// chain's — which is exactly what the skew margin in
/// [`crate::params::DEFAULT_SKEW_MARGIN_SECS`] absorbs.
///
/// # Errors
/// The first check that fails, as the contract would report it.
pub fn verify_review(cur: &Sched, grade: Grade, next: &Sched, now: u64) -> Result<(), Rejection> {
    if now < cur.due_at {
        return Err(Rejection::CardNotDue);
    }
    if grade.get() > GRADE_MAX {
        return Err(Rejection::GradeOutOfRange);
    }
    check_transition(cur, grade, next)?;
    let window = u64::from(next.interval_days) * DAY_SECS;
    pin_to_window(next.due_at, window, now)
}

/// Mirror of the contract's `checkTransition`.
///
/// # Errors
/// The first field whose proposed value is not the one SM-2 derives.
pub fn check_transition(cur: &Sched, grade: Grade, next: &Sched) -> Result<(), Rejection> {
    let lapsed = grade.is_lapse();

    if next.ease != ease_after(cur.ease, grade) {
        return Err(Rejection::IllegalEase);
    }

    let want_reps = if lapsed { 0 } else { cur.reps.saturating_add(1) };
    if next.reps != want_reps {
        return Err(Rejection::IllegalReps);
    }

    let want_lapses = if lapsed {
        cur.lapses.saturating_add(1)
    } else {
        cur.lapses
    };
    if next.lapses != want_lapses {
        return Err(Rejection::IllegalLapses);
    }

    if next.interval_days < INTERVAL_FIRST {
        return Err(Rejection::IntervalBelowMinimum);
    }
    if next.interval_days > INTERVAL_MAX_DAYS {
        return Err(Rejection::IntervalAboveMaximum);
    }

    if lapsed {
        if next.interval_days != INTERVAL_FIRST {
            return Err(Rejection::LapseMustResetInterval);
        }
    } else if want_reps == 1 {
        if next.interval_days != INTERVAL_FIRST {
            return Err(Rejection::FirstIntervalWrong);
        }
    } else if want_reps == 2 {
        if next.interval_days != INTERVAL_SECOND {
            return Err(Rejection::SecondIntervalWrong);
        }
    } else {
        check_interval_growth(cur.interval_days, next.ease, next.interval_days)?;
    }

    Ok(())
}

/// Mirror of the contract's `checkIntervalGrowth`: verify `want == floor(prev * ease / SCALE)`
/// using only multiplication.
///
/// # Errors
/// [`Rejection::IntervalGrewTooFast`] or [`Rejection::IntervalGrewTooSlow`].
pub fn check_interval_growth(prev: u32, ease: u16, want: u32) -> Result<(), Rejection> {
    let product = u64::from(prev) * u64::from(ease);
    let scale = u64::from(EASE_SCALE);
    let lo = u64::from(want) * scale;

    if lo > product {
        return Err(Rejection::IntervalGrewTooFast);
    }
    // At the cap the true product exceeds the ceiling and flooring no longer applies, so the
    // contract checks only the lower bound there.
    if want < INTERVAL_MAX_DAYS && product >= lo + scale {
        return Err(Rejection::IntervalGrewTooSlow);
    }
    Ok(())
}

/// Mirror of the contract's `pinToWindow`: constrain `t` to `(now, now + window]`.
///
/// The contract achieves this with two block-time predicates rather than by reading the clock,
/// because Compact exposes block time only as a comparison.
///
/// # Errors
/// Whichever of the assertions fails first.
pub fn pin_to_window(t: u64, window: u64, now: u64) -> Result<(), Rejection> {
    if now >= t {
        return Err(Rejection::TimestampNotInFuture);
    }
    pin_not_beyond(t, window, now)
}

/// Mirror of the contract's `pinNotBeyond`: constrain `t` to `t <= now + window`, with no
/// lower bound.
///
/// Used where "already due" is a legitimate answer — a newly started card, which should be
/// studiable immediately.
///
/// # Errors
/// [`Rejection::TimestampPrecedesWindow`] or [`Rejection::TimestampTooFarOut`].
pub fn pin_not_beyond(t: u64, window: u64, now: u64) -> Result<(), Rejection> {
    if t < window {
        return Err(Rejection::TimestampPrecedesWindow);
    }
    if now < t - window {
        return Err(Rejection::TimestampTooFarOut);
    }
    Ok(())
}

/// Mirror of the contract's `pinAtLeast`: constrain `t` to `t > now + delay`.
///
/// The opposite direction to [`pin_to_window`]'s upper bound, and the one a cooldown needs. A
/// caller must not be able to name a `t` a second away and skip the wait.
///
/// # Errors
/// [`Rejection::TimestampPrecedesDelay`] or [`Rejection::TimestampTooSoon`].
pub fn pin_at_least(t: u64, delay: u64, now: u64) -> Result<(), Rejection> {
    if t < delay {
        return Err(Rejection::TimestampPrecedesDelay);
    }
    if now >= t - delay {
        return Err(Rejection::TimestampTooSoon);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::params::{DEFAULT_SKEW_MARGIN_SECS, EASE_START};

    const NOW: u64 = 1_800_000_000;

    #[test]
    fn an_honest_review_verifies() {
        let cur = Sched::start(NOW);
        let next = cur.advance(Grade::GOOD, NOW, DEFAULT_SKEW_MARGIN_SECS);
        assert_eq!(verify_review(&cur, Grade::GOOD, &next, NOW), Ok(()));
    }

    #[test]
    fn reviewing_early_is_rejected() {
        let cur = Sched::start(NOW + 1000);
        let next = cur.advance(Grade::GOOD, NOW, DEFAULT_SKEW_MARGIN_SECS);
        assert_eq!(
            verify_review(&cur, Grade::GOOD, &next, NOW),
            Err(Rejection::CardNotDue)
        );
    }

    #[test]
    fn inflating_the_interval_is_rejected() {
        let cur = Sched {
            due_at: NOW,
            interval_days: INTERVAL_SECOND,
            ease: EASE_START,
            reps: 2,
            lapses: 0,
        };
        let mut next = cur.advance(Grade::GOOD, NOW, DEFAULT_SKEW_MARGIN_SECS);
        assert_eq!(next.interval_days, 15);
        next.interval_days = 400; // "this card is easy, see you in a year"
        assert_eq!(
            check_transition(&cur, Grade::GOOD, &next),
            Err(Rejection::IntervalGrewTooFast)
        );
    }

    #[test]
    fn hiding_a_lapse_is_rejected() {
        let cur = Sched::start(NOW);
        let mut next = cur.advance(Grade::new(0).unwrap(), NOW, DEFAULT_SKEW_MARGIN_SECS);
        next.lapses = 0; // keep the streak clean
        assert_eq!(
            check_transition(&cur, Grade::new(0).unwrap(), &next),
            Err(Rejection::IllegalLapses)
        );
    }

    #[test]
    fn parking_a_card_in_the_far_future_is_rejected() {
        let cur = Sched::start(NOW);
        let mut next = cur.advance(Grade::GOOD, NOW, DEFAULT_SKEW_MARGIN_SECS);
        next.due_at = NOW + 100 * DAY_SECS;
        assert_eq!(
            verify_review(&cur, Grade::GOOD, &next, NOW),
            Err(Rejection::TimestampTooFarOut)
        );
    }

    #[test]
    fn the_window_is_inclusive_at_its_upper_edge() {
        // A zero-margin proposal sits exactly on `now + window`, which the contract allows.
        let cur = Sched::start(NOW);
        let next = cur.advance(Grade::GOOD, NOW, 0);
        assert_eq!(next.due_at, NOW + DAY_SECS);
        assert_eq!(verify_review(&cur, Grade::GOOD, &next, NOW), Ok(()));
    }

    #[test]
    fn a_new_card_may_be_due_immediately() {
        // `pinNotBeyond` has no lower bound, which is what lets startCard accept "now".
        assert_eq!(pin_not_beyond(NOW, DAY_SECS, NOW), Ok(()));
        // ...but parking it a week out is still refused.
        assert_eq!(
            pin_not_beyond(NOW + 7 * DAY_SECS, DAY_SECS, NOW),
            Err(Rejection::TimestampTooFarOut)
        );
    }

    #[test]
    fn a_cooldown_cannot_be_skipped() {
        const COOLDOWN: u64 = 604_800;
        // The regression this guards: bounding a delay from *above* (as pinToWindow does) would
        // accept a readyAt one second out and make the unbonding delay — and therefore every
        // pending slash — trivially dodgeable.
        assert_eq!(
            pin_at_least(NOW + 1, COOLDOWN, NOW),
            Err(Rejection::TimestampTooSoon)
        );
        assert_eq!(
            pin_at_least(NOW + COOLDOWN, COOLDOWN, NOW),
            Err(Rejection::TimestampTooSoon),
            "the bound is strict: exactly one cooldown away is not yet past it"
        );
        assert_eq!(pin_at_least(NOW + COOLDOWN + 1, COOLDOWN, NOW), Ok(()));
    }

    #[test]
    fn floor_division_is_checked_exactly_not_loosely() {
        // floor(6 * 2500 / 1000) == 15, so neither 14 nor 16 may pass.
        assert_eq!(check_interval_growth(6, 2500, 15), Ok(()));
        assert_eq!(
            check_interval_growth(6, 2500, 14),
            Err(Rejection::IntervalGrewTooSlow)
        );
        assert_eq!(
            check_interval_growth(6, 2500, 16),
            Err(Rejection::IntervalGrewTooFast)
        );
    }
}
