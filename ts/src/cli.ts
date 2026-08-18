#!/usr/bin/env node
import { cardIndex, loadDeck, resolveCard, type LoadedDeck } from './deck.js';
import { allPassed, runChecks } from './doctor.js';
import { identityName, identityPath } from './identity.js';
import { openSession, type Session } from './session.js';
import * as srs from './srs.js';
import { projectRoot, readDeckPointer, resolveAddress, writeDeckPointer } from './state.js';

/**
 * `srs` — drive a spaced-repetition deck on a Midnight network.
 *
 * Run it as `yarn srs <command>`. Two conveniences make that bearable: the deck address is
 * remembered after `deploy` or `use`, so `--address` is almost never needed, and cards are
 * referenced by index, front text, or id prefix rather than a 64-character hash.
 *
 * `MN_ENV` defaults to `preview`; the seed comes from `.env.<network>`. Run `yarn srs doctor`
 * first — it checks every precondition and prints the command that fixes each one.
 */

const USAGE = `\
usage: yarn srs <command> [options]

  doctor                    check every precondition and print how to fix each
  whoami                    your pseudonym, and your XP on the current deck

  deploy    [--bond <n>] [--deck <file.json>]
                            deploy a deck and remember it (default bond 1000000)
  use       --address <a>   point at an existing deck
  cards                     list the deck with due state
  due                       just the cards you can review now
  leaderboard               rank every learner by public diligence

  subscribe                 post the bond and join
  start     --card <ref>    enrol a card, due immediately
  review    --card <ref> --grade <0-5>
  tier      --tier <n> --threshold <n>

  publish   --card <ref>    add a card to the deck (author only)
  slash     --learner <hex> --card <ref>
  unbond                    start the 7-day cooldown
  withdraw  --to <hex>      reclaim the bond after the cooldown
  status                    the deck's public state

A <ref> is a card index (3), its front text (水), or an id prefix (7391bd).
Every command takes --address to override the remembered deck, and --as <name>
to act as a second learner (one wallet can back several pseudonyms).

environment:
  MN_SEED   64-hex seed for a funded, DUST-registered wallet
            (usually set in .env.preview — see .env.preview.example)
  MN_ENV    undeployed | preview | preprod | qanet | stagenet   (default: preview)`;

/**
 * Drop the relay client's clean-close chatter.
 *
 * The wallet's relay is a polkadot-js client, and it logs
 * `RPC-CORE: … disconnected from wss://… 1000:: Normal Closure` at warn level as the facade brings
 * its connection up and down. Close code 1000 *is* an orderly close, so the line says nothing a
 * reader can act on while looking exactly like a failure mid-command. Only that one shape is
 * dropped — any other disconnect, and every other log line, still prints.
 */
const silenceCleanCloseChatter = (): void => {
  const cleanClose = /RPC-CORE:.*disconnected from .*1000:: Normal Closure/;
  for (const level of ['log', 'warn', 'error'] as const) {
    const emit = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      if (cleanClose.test(args.map((a) => String(a)).join(' '))) return;
      emit(...args);
    };
  }
};

const main = async (): Promise<void> => {
  // Anchor to the project root before anything else touches the filesystem.
  //
  // Several state locations are resolved against `process.cwd()` rather than against the module:
  // the SDK's LevelDB private-state store (`midnight-level-db`) and the wallet-state cache
  // (`.cache/wallet-state`). `yarn srs …` runs workspace scripts with the cwd set to `ts/`, which
  // silently created a *second* set of both. The visible symptom was a review failing with
  // "XP witness does not match the committed total" — the fresh store had no XP total, so the
  // witness no longer matched the commitment already on chain.
  process.chdir(projectRoot());

  silenceCleanCloseChatter();

  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return;
  }

  const flags = parseFlags(argv.slice(1));

  // Must be set before the session opens: it selects both the keyfile and the private-state
  // namespace.
  if (flags.as !== undefined) process.env.SRS_IDENTITY = flags.as;

  // `doctor` must run without a wallet — it is what you reach for when the wallet is the problem.
  if (command === 'doctor') {
    await doctor();
    return;
  }

  // `use` is local bookkeeping; no reason to spend 30s syncing a wallet for it.
  if (command === 'use') {
    const address = required(flags, 'address');
    const deck = loadDeck(flags.deck);
    writeDeckPointer({ address, deckFile: deck.file });
    console.log(`now pointing at ${address}`);
    console.log(`deck            ${deck.name} (${deck.cards.length} cards, ${deck.file})`);
    return;
  }

  const session = await openSession();
  try {
    await run(command, flags, session);
  } finally {
    await session.stop();
  }
};

