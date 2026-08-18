//! `srs-plan` — the scheduling half of the SRS, as a JSON filter.
//!
//! The TypeScript layer owns the Midnight SDK; this binary owns the arithmetic. They talk
//! over stdin/stdout in JSON rather than through a WASM boundary, because every call happens
//! once per human review and is dwarfed by the proving time that follows it.
//!
//! ```text
//! srs-plan deck    < deck.json     # content-address a deck's cards
//! srs-plan start   --now <unix>    # the schedule for a freshly started card (due now)
//! srs-plan review  < review.json   # advance a schedule, refusing to emit an invalid one
//! srs-plan verify  < verify.json   # would the chain accept this proposal?
//! ```
//!
//! Every subcommand exits non-zero with a message on stderr if the input is malformed or the
//! result would be rejected on-chain.

use std::io::{Read, Write};
use std::process::ExitCode;

use serde::{Deserialize, Serialize};
use srs_core::deck::{Card, CardId, Deck};
use srs_core::params::DEFAULT_SKEW_MARGIN_SECS;
use srs_core::sched::{Grade, Sched};
use srs_core::verify::verify_review;

fn main() -> ExitCode {
    match run() {
        Ok(json) => {
            let mut out = std::io::stdout().lock();
            // A trailing newline keeps the output pleasant to pipe into `jq`.
            if writeln!(out, "{json}").is_err() {
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("srs-plan: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<String, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(subcommand) = args.first() else {
        return Err(USAGE.to_string());
    };

    match subcommand.as_str() {
        "deck" => deck(),
        "start" => start(&args[1..]),
        "review" => review(),
        "verify" => verify(),
        "--help" | "-h" | "help" => Ok(USAGE.to_string()),
        other => Err(format!("unknown subcommand `{other}`\n\n{USAGE}")),
    }
}

const USAGE: &str = "\
usage: srs-plan <deck|start|review|verify> [options]

  deck                 stdin: {name, cards:[{front, back}]}
                       stdout: the same deck with each card's content address

  start --now <unix>   stdout: the schedule startCard will write — due immediately

  review               stdin: {cur, grade, now, margin?}
                       stdout: {next, award} — refuses to emit a schedule the chain
                       would reject

  verify               stdin: {cur, grade, next, now}
                       stdout: {ok: true} or exits non-zero naming the failed check";

// ---------------------------------------------------------------------------
// deck
// ---------------------------------------------------------------------------

/// A card paired with its content address, as published to the contract's `cards` set.
#[derive(Serialize)]
struct AddressedCard {
    id: CardId,
    front: String,
    back: String,
}

#[derive(Serialize)]
struct AddressedDeck {
    name: String,
    cards: Vec<AddressedCard>,
}

fn deck() -> Result<String, String> {
    let deck: Deck = read_stdin_json()?;
    let addressed = AddressedDeck {
        name: deck.name.clone(),
        cards: deck
            .cards
            .iter()
            .map(|c: &Card| AddressedCard {
                id: c.id(),
                front: c.front.clone(),
                back: c.back.clone(),
            })
            .collect(),
    };
    to_json(&addressed)
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

fn start(rest: &[String]) -> Result<String, String> {
    let mut now: Option<u64> = None;
    let mut i = 0;
    while i < rest.len() {
        let flag = rest[i].as_str();
        match flag {
            "--now" => {
                now = Some(
                    rest.get(i + 1)
                        .ok_or_else(|| "--now needs a Unix timestamp".to_string())?
                        .parse()
                        .map_err(|e| format!("--now is not a Unix timestamp: {e}"))?,
                );
            }
            other => return Err(format!("unexpected argument `{other}`\n\n{USAGE}")),
        }
        i += 2;
    }
    let now = now.ok_or_else(|| "start requires --now <unix>".to_string())?;
    // Due immediately: `startCard` bounds the proposal only from above, so there is no lead
    // time to guess and no risk of a slow proof overshooting it.
    to_json(&Sched::start(now))
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ReviewRequest {
    cur: Sched,
    grade: u8,
    now: u64,
    /// Slack subtracted from the proposed due date; defaults to
    /// [`DEFAULT_SKEW_MARGIN_SECS`].
    #[serde(default)]
    margin: Option<u64>,
}

#[derive(Serialize)]
struct ReviewResponse {
    next: Sched,
    /// XP the contract will mint for this review — the interval earned, in days.
    award: u32,
}

fn review() -> Result<String, String> {
    let req: ReviewRequest = read_stdin_json()?;
    let grade = Grade::new(req.grade).map_err(|e| e.to_string())?;
    let margin = req.margin.unwrap_or(DEFAULT_SKEW_MARGIN_SECS);

    let next = req.cur.advance(grade, req.now, margin);

    // Refuse to hand back a proposal the chain would reject. A wasted proof costs seconds of
    // wall clock and a transaction fee; this check costs nothing.
    verify_review(&req.cur, grade, &next, req.now)
        .map_err(|r| format!("refusing to propose a schedule the contract would reject: {r}"))?;

    to_json(&ReviewResponse {
        next,
        award: next.interval_days,
    })
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct VerifyRequest {
    cur: Sched,
    grade: u8,
    next: Sched,
    now: u64,
}

#[derive(Serialize)]
struct VerifyResponse {
    ok: bool,
}

fn verify() -> Result<String, String> {
    let req: VerifyRequest = read_stdin_json()?;
    let grade = Grade::new(req.grade).map_err(|e| e.to_string())?;
    verify_review(&req.cur, grade, &req.next, req.now).map_err(|r| r.to_string())?;
    to_json(&VerifyResponse { ok: true })
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

fn read_stdin_json<T: serde::de::DeserializeOwned>() -> Result<T, String> {
    let mut raw = String::new();
    std::io::stdin()
        .read_to_string(&mut raw)
        .map_err(|e| format!("could not read stdin: {e}"))?;
    if raw.trim().is_empty() {
        return Err("expected JSON on stdin".to_string());
    }
    serde_json::from_str(&raw).map_err(|e| format!("invalid JSON on stdin: {e}"))
}

fn to_json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|e| format!("could not serialise output: {e}"))
}
