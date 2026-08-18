//! The SM-2 scheduler.
//!
//! This is the half of the system the chain cannot compute for itself: floor division (the
//! contract has no `/`) and reading a clock (block time is comparable but not readable). The
//! contract re-derives everything else and rejects a proposal that disagrees, so this module
//! is untrusted input from the chain's point of view — and correspondingly, a bug here shows
//! up as a rejected transaction rather than a corrupted schedule.

use serde::{Deserialize, Serialize};

use crate::params::{
    DAY_SECS, EASE_MAX, EASE_MIN, EASE_SCALE, EASE_START, GRADE_MAX, GRADE_PASS, INTERVAL_FIRST,
    INTERVAL_MAX_DAYS, INTERVAL_SECOND,
};

/// A self-reported recall quality, `0..=5`.
///
/// Self-reported is the operative word: no on-chain rule can check whether a learner
/// actually remembered the card. The contract proves diligence — that the card was due and
/// the resulting schedule obeys SM-2 — never competence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
pub struct Grade(u8);

impl Grade {
    /// The lowest passing grade (a correct but effortful recall).
    pub const HARD: Self = Self(3);
    /// A correct recall after some hesitation.
    pub const GOOD: Self = Self(4);
    /// An immediate, confident recall.
    pub const EASY: Self = Self(5);

    /// Wrap a raw grade, rejecting anything the contract would refuse.
    ///
    /// # Errors
    /// Returns [`ScheduleError::GradeOutOfRange`] above [`GRADE_MAX`].
    pub fn new(raw: u8) -> Result<Self, ScheduleError> {
        if raw > GRADE_MAX {
            return Err(ScheduleError::GradeOutOfRange(raw));
        }
        Ok(Self(raw))
    }

    /// The raw grade.
    #[must_use]
    pub const fn get(self) -> u8 {
        self.0
    }

    /// Whether this grade resets the card's progress.
    #[must_use]
    pub const fn is_lapse(self) -> bool {
        self.0 < GRADE_PASS
    }
}

impl TryFrom<u8> for Grade {
    type Error = ScheduleError;
    fn try_from(raw: u8) -> Result<Self, Self::Error> {
        Self::new(raw)
    }
}

impl From<Grade> for u8 {
    fn from(g: Grade) -> Self {
        g.0
    }
}

/// Everything the contract stores about one learner's progress on one card.
///
/// Field names serialise to the camelCase the generated contract bindings expect, so the
/// JSON this crate emits drops straight into a `review` call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sched {
    /// When the card next comes up, in Unix seconds. Public on-chain.
    pub due_at: u64,
    /// Current interval in days.
    pub interval_days: u32,
    /// Ease factor scaled by [`EASE_SCALE`], always within `[EASE_MIN, EASE_MAX]`.
    pub ease: u16,
    /// Consecutive successful recalls. Resets to zero on a lapse.
    pub reps: u16,
    /// Lifetime lapse count. Only ever increases.
    pub lapses: u16,
}

impl Sched {
    /// A freshly started card, due at `due_at`.
    ///
    /// Mirrors the contract's `startCard`, which writes exactly these values.
    ///
    /// `due_at` may be the present moment: `startCard` bounds the proposal only from above
    /// (`pinNotBeyond`), so a new card is studiable immediately. That is deliberately unlike
    /// `review`, which needs a strictly future date and gets `pinToWindow`.
    #[must_use]
    pub const fn start(due_at: u64) -> Self {
        Self {
            due_at,
            interval_days: INTERVAL_FIRST,
            ease: EASE_START,
            reps: 0,
            lapses: 0,
        }
    }

    /// Apply a review and return the schedule to propose on-chain.
    ///
    /// `now` is the client's wall clock in Unix seconds; `margin` is the slack subtracted
    /// from the new due date so the proposal sits clear of both edges of the window the
    /// contract will pin it to (see [`crate::params::DEFAULT_SKEW_MARGIN_SECS`]).
    #[must_use]
    pub fn advance(&self, grade: Grade, now: u64, margin: u64) -> Self {
        let lapsed = grade.is_lapse();
        let ease = ease_after(self.ease, grade);
        let reps = if lapsed { 0 } else { self.reps.saturating_add(1) };
        let lapses = if lapsed {
            self.lapses.saturating_add(1)
        } else {
            self.lapses
        };

        // SM-2 fixes the first two intervals, then grows multiplicatively. Note the growth
        // uses the *new* ease, matching the contract's `checkIntervalGrowth(cur.intervalDays,
        // next.ease, next.intervalDays)`.
        let interval_days = if lapsed {
            INTERVAL_FIRST
        } else {
            match reps {
                1 => INTERVAL_FIRST,
                2 => INTERVAL_SECOND,
                _ => grow_interval(self.interval_days, ease),
            }
        };

        Self {
            due_at: propose_due_at(now, interval_days, margin),
            interval_days,
            ease,
            reps,
            lapses,
        }
    }
}

/// Place a due date inside the window `(now, now + interval * DAY_SECS]` that the contract
/// will enforce, keeping clear of both edges.
///
/// The margin is capped at half the window so the result is always strictly after `now`
/// even for a one-day interval with an over-large margin.
#[must_use]
pub fn propose_due_at(now: u64, interval_days: u32, margin: u64) -> u64 {
    let window = u64::from(interval_days) * DAY_SECS;
    let slack = margin.min(window / 2);
    now + window - slack
}

