//! The relationship that makes this crate trustworthy:
//!
//! > every schedule the client proposes is one the contract will accept.
//!
//! The contract treats the client as untrusted and re-derives each transition, so a bug in
//! the scheduler cannot corrupt on-chain state — it can only waste a proof. Proofs are slow
//! and cost a fee, so "cannot corrupt" is not good enough; these tests close the gap by
//! checking the scheduler against a port of the circuit's own assertions.
//!
//! The tampering tests matter just as much. A verifier that accepts everything would satisfy
//! the invariant above trivially, so we also confirm it rejects every single-field forgery a
//! learner might attempt.

use proptest::prelude::*;
use srs_core::params::{
    DEFAULT_SKEW_MARGIN_SECS, EASE_MAX, EASE_MIN, INTERVAL_FIRST, INTERVAL_MAX_DAYS,
};
use srs_core::sched::{Grade, Sched};
use srs_core::verify::{Rejection, verify_review};

/// A schedule the contract could actually hold.
///
/// The bounds are the contract's own invariants, not arbitrary choices: `startCard` writes
/// `ease = EASE_START` and `intervalDays = 1`, and `checkTransition` refuses any transition
/// that would leave `ease` outside `[EASE_MIN, EASE_MAX]` or `intervalDays` outside
/// `[1, INTERVAL_MAX_DAYS]`. An interval of zero is therefore unreachable on-chain.
fn reachable_sched() -> impl Strategy<Value = Sched> {
    (
        1_600_000_000u64..2_000_000_000u64,
        INTERVAL_FIRST..=INTERVAL_MAX_DAYS,
        EASE_MIN..=EASE_MAX,
        0u16..500,
        0u16..500,
    )
        .prop_map(|(due_at, interval_days, ease, reps, lapses)| Sched {
            due_at,
            interval_days,
            ease,
            reps,
            lapses,
        })
}

fn any_grade() -> impl Strategy<Value = Grade> {
    (0u8..=5).prop_map(|g| Grade::new(g).expect("0..=5 is in range"))
}

