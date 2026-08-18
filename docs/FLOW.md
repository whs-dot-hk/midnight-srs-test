# The complete flow, run on Midnight preview

Every block below is a verbatim terminal capture from a single run against the **preview** network
on 2026-08-18, in the order shown — not a mock-up and not reconstructed. Timings are wall clock and
include the wallet sync each command performs, plus proving where applicable. Every command in this
run exited 0.

Three learners take part, all backed by one wallet via `--as`. That works because identity here is
a dapp secret rather than a wallet key — and it is exactly the Sybil property the bond exists to
price, so demonstrating it openly is more honest than hiding it.

| | |
|---|---|
| Deck contract | `2d76aca0c44239ac79bc026a9633b5572587840484447b07237c19c74b0bd1f6` |
| XP token colour | `b33713e0e03e1d8d45c5f0d52fc2dec2ee03c25ffd41f2cc07d877a50c92cc86` |
| Learner A (`default`) | `a49654d67657db8acd6680c5e5aa387fe7afa600508468027af85112146f2281` |
| Learner B (`bob`) | `16f38180116e2509117097e50e7a3c7542e13bacff96dce37a4cb9e0441a7bbd` |
| Learner C (`carol`) | `808cc2059dd7e43b92e582bc305956810e0e1fdff1db3865a7ffad53a34e56c4` |

---

## Preconditions

Only the proof server runs locally — the node RPC and the indexer are the public Preview
endpoints. It is local by design, not omission: proving hands the prover the circuit's witness
data, which here is the preimage of your pseudonym, your XP total, and the commitment salt that
would make the on-chain commitment readable.

```bash
docker run -d --name srs-proof-server -p 127.0.0.1:6300:6300 \
  midnightntwrk/proof-server:8.1.0

cp .env.preview.example .env.preview   # then set MN_SEED
```

## Step 0 — the Rust core, with no chain in sight

Content-addressing a deck and computing a schedule need no wallet, no network, and no proof.

```console
$ ./target/release/srs-plan deck < decks/kanji-basics.json
{
  "name": "kanji-basics",
  "cards": [
    {
      "id": "7391bd647b9ceb1fe27cdcccc8116fedbeaf92d16aeb09f0bc0e6ed0e8c61216",
      "front": "水",
      "back": "water — mizu"
    },
    {
      "id": "870b1ae86b287367b496020a2bfeaa2f7fa6f09092dd7482d0ccb08d68076108",
      "front": "火",
      "back": "fire — hi"
    },
    {
      "id": "aa7153aba0f5c910b2c2cd892fa3b13b98b17c9979d5f99b61874121a5b15897",
      "front": "山",
      "back": "mountain — yama"
    },
    {
      "id": "984e4a8d715a94444dfa38a27244adbadc07856f304966c97798f5d0a0a8b30e",
      "front": "川",
      "back": "river — kawa"
    },
    {
      "id": "42b5c2e33b6cd8d5ab8b973bd1fc731a8a52977120f9dfb556aa9d22ae22b649",
      "front": "木",
      "back": "tree — ki"
    },
    {
      "id": "b20b0ce1f0e11800a6d647acca8873b5fdd97427f21ee4f35a7867990ccf28b8",
      "front": "日",
      "back": "sun, day — hi/nichi"
    },
    {
      "id": "ba9895d0f717592781f142cc5e11429adb3a9e9eb9f899dfcf9e83b3f97bf4ae",
      "front": "月",
      "back": "moon, month — tsuki/getsu"
    },
    {
      "id": "41f9b10cb9da02912da2e8857435653226122226a6b678c755eeaaabce0507be",
      "front": "人",
      "back": "person — hito/jin"
    }
  ]
}
```

Those ids are what the contract stores; the front and back text never reach the chain.

```console
$ echo '{"cur":{"dueAt":1800000000,"intervalDays":6,"ease":2500,"reps":2,"lapses":0},
         "grade":4,"now":1800000000}' | ./target/release/srs-plan review
{
  "next": {
    "dueAt": 1801292400,
    "intervalDays": 15,
    "ease": 2500,
    "reps": 3,
    "lapses": 0
  },
  "award": 15
}
```

`floor(6 × 2500 / 1000) = 15`. The contract cannot compute that — Compact has no division — so it
verifies it multiplicatively instead.

## Step 1 — check the preconditions

```console
$ yarn srs doctor
ok    node 22+           found v22.23.2
ok    contract zk keys   18 key files
ok    srs-plan binary    present and newer than sources
ok    wallet seed        64-hex seed in .env.preview
ok    proof server       reachable at http://127.0.0.1:6300

current deck  d7db8ea758c14ede7ce65007a640d419a800be4894d2130d1e317a0efe01dffa

all preconditions met.
```

Each failure prints the command that fixes it. The deck it names is whatever was remembered from an
earlier run; the next step replaces it.

## Step 2 — deploy a deck

No arguments needed: the bundled deck and a default bond.