/// SM-2's ease adjustment.
///
/// A lapse subtracts a flat penalty; a pass applies the quality delta
/// `EF += 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)`, which at [`EASE_SCALE`] is exactly
/// `+100` / `0` / `-140` for grades 5 / 4 / 3. No rounding is involved, which is why the
/// contract can check the transition for equality rather than within a tolerance.
#[must_use]
pub fn ease_after(ease: u16, grade: Grade) -> u16 {
    match grade.get() {
        g if g < GRADE_PASS => ease_down(ease, 200),
        3 => ease_down(ease, 140),
        4 => clamp_ease(u32::from(ease)),
        _ => clamp_ease(u32::from(ease) + 100),
    }
}

/// Reduce ease by `penalty`, floored at [`EASE_MIN`].
///
/// Guarded rather than saturating so it matches the contract, where unsigned subtraction
/// would underflow for an ease at or below the penalty.
#[must_use]
pub fn ease_down(ease: u16, penalty: u16) -> u16 {
    if ease <= penalty {
        EASE_MIN
    } else {
        clamp_ease(u32::from(ease - penalty))
    }
}

/// Clamp a raw ease into `[EASE_MIN, EASE_MAX]`.
#[must_use]
pub fn clamp_ease(raw: u32) -> u16 {
    if raw < u32::from(EASE_MIN) {
        EASE_MIN
    } else if raw > u32::from(EASE_MAX) {
        EASE_MAX
    } else {
        raw as u16
    }
}

/// `floor(prev * ease / EASE_SCALE)`, capped at [`INTERVAL_MAX_DAYS`].
///
/// This is the one computation the contract delegates outright, because Compact has no
/// division. It verifies the result multiplicatively instead:
/// `want * SCALE <= prev * ease < (want + 1) * SCALE`.
#[must_use]
pub fn grow_interval(prev: u32, ease: u16) -> u32 {
    let product = u64::from(prev) * u64::from(ease);
    let grown = (product / u64::from(EASE_SCALE)) as u32;
    grown.clamp(INTERVAL_FIRST, INTERVAL_MAX_DAYS)
}

/// Why a schedule could not be produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScheduleError {
    /// A grade above [`GRADE_MAX`] was supplied.
    GradeOutOfRange(u8),
}

impl std::fmt::Display for ScheduleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GradeOutOfRange(g) => {
                write!(f, "grade {g} is above the maximum of {GRADE_MAX}")
            }
        }
    }
}

impl std::error::Error for ScheduleError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::verify;

    const NOW: u64 = 1_800_000_000;

    #[test]
    fn first_two_intervals_are_fixed() {
        let card = Sched::start(NOW);
        let after_one = card.advance(Grade::GOOD, NOW, 0);
        assert_eq!(after_one.reps, 1);
        assert_eq!(after_one.interval_days, INTERVAL_FIRST);

        let after_two = after_one.advance(Grade::GOOD, NOW, 0);
        assert_eq!(after_two.reps, 2);
        assert_eq!(after_two.interval_days, INTERVAL_SECOND);
    }

    #[test]
    fn third_interval_grows_by_ease() {
        let card = Sched {
            due_at: NOW,
            interval_days: INTERVAL_SECOND,
            ease: EASE_START,
            reps: 2,
            lapses: 0,
        };
        let next = card.advance(Grade::GOOD, NOW, 0);
        // Grade 4 leaves ease untouched: floor(6 * 2500 / 1000) == 15.
        assert_eq!(next.ease, EASE_START);
        assert_eq!(next.interval_days, 15);
    }

    #[test]
    fn ease_deltas_match_sm2() {
        assert_eq!(ease_after(EASE_START, Grade::EASY), EASE_START + 100);
        assert_eq!(ease_after(EASE_START, Grade::GOOD), EASE_START);
        assert_eq!(ease_after(EASE_START, Grade::HARD), EASE_START - 140);
    }

    #[test]
    fn ease_never_leaves_its_bounds() {
        assert_eq!(ease_after(EASE_MIN, Grade::HARD), EASE_MIN);
        assert_eq!(ease_after(EASE_MAX, Grade::EASY), EASE_MAX);
        assert_eq!(ease_down(100, 200), EASE_MIN);
    }

    #[test]
    fn a_lapse_resets_progress_but_not_history() {
        let card = Sched {
            due_at: NOW,
            interval_days: 90,
            ease: EASE_START,
            reps: 7,
            lapses: 1,
        };
        let next = card.advance(Grade::new(1).unwrap(), NOW, 0);
        assert_eq!(next.reps, 0);
        assert_eq!(next.interval_days, INTERVAL_FIRST);
        assert_eq!(next.lapses, 2);
        assert_eq!(next.ease, EASE_START - 200);
    }

    #[test]
    fn margin_never_pushes_due_date_to_or_before_now() {
        // An absurd margin against the shortest possible window.
        let due = propose_due_at(NOW, 1, u64::MAX / 4);
        assert!(due > NOW, "due date must be strictly in the future");
        assert!(due <= NOW + DAY_SECS);
    }

    #[test]
    fn a_new_card_is_due_immediately() {
        // `startCard` bounds the proposal only from above, so "now" is a legal first due date
        // and a new card needs no waiting period.
        let card = Sched::start(NOW);
        assert_eq!(card.due_at, NOW);
        assert_eq!(verify::pin_not_beyond(card.due_at, DAY_SECS, NOW), Ok(()));
    }

    #[test]
    fn grades_above_the_maximum_are_rejected() {
        assert_eq!(Grade::new(6), Err(ScheduleError::GradeOutOfRange(6)));
        assert!(Grade::new(5).is_ok());
    }
}
