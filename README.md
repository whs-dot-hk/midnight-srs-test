# midnight-srs-test

A social spaced-repetition system on Midnight. Shared decks, a staked bond, verifiable streaks,
and a private score you can prove without revealing.

The chain **verifies SM-2** rather than trusting the client: `review` re-derives the ease, the
repetition count, the lapse count and the interval, and rejects any proposal that deviates. So it
proves **diligence, not competence** — that a card was due and the schedule obeys the algorithm,
never that anyone actually remembered anything. The grade is self-reported and always will be.

Run end to end on preview: [docs/FLOW.md](docs/FLOW.md) has verbatim captures of every step,
including a three-learner leaderboard and a tier proved without revealing the score.

## Requirements

- Rust (2024 edition), Node 22, Yarn 1
- `compact` 0.5.1+ (compiler 0.31.1, language 0.23)
- Docker, for the proof server
- A funded, DUST-registered wallet on the target network

The wallet and provider wiring is part of this repo (`ts/src/`, five small modules written against
the published SDK types), so there is nothing to supply beyond a seed. The contract and the Rust
scheduler need no wallet at all; only the CLI does.

## Setup

```bash
yarn install
yarn setup     # compiles 9 ZK circuits, then builds Rust + TypeScript (several minutes)
yarn verify    # drift guard, Rust tests, tsc — none of it needs a chain
```

```bash
cp .env.preview.example .env.preview   # set MN_SEED to a funded 64-hex seed

docker run -d --name srs-proof-server -p 127.0.0.1:6300:6300 \
  midnightntwrk/proof-server:8.1.0

yarn doctor    # checks all five preconditions, prints the fix for any that fail
```

Only the proof server is local — the node RPC and indexer are the public Preview endpoints. It has
to be local, because proving hands the prover your pseudonym's secret, your XP total, and the salt
that would unmask the on-chain commitment.

## Studying

```bash
yarn srs deploy                       # deploys the bundled deck and remembers it
yarn srs subscribe                    # posts the bond and joins
yarn srs cards                        # the deck, with due state
yarn srs start  --card 1              # enrol card 1 — due immediately
yarn srs review --card 1 --grade 4    # 0-5; below 3 is a lapse
yarn srs due                          # what you can review now
yarn srs leaderboard                  # every learner, ranked on public diligence
yarn srs tier   --tier 1 --threshold 2   # prove xp >= 2 without revealing it
```

The deck address is remembered after `deploy`, so `--address` is rarely needed. Cards are
referenced by **index** (`3`), **front text** (`水`), or an **id prefix** (`7391bd`) — never a full
hash. `--as <name>` acts as another learner from the same wallet, which is how the leaderboard gets
more than one row. `yarn srs --help` lists everything.

Every command syncs the wallet first, so a read costs ~10s. A write adds proving and finalization:
~35-40s for `subscribe`, `start` or `tier`, and ~90s for `review`, which proves twice. See
[docs/FLOW.md](docs/FLOW.md) for the measured timing of every step.

## The scheduler on its own

The SM-2 arithmetic lives in a Rust crate (`crates/srs-core`) and runs with no chain involved:

```bash
./target/release/srs-plan deck < decks/kanji-basics.json
echo '{"cur":{"dueAt":1800000000,"intervalDays":6,"ease":2500,"reps":2,"lapses":0},
       "grade":4,"now":1800000000}' | ./target/release/srs-plan review
# -> {"next":{"intervalDays":15,...},"award":15}
```

It also ships `verify`, a port of the circuit's assertions, and the property tests assert the
relationship that matters: **every schedule the scheduler produces is one the circuit accepts.**
So a mis-scheduled card fails locally in microseconds instead of after a wasted proof.