```console
$ yarn srs deploy
deployed   2d76aca0c44239ac79bc026a9633b5572587840484447b07237c19c74b0bd1f6
deck       kanji-basics (8 cards)
author     a49654d67657db8acd6680c5e5aa387fe7afa600508468027af85112146f2281
bond       1000000
seeded     8 card(s) in the constructor

remembered as the current deck — later commands need no --address
next: yarn srs subscribe
[exit 0 after 30s]
```

The address is remembered, so nothing below passes `--address`.

## Step 3 — the deck, before anyone studies

```console
$ yarn srs cards
  1. 水    water — mizu             not started
  2. 火    fire — hi                not started
  3. 山    mountain — yama          not started
  4. 川    river — kawa             not started
  5. 木    tree — ki                not started
  6. 日    sun, day — hi/nichi      not started
  7. 月    moon, month — tsuki/getsu not started
  8. 人    person — hito/jin        not started
```

## Step 4 — join, posting the unshielded bond

`receiveUnshielded(nativeToken(), bondRequired)`. Pseudonyms are free; the bond is what makes a
*second* one cost money.

```console
$ yarn srs subscribe
subscribed as a49654d67657db8acd6680c5e5aa387fe7afa600508468027af85112146f2281
next: yarn srs start --card 1
[exit 0 after 37s]
```

## Step 5 — enrol a card

Referenced by index. No content hash is ever typed.

```console
$ yarn srs start --card 1
started #1 水 (water — mizu) — due now
next: yarn srs review --card 1 --grade 4
[exit 0 after 37s]
```

"Due now" matters: `startCard` bounds the proposed date only from above, so a new card is
studiable immediately rather than after some lead time the client invented.

```console
$ yarn srs due
  1. 水    water — mizu             DUE NOW  reps=0 ease=2.50 lapses=0

review one with: yarn srs review --card 1 --grade 4
```

## Step 6 — review, the whole point

The client proposes a schedule; the circuit re-derives every field and rejects any deviation.

```console
$ yarn srs review --card 1 --grade 5
reviewed   #1 水 (water — mizu)
graded     5
interval   1 day(s)
ease       2.6
next due   2026-08-19T08:54:08.000Z
xp minted  1
[exit 0 after 99s]
```

Checkable against SM-2 by hand:

| Field | Value | Why |
|---|---|---|
| `ease` | 2.6 | grade 5 adds exactly 0.1 to the starting 2.5 |
| `interval` | 1 day | `reps` became 1, and SM-2 fixes the first interval at one day |
| `xp minted` | 1 | the award is the interval earned, in days |
| `next due` | ~23h | one day minus the 1h skew margin, clear of both window edges |

## Step 7 — a second learner

`--as bob` uses a different keyfile and a separate private-state namespace, so the two learners
cannot overwrite each other's secret or XP total.

```console
$ yarn srs subscribe --as bob
subscribed as 16f38180116e2509117097e50e7a3c7542e13bacff96dce37a4cb9e0441a7bbd
next: yarn srs start --card 1
[exit 0 after 36s]

$ yarn srs start --as bob --card 2
started #2 火 (fire — hi) — due now
next: yarn srs review --card 2 --grade 4
[exit 0 after 42s]

$ yarn srs review --as bob --card 2 --grade 4
reviewed   #2 火 (fire — hi)
graded     4
interval   1 day(s)
ease       2.5
next due   2026-08-19T08:57:05.000Z
xp minted  1
[exit 0 after 90s]
```

Grade 4 leaves ease untouched — SM-2's delta for it is exactly zero.

## Step 8 — a third learner, who lapses

```console
$ yarn srs subscribe --as carol
subscribed as 808cc2059dd7e43b92e582bc305956810e0e1fdff1db3865a7ffad53a34e56c4
next: yarn srs start --card 1
[exit 0 after 37s]

$ yarn srs start --as carol --card 3
started #3 山 (mountain — yama) — due now
next: yarn srs review --card 3 --grade 4
[exit 0 after 41s]

$ yarn srs review --as carol --card 3 --grade 2
reviewed   #3 山 (mountain — yama)
graded     2 (lapse)
interval   1 day(s)
ease       2.3
next due   2026-08-19T08:59:54.000Z
xp minted  1
[exit 0 after 90s]
```

Grade 2 is below the passing threshold, so it takes the flat 0.2 penalty (2.5 → 2.3), resets the
repetition count, and increments the lapse count. All three transitions are re-derived on-chain —
a client cannot quietly keep its streak.

## Step 9 — one more review for learner A

So the ranking has a clear leader rather than a three-way tie.

```console
$ yarn srs start --card 4
started #4 川 (river — kawa) — due now
next: yarn srs review --card 4 --grade 4
[exit 0 after 36s]

$ yarn srs review --card 4 --grade 4
reviewed   #4 川 (river — kawa)
graded     4
interval   1 day(s)
ease       2.5
next due   2026-08-19T09:01:59.000Z
xp minted  1
[exit 0 after 85s]
```

## Step 10 — the leaderboard

