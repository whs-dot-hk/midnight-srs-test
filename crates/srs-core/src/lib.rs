//! The off-chain half of a social spaced-repetition system on Midnight.
//!
//! # Why this is a Rust crate
//!
//! The Midnight SDK is TypeScript-only, so every call that touches a wallet, a provider, or a
//! proof server lives in `ts/`. What does *not* need the SDK is the part where correctness
//! actually matters: the SM-2 arithmetic, and knowing whether a proposed schedule will
//! survive the circuit's checks. That is all pure integer logic over explicit widths, which
//! is what this crate owns.
//!
//! The boundary falls in a convenient place. The contract treats the client's proposal as
//! untrusted and re-derives it, so the client never has to be *trusted* — but a client that
//! proposes something the circuit rejects has wasted a proof, and proofs are slow. This crate
//! therefore ships [`verify`], a port of the on-chain checks, and the property tests assert
//! the relationship that matters:
//!
//! > every schedule [`sched::Sched::advance`] produces passes [`verify::verify_review`].
//!
//! # Division of labour with the contract
//!
//! | Concern | Where | Why |
//! |---|---|---|
//! | SM-2 ease / reps / lapse transitions | both | client computes, circuit re-derives and rejects mismatches |
//! | `floor(interval * ease / 1000)` | here | Compact has no division; the circuit checks it multiplicatively |
//! | picking the next due date | here | block time is comparable but not readable, so there is no `now()` on-chain |
//! | pinning that due date to a legal window | contract | two block-time predicates bracket it |
//! | card content addressing | here | the circuit only tests set membership on opaque bytes |
//! | proving the card was due | contract | `blockTimeGte(due_at)` — the whole point |
//! | whether the learner actually recalled it | nowhere | unknowable; see [`sched::Grade`] |
//!
//! # Example
//!
//! ```
//! use srs_core::params::DEFAULT_SKEW_MARGIN_SECS;
//! use srs_core::sched::{Grade, Sched};
//! use srs_core::verify::verify_review;
//!
//! let now = 1_800_000_000;
//! let card = Sched::start(now);
//! let next = card.advance(Grade::GOOD, now, DEFAULT_SKEW_MARGIN_SECS);
//!
//! // The chain will accept this, so the proof will not be wasted.
//! assert!(verify_review(&card, Grade::GOOD, &next, now).is_ok());
//! ```

pub mod deck;
pub mod params;
pub mod sched;
pub mod verify;