const run = async (command: string, flags: Flags, session: Session): Promise<void> => {
  const { providers, zkConfigPath, identity } = session;
  const me = srs.pseudonym(identity);

  switch (command) {
    case 'whoami': {
      console.log(`env        ${session.env}`);
      console.log(`identity   ${identityName()}`);
      console.log(`keyfile    ${identityPath()}`);
      console.log(`pseudonym  ${srs.bytesToHex(me)}`);
      const address = flags.address ?? readDeckPointer()?.address;
      if (address !== undefined) {
        const state = await srs.readPrivateState(providers, address);
        console.log(`deck       ${address}`);
        console.log(`xp (local) ${state === null ? '(not joined this deck)' : state.xp}`);
      }
      break;
    }

    case 'deploy': {
      // A default bond keeps the common case down to `yarn srs deploy`.
      const bond = BigInt(flags.bond ?? '1000000');
      const deck = loadDeck(flags.deck);
      const ids = deck.cards.map((c) => srs.hexToBytes(c.id));
      const seeded = ids.slice(0, 8);
      const remainder = ids.slice(8);

      const deployed = await srs.deploy(providers, zkConfigPath, identity, { bond, cards: seeded });
      const address = deployed.deployTxData.public.contractAddress;
      writeDeckPointer({ address, deckFile: deck.file });

      console.log(`deployed   ${address}`);
      console.log(`deck       ${deck.name} (${deck.cards.length} cards)`);
      console.log(`author     ${srs.bytesToHex(me)}`);
      console.log(`bond       ${bond}`);
      console.log(`seeded     ${seeded.length} card(s) in the constructor`);
      for (const [i, card] of remainder.entries()) {
        await srs.publishCard(deployed, card);
        console.log(`published  ${i + 1}/${remainder.length}`);
      }
      console.log('\nremembered as the current deck — later commands need no --address');
      console.log('next: yarn srs subscribe');
      break;
    }

    case 'cards':
    case 'due': {
      const address = resolveAddress(flags.address);
      const deck = loadDeck(flags.deck);
      const schedules = await srs.readSchedules(
        providers,
        address,
        me,
        deck.cards.map((c) => srs.hexToBytes(c.id)),
      );
      const now = srs.nowSecs();
      const onlyDue = command === 'due';

      const rows = deck.cards
        .map((card, i) => ({ card, index: i + 1, sched: schedules.get(card.id) ?? null }))
        .filter((r) => (onlyDue ? r.sched !== null && r.sched.dueAt <= now : true));

      if (rows.length === 0) {
        console.log(onlyDue ? 'nothing due right now' : 'this deck has no cards');
        break;
      }

      for (const { card, index, sched } of rows) {
        const state =
          sched === null
            ? 'not started'
            : sched.dueAt <= now
              ? 'DUE NOW'
              : `due ${new Date(sched.dueAt * 1000).toISOString().replace('T', ' ').slice(0, 16)}`;
        const detail =
          sched === null ? '' : `  reps=${sched.reps} ease=${(sched.ease / 1000).toFixed(2)} lapses=${sched.lapses}`;
        console.log(`${String(index).padStart(3)}. ${card.front.padEnd(4)} ${card.back.padEnd(24)} ${state}${detail}`);
      }
      if (onlyDue) console.log(`\nreview one with: yarn srs review --card ${rows[0]!.index} --grade 4`);
      break;
    }

    case 'subscribe': {
      const address = resolveAddress(flags.address);
      const deployed = await srs.connect(providers, zkConfigPath, identity, address);
      await srs.subscribe(deployed);
      console.log(`subscribed as ${srs.bytesToHex(me)}`);
      console.log('next: yarn srs start --card 1');
      break;
    }

    case 'start': {
      const address = resolveAddress(flags.address);
      const deck = loadDeck(flags.deck);
      const card = resolveCard(deck, required(flags, 'card'));
      const deployed = await srs.connect(providers, zkConfigPath, identity, address);
      await srs.startCard(deployed, srs.hexToBytes(card.id));
      console.log(`started ${describe(deck, card)} — due now`);
      console.log(`next: yarn srs review --card ${cardIndex(deck, card.id)} --grade 4`);
      break;
    }

    case 'review': {
      const address = resolveAddress(flags.address);
      const deck = loadDeck(flags.deck);
      const card = resolveCard(deck, required(flags, 'card'));
      const grade = Number(required(flags, 'grade'));
      if (!Number.isInteger(grade) || grade < 0 || grade > 5) {
        throw new Error('--grade must be a whole number from 0 to 5 (below 3 counts as a lapse)');
      }

      // Connect first: the witnesses read private state from the store, and `connect` is what
      // guarantees it is present and scoped to this deck.
      await srs.connect(providers, zkConfigPath, identity, address);
      const result = await srs.review(providers, zkConfigPath, identity, address, srs.hexToBytes(card.id), grade);
      console.log(`reviewed   ${describe(deck, card)}`);
      console.log(`graded     ${grade}${grade < 3 ? ' (lapse)' : ''}`);
      console.log(`interval   ${result.next.intervalDays} day(s)`);
      console.log(`ease       ${Number(result.next.ease) / 1000}`);
      console.log(`next due   ${new Date(Number(result.next.dueAt) * 1000).toISOString()}`);
      console.log(`xp minted  ${result.award}`);
      break;
    }

    case 'tier': {
      const address = resolveAddress(flags.address);
      const deployed = await srs.connect(providers, zkConfigPath, identity, address);
      const tier = Number(required(flags, 'tier'));
      const threshold = BigInt(required(flags, 'threshold'));
      await srs.claimTier(deployed, tier, threshold);
      console.log(`tier ${tier} published — proved xp >= ${threshold} without revealing it`);
      break;
    }

    case 'publish': {
      const address = resolveAddress(flags.address);
      const deck = loadDeck(flags.deck);
      const card = resolveCard(deck, required(flags, 'card'));
      const deployed = await srs.connect(providers, zkConfigPath, identity, address);
      await srs.publishCard(deployed, srs.hexToBytes(card.id));
      console.log(`published ${describe(deck, card)}`);
      break;
    }

    case 'slash': {
      const address = resolveAddress(flags.address);
      const deck = loadDeck(flags.deck);
      const card = resolveCard(deck, required(flags, 'card'));
      const deployed = await srs.connect(providers, zkConfigPath, identity, address);
      await srs.slash(deployed, srs.hexToBytes(required(flags, 'learner')), srs.hexToBytes(card.id));
      console.log('slashed');
      break;
    }

    case 'unbond': {
      const address = resolveAddress(flags.address);
      const deployed = await srs.connect(providers, zkConfigPath, identity, address);
      // `pinAtLeast` requires readyAt > now + cooldown, so the slack is added, not subtracted —
      // an hour past the minimum absorbs clock skew and the proving delay.
      const readyAt = srs.nowSecs() + 604_800 + 3_600;
      await srs.requestUnbond(deployed, readyAt);
      console.log(`unbond ready at ${new Date(readyAt * 1000).toISOString()}`);
      break;
    }

    case 'withdraw': {
      const address = resolveAddress(flags.address);
      const deployed = await srs.connect(providers, zkConfigPath, identity, address);
      await srs.withdrawBond(deployed, srs.hexToBytes(required(flags, 'to')));
      console.log('bond withdrawn');
      break;
    }

    case 'leaderboard': {
      const address = resolveAddress(flags.address);
      const deck = await srs.readDeck(providers, address);
      if (deck === null) {
        console.log(`no contract at ${address}`);
        break;
      }
      if (deck.learners.length === 0) {
        console.log('no learners yet — `yarn srs subscribe` to join');
        break;
      }

      // Rank on what the chain actually proves: reviews landed while due, and deadlines blown.
      // Not on XP — that total is committed, not published, which is the whole point of the tier.
      const ranked = [...deck.learners].sort(
        (a, b) => Number(b.reviews - a.reviews) || Number(a.lapses - b.lapses) || Number(b.tier - a.tier),
      );
      const mine = srs.bytesToHex(me);

      console.log(`deck ${address.slice(0, 16)}…  ${deck.learners.length} learner(s)\n`);
      console.log('  #  learner            reviews  lapses  tier  bond');
      for (const [i, l] of ranked.entries()) {
        const who = srs.bytesToHex(l.pseudonym);
        const row =
          `${String(i + 1).padStart(3)}  ${who.slice(0, 16)}…  ` +
          `${String(l.reviews).padStart(7)}  ${String(l.lapses).padStart(6)}  ` +
          `${String(l.tier).padStart(4)}  ${String(l.bond).padStart(8)}`;
        console.log(who === mine ? `${row}   <- you` : row);
      }
      console.log('\nranked on public diligence. XP totals stay private — a tier is the only');
      console.log('thing a learner reveals about their score, and only that it cleared a line.');
      break;
    }

    case 'status': {
      const address = resolveAddress(flags.address);
      const deck = await srs.readDeck(providers, address);
      if (deck === null) {
        console.log(`no contract at ${address}`);
        break;
      }
      console.log(`address    ${address}`);
      console.log(`author     ${srs.bytesToHex(deck.author)}`);
      console.log(`bond       ${deck.bondRequired}`);
      console.log(`cards      ${deck.cards.length}`);
      console.log(`forfeited  ${deck.forfeited}`);
      console.log(`xp token   ${isZero(deck.xpColor) ? '(not yet minted)' : srs.bytesToHex(deck.xpColor)}`);
      console.log(`learners   ${deck.learners.length}`);
      for (const l of deck.learners) {
        const mine = srs.bytesToHex(l.pseudonym) === srs.bytesToHex(me) ? ' <- you' : '';
        console.log(
          `  ${srs.bytesToHex(l.pseudonym).slice(0, 16)}…  ` +
            `reviews=${l.reviews} lapses=${l.lapses} tier=${l.tier} bond=${l.bond}${mine}`,
        );
      }
      break;
    }

    default:
      throw new Error(`unknown command \`${command}\`\n\n${USAGE}`);
  }
};