proptest! {
    /// The headline invariant.
    #[test]
    fn every_proposal_the_scheduler_makes_is_accepted(
        cur in reachable_sched(),
        grade in any_grade(),
        margin in 0u64..7200,
    ) {
        // Reviewing exactly when due is the tightest legitimate case.
        let now = cur.due_at;
        let next = cur.advance(grade, now, margin);
        prop_assert_eq!(verify_review(&cur, grade, &next, now), Ok(()));
    }

    /// Reviewing late is normal — a learner is not always punctual — and must still verify.
    #[test]
    fn reviewing_late_still_verifies(
        cur in reachable_sched(),
        grade in any_grade(),
        lateness in 0u64..86_400,
    ) {
        let now = cur.due_at + lateness;
        let next = cur.advance(grade, now, DEFAULT_SKEW_MARGIN_SECS);
        prop_assert_eq!(verify_review(&cur, grade, &next, now), Ok(()));
    }

    /// Ease is the one field with hard bounds in both directions; it must never escape them
    /// no matter how long the history.
    #[test]
    fn ease_stays_within_its_bounds(
        cur in reachable_sched(),
        grade in any_grade(),
    ) {
        let next = cur.advance(grade, cur.due_at, 0);
        prop_assert!(next.ease >= EASE_MIN, "ease {} below floor", next.ease);
        prop_assert!(next.ease <= EASE_MAX, "ease {} above ceiling", next.ease);
    }

    /// Intervals stay inside the range the circuit enforces.
    #[test]
    fn intervals_stay_within_their_bounds(
        cur in reachable_sched(),
        grade in any_grade(),
    ) {
        let next = cur.advance(grade, cur.due_at, 0);
        prop_assert!(next.interval_days >= INTERVAL_FIRST);
        prop_assert!(next.interval_days <= INTERVAL_MAX_DAYS);
    }

    /// History only accumulates: a lapse count never falls, and a pass never records one.
    #[test]
    fn lapse_history_is_append_only(
        cur in reachable_sched(),
        grade in any_grade(),
    ) {
        let next = cur.advance(grade, cur.due_at, 0);
        prop_assert!(next.lapses >= cur.lapses);
        if grade.is_lapse() {
            prop_assert_eq!(next.lapses, cur.lapses + 1);
            prop_assert_eq!(next.reps, 0);
            prop_assert_eq!(next.interval_days, INTERVAL_FIRST);
        } else {
            prop_assert_eq!(next.lapses, cur.lapses);
            prop_assert_eq!(next.reps, cur.reps + 1);
        }
    }

    /// A long history stays valid at every step. This is the closest thing to a simulation of
    /// real use: each review happens exactly when the previous one scheduled it.
    #[test]
    fn a_whole_review_history_verifies_step_by_step(
        grades in prop::collection::vec(any_grade(), 1..60),
        start_at in 1_600_000_000u64..1_700_000_000u64,
    ) {
        let mut cur = Sched::start(start_at);
        for grade in grades {
            let now = cur.due_at;
            let next = cur.advance(grade, now, DEFAULT_SKEW_MARGIN_SECS);
            prop_assert_eq!(
                verify_review(&cur, grade, &next, now),
                Ok(()),
                "step rejected: {:?} --{}--> {:?}",
                cur,
                grade.get(),
                next
            );
            cur = next;
        }
    }

    /// The verifier is not vacuous: inflating the interval is always caught.
    #[test]
    fn inflating_the_interval_is_always_caught(
        cur in reachable_sched(),
        grade in any_grade(),
        bump in 1u32..1000,
    ) {
        let mut forged = cur.advance(grade, cur.due_at, DEFAULT_SKEW_MARGIN_SECS);
        // Skip the case where the honest interval is already at the cap, where the circuit
        // deliberately relaxes to a lower bound and a bump would exceed the range check
        // instead — still a rejection, just a different one.
        prop_assume!(forged.interval_days + bump <= INTERVAL_MAX_DAYS);
        forged.interval_days += bump;

        prop_assert!(
            verify_review(&cur, grade, &forged, cur.due_at).is_err(),
            "an inflated interval was accepted: {forged:?}"
        );
    }

    /// Hiding a lapse is always caught.
    #[test]
    fn suppressing_a_lapse_is_always_caught(
        cur in reachable_sched(),
        grade in (0u8..3).prop_map(|g| Grade::new(g).unwrap()),
    ) {
        let mut forged = cur.advance(grade, cur.due_at, DEFAULT_SKEW_MARGIN_SECS);
        forged.lapses = cur.lapses;
        prop_assert_eq!(
            verify_review(&cur, grade, &forged, cur.due_at),
            Err(Rejection::IllegalLapses)
        );
    }

    /// Keeping a streak alive through a lapse is always caught.
    #[test]
    fn preserving_reps_through_a_lapse_is_always_caught(
        cur in reachable_sched(),
        grade in (0u8..3).prop_map(|g| Grade::new(g).unwrap()),
    ) {
        prop_assume!(cur.reps > 0);
        let mut forged = cur.advance(grade, cur.due_at, DEFAULT_SKEW_MARGIN_SECS);
        forged.reps = cur.reps;
        prop_assert!(verify_review(&cur, grade, &forged, cur.due_at).is_err());
    }

    /// Parking a card beyond its window is always caught — this is the check that stops a
    /// learner "reviewing" a card and then not seeing it again for a decade.
    #[test]
    fn parking_a_card_past_its_window_is_always_caught(
        cur in reachable_sched(),
        grade in any_grade(),
        overshoot in 1u64..1_000_000,
    ) {
        let honest = cur.advance(grade, cur.due_at, DEFAULT_SKEW_MARGIN_SECS);
        let window = u64::from(honest.interval_days) * 86_400;
        let forged = Sched {
            due_at: cur.due_at + window + overshoot,
            ..honest
        };
        prop_assert_eq!(
            verify_review(&cur, grade, &forged, cur.due_at),
            Err(Rejection::TimestampTooFarOut)
        );
    }

    /// Reviewing a card before it is due is always caught, however small the margin.
    #[test]
    fn reviewing_early_is_always_caught(
        cur in reachable_sched(),
        grade in any_grade(),
        earliness in 1u64..100_000,
    ) {
        let now = cur.due_at - earliness.min(cur.due_at);
        prop_assume!(now < cur.due_at);
        let next = cur.advance(grade, now, DEFAULT_SKEW_MARGIN_SECS);
        prop_assert_eq!(
            verify_review(&cur, grade, &next, now),
            Err(Rejection::CardNotDue)
        );
    }

    /// Forging the ease in either direction is always caught.
    #[test]
    fn tampering_with_ease_is_always_caught(
        cur in reachable_sched(),
        grade in any_grade(),
        delta in 1u16..500,
        up in any::<bool>(),
    ) {
        let honest = cur.advance(grade, cur.due_at, DEFAULT_SKEW_MARGIN_SECS);
        let forged_ease = if up {
            honest.ease.saturating_add(delta)
        } else {
            honest.ease.saturating_sub(delta)
        };
        prop_assume!(forged_ease != honest.ease);
        let forged = Sched { ease: forged_ease, ..honest };
        prop_assert!(verify_review(&cur, grade, &forged, cur.due_at).is_err());
    }
}

/// A worked example, checked by hand, so a future change to the constants has to confront a
/// concrete expectation rather than only the abstract properties above.
#[test]
fn a_hand_checked_history() {
    let start = 1_800_000_000;
    let mut card = Sched::start(start);
    assert_eq!(card.ease, 2500);
    assert_eq!(card.interval_days, 1);

    // Three confident recalls: intervals 1, 6, then 6 * 2.6 = 15.6 -> 15.
    card = card.advance(Grade::EASY, card.due_at, 0);
    assert_eq!((card.reps, card.interval_days, card.ease), (1, 1, 2600));

    card = card.advance(Grade::EASY, card.due_at, 0);
    assert_eq!((card.reps, card.interval_days, card.ease), (2, 6, 2700));

    card = card.advance(Grade::EASY, card.due_at, 0);
    assert_eq!((card.reps, card.interval_days, card.ease), (3, 16, 2800));

    // A blank. Progress resets, ease takes the flat penalty, history is kept.
    card = card.advance(Grade::new(0).unwrap(), card.due_at, 0);
    assert_eq!(
        (card.reps, card.interval_days, card.ease, card.lapses),
        (0, 1, 2600, 1)
    );
}
