import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bridge to `srs-plan`, the Rust binary that owns the scheduling arithmetic.
 *
 * The boundary is a subprocess rather than WASM on purpose. Each call happens once per human
 * review and takes under a millisecond; the proof that follows it takes seconds. Paying for a
 * WASM toolchain to save that would be a poor trade, and a subprocess keeps the Rust crate
 * usable on its own from a shell.
 *
 * `execFileSync` (not `exec`) so no shell ever sees the arguments, and synchronous because
 * the caller has nothing else to do until the schedule comes back.
 */

/** A schedule, matching the contract's `Sched` struct field-for-field. */
export interface Sched {
  readonly dueAt: number;
  readonly intervalDays: number;
  readonly ease: number;
  readonly reps: number;
  readonly lapses: number;
}

/** A card with its content address, as `srs-plan deck` emits it. */
export interface AddressedCard {
  readonly id: string;
  readonly front: string;
  readonly back: string;
}

export interface AddressedDeck {
  readonly name: string;
  readonly cards: readonly AddressedCard[];
}

/** The result of advancing a schedule. */
export interface Advanced {
  readonly next: Sched;
  /** XP the contract will mint — the interval earned, in days. */
  readonly award: number;
}

/**
 * Where the release binary lands. Falls back to the debug build so a `cargo test` working
 * tree is usable without a release build, and can be overridden for an installed binary.
 */
const resolveBinary = (): string => {
  const override = process.env.SRS_PLAN_BIN;
  if (override !== undefined && override !== '') return override;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/ -> ts/ -> project root
  const root = path.resolve(here, '..', '..');
  return path.join(root, 'target', 'release', 'srs-plan');
};

const run = <T>(args: readonly string[], stdin?: unknown): T => {
  const bin = resolveBinary();
  try {
    const out = execFileSync(bin, args, {
      input: stdin === undefined ? undefined : JSON.stringify(stdin),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(out) as T;
  } catch (cause) {
    // The binary writes a single explanatory line to stderr and exits non-zero. Surface that
    // rather than a bare "command failed", since for a rejected schedule it is the contract's
    // own assertion message.
    const stderr = (cause as { stderr?: Buffer | string }).stderr;
    const detail = typeof stderr === 'string' ? stderr.trim() : (stderr?.toString().trim() ?? '');
    const hint =
      detail === ''
        ? `could not run ${bin} — has \`cargo build --release\` been run?`
        : detail;
    throw new Error(`srs-plan ${args.join(' ')}: ${hint}`, { cause });
  }
};

/** Content-address a deck's cards. */
export const addressDeck = (deck: {
  readonly name: string;
  readonly cards: readonly { readonly front: string; readonly back: string }[];
}): AddressedDeck => run<AddressedDeck>(['deck'], deck);

/**
 * The schedule the contract's `startCard` will write for a card first seen at `now`.
 *
 * Due immediately. `startCard` bounds the proposal only from above (`pinNotBeyond`), so there
 * is no lead time to guess and no risk of a slow proof pushing the transaction past a deadline
 * the client invented.
 */
export const startSchedule = (now: number): Sched => run<Sched>(['start', '--now', String(now)]);

/**
 * Advance a schedule by one review.
 *
 * Throws if the result would be rejected on-chain — the Rust side refuses to emit a proposal
 * that fails its port of the circuit's checks, which turns a wasted proof into a fast local
 * error.
 */
export const advance = (cur: Sched, grade: number, now: number): Advanced =>
  run<Advanced>(['review'], { cur, grade, now });

/** Ask whether the chain would accept a proposal, without producing one. */
export const wouldAccept = (cur: Sched, grade: number, next: Sched, now: number): boolean => {
  try {
    run<{ ok: boolean }>(['verify'], { cur, grade, next, now });
    return true;
  } catch {
    return false;
  }
};