const doctor = async (): Promise<void> => {
  const checks = await runChecks();
  for (const check of checks) {
    console.log(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(18)} ${check.detail}`);
    if (check.fix !== undefined) console.log(`        fix: ${check.fix}`);
  }

  const pointer = readDeckPointer();
  console.log(`\ncurrent deck  ${pointer === null ? '(none — run `yarn srs deploy`)' : pointer.address}`);

  if (allPassed(checks)) {
    console.log('\nall preconditions met.');
  } else {
    console.log('\nfix the failures above, then re-run `yarn srs doctor`.');
    process.exitCode = 1;
  }
};

const describe = (deck: LoadedDeck, card: { id: string; front: string; back: string }): string =>
  `#${cardIndex(deck, card.id)} ${card.front} (${card.back})`;

// ---------------------------------------------------------------------------
// argument handling
// ---------------------------------------------------------------------------

type Flags = Record<string, string | undefined>;

/** Parse `--key value` pairs. There are no positional arguments beyond the command. */
const parseFlags = (args: readonly string[]): Flags => {
  const flags: Flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith('--')) throw new Error(`expected a --flag, got \`${arg}\``);
    const value = args[i + 1];
    // A negative number is a value, not the next flag.
    if (value === undefined || (value.startsWith('--') && !/^--?\d/.test(value))) {
      throw new Error(`${arg} needs a value`);
    }
    flags[arg.slice(2)] = value;
    i += 1;
  }
  return flags;
};

const required = (flags: Flags, name: string): string => {
  const value = flags[name];
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
};

const isZero = (bytes: Uint8Array): boolean => bytes.every((b) => b === 0);

await main().catch((e: unknown) => {
  console.error(`srs: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