```console
$ yarn srs leaderboard
deck 2d76aca0c44239ac…  3 learner(s)

  #  learner            reviews  lapses  tier  bond
  1  a49654d67657db8a…        2       0     0   1000000   <- you
  2  16f38180116e2509…        1       0     0   1000000
  3  808cc2059dd7e43b…        1       1     0   1000000

ranked on public diligence. XP totals stay private — a tier is the only
thing a learner reveals about their score, and only that it cleared a line.
```

Ranked on reviews landed while due, then fewest lapses — which is why Carol places below Bob on
equal review counts. Every figure here is already public on the ledger and unforgeable, because
`blockTimeGte(dueAt)` gated each review at the moment it happened.

Deliberately **not** ranked on XP. That total is committed rather than published; ranking on it
would require revealing it and would defeat the tier mechanism entirely.

## Step 11 — the private total

```console
$ yarn srs whoami
env        preview
identity   default
keyfile    /home/ubuntu/midnight-srs-test/.cache/learner.json
pseudonym  a49654d67657db8acd6680c5e5aa387fe7afa600508468027af85112146f2281
deck       2d76aca0c44239ac79bc026a9633b5572587840484447b07237c19c74b0bd1f6
xp (local) 2
```

Read from local private state. On-chain there is only `commit(2, salt)`.

## Step 12 — claim a tier without revealing the score

```console
$ yarn srs tier --tier 1 --threshold 2
tier 1 published — proved xp >= 2 without revealing it
[exit 0 after 35s]
```

The threshold is checked against the *committed* total, so a learner cannot witness an XP value
they never earned — `advanceXp` verifies the prior commitment before writing the new one. What
reaches the ledger is the tier and nothing else.

## Step 13 — final state

```console
$ yarn srs leaderboard
deck 2d76aca0c44239ac…  3 learner(s)

  #  learner            reviews  lapses  tier  bond
  1  a49654d67657db8a…        2       0     1   1000000   <- you
  2  16f38180116e2509…        1       0     0   1000000
  3  808cc2059dd7e43b…        1       1     0   1000000

ranked on public diligence. XP totals stay private — a tier is the only
thing a learner reveals about their score, and only that it cleared a line.
```

```console
$ yarn srs status
address    2d76aca0c44239ac79bc026a9633b5572587840484447b07237c19c74b0bd1f6
author     a49654d67657db8acd6680c5e5aa387fe7afa600508468027af85112146f2281
bond       1000000
cards      8
forfeited  0
xp token   b33713e0e03e1d8d45c5f0d52fc2dec2ee03c25ffd41f2cc07d877a50c92cc86
learners   3
  16f38180116e2509…  reviews=1 lapses=0 tier=0 bond=1000000
  808cc2059dd7e43b…  reviews=1 lapses=1 tier=0 bond=1000000
  a49654d67657db8a…  reviews=2 lapses=0 tier=1 bond=1000000 <- you
```

```console
$ yarn srs cards
  1. 水    water — mizu             due 2026-08-19 08:54  reps=1 ease=2.60 lapses=0
  2. 火    fire — hi                not started
  3. 山    mountain — yama          not started
  4. 川    river — kawa             due 2026-08-19 09:01  reps=1 ease=2.50 lapses=0
  5. 木    tree — ki                not started
  6. 日    sun, day — hi/nichi      not started
  7. 月    moon, month — tsuki/getsu not started
  8. 人    person — hito/jin        not started
```

Cards 2 and 3 read "not started" here even though Bob and Carol have studied them: schedules are
keyed per learner *and* per card, via `hash(["srs:slot:", learner, card])`. `cards` shows your own
progress, and one learner's schedule is invisible in another's listing.

```console
$ yarn srs due
nothing due right now
```

Nothing is due, because both of learner A's cards were just reviewed and SM-2 put them a day out.

---

## What this run does and does not establish

**Established on preview:** deploy with a seeded deck; the unshielded bond; card enrolment due
immediately; three separate learners with independent per-card schedules; reviews at grades 5, 4
and 2 each passing the circuit's full SM-2 re-derivation with the correct ease transition; a
shielded XP coin minted per review; the commitment chain advancing across two reviews; a tier
proved against a total the ledger never saw; and a multi-learner leaderboard ranked on public
diligence. The whole write path — balance, prove, submit, await finalization — is exercised
thirteen times here.

**Not exercised:** `slash` (needs a card 48h past due), `requestUnbond` / `withdrawBond` (7-day
cooldown), `sweepForfeited` (needs a slash first), `publish` (the bundled deck is seeded in the
constructor), and interval growth past SM-2's fixed first two steps — the multiplicative branch is
a week of real time away, though step 0 shows the arithmetic for it in isolation.

**Rejections are not shown here** — this document is the happy path end to end. The scheduling
assertions the contract makes are ported into `crates/srs-core/src/verify.rs`, each carrying the
contract's own message verbatim, and `crates/srs-core/tests/invariants.rs` asserts the claim that
matters: `Sched::advance` never produces a schedule the circuit would reject. `yarn core:test` runs
that with no chain and no proof server. The tier check — `XP below the claimed tier's threshold` —
has no off-chain mirror; it is enforced only against the committed total, on-chain.
