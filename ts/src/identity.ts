import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A learner's stable identity, held outside any contract's private state.
 *
 * The SDK's private-state store is scoped *per contract address* — `get`/`set` throw until
 * `setContractAddress` has been called — so it cannot hold anything that needs to exist before
 * a deck is known, and it cannot be the home of an identity shared across decks. Two things
 * therefore live here in a keyfile instead:
 *
 *   - `sk`, the secret behind the pseudonym `persistentHash(["srs:pk:", sk])`. Keeping it
 *     address-independent is what lets one learner join several decks under one identity, and
 *     what makes `whoami` answerable without touching a chain.
 *   - `salt`, from which each deck's XP commitment blinding factor is *derived* rather than
 *     stored. See {@link deckSalt}.
 *
 * Per-deck private state (the XP total) still lives in the SDK store, seeded from this file.
 */
export interface LearnerIdentity {
  /** The 32-byte secret behind this learner's pseudonym. */
  readonly sk: Uint8Array;
  /** Root secret for deriving each deck's XP commitment salt. */
  readonly salt: Uint8Array;
}

/** Serialised form. Hex rather than base64 so it lines up with everything else on screen. */
interface StoredIdentity {
  readonly sk: string;
  readonly salt: string;
}

/**
 * Which named identity to use, from `SRS_IDENTITY` (the `--as` flag sets it).
 *
 * One wallet can back several learners, because identity here is a dapp secret rather than a
 * wallet key. That is useful for trying out the social side single-handed — and it is also
 * precisely the Sybil property the bond exists to price, so it is worth being able to see.
 */
export const identityName = (): string => {
  const name = process.env.SRS_IDENTITY;
  if (name === undefined || name === '') return 'default';
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
    throw new Error(`SRS_IDENTITY must be alphanumeric (got "${name}")`);
  }
  return name;
};

/** Where the keyfile lives: `<project>/.cache/learner[-<name>].json`, gitignored. */
export const identityPath = (): string => {
  const name = identityName();
  const file = name === 'default' ? 'learner.json' : `learner-${name}.json`;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/ -> ts/ -> project root
  const root = path.resolve(here, '..', '..');
  return path.join(root, '.cache', file);
};

/**
 * Load the learner identity, creating it on first use.
 *
 * Written `0600`: this file is the learner's pseudonym. Anyone holding it can act as them on
 * every deck they have joined.
 */
export const loadOrCreateIdentity = (): LearnerIdentity => {
  const file = identityPath();
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as StoredIdentity;
    return { sk: fromHex(stored.sk, 'sk'), salt: fromHex(stored.salt, 'salt') };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`could not read ${file}: ${(cause as Error).message}`, { cause });
    }
  }

  const identity: LearnerIdentity = { sk: randomBytes(32), salt: randomBytes(32) };
  mkdirSync(path.dirname(file), { recursive: true });
  const stored: StoredIdentity = { sk: toHex(identity.sk), salt: toHex(identity.salt) };
  writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return identity;
};

/**
 * The XP commitment salt for one deck.
 *
 * Derived from the root salt and the contract address rather than stored, which buys two
 * things. Each deck gets a distinct blinding factor, so the same XP total in two decks does not
 * produce the same commitment. And the salt is always recoverable from the keyfile — if the
 * private-state store is lost, only the XP *total* is gone, not the ability to commit at all.
 */
export const deckSalt = (identity: LearnerIdentity, contractAddress: string): Uint8Array =>
  new Uint8Array(
    createHash('sha256')
      .update('srs:xp-salt:')
      .update(identity.salt)
      .update(contractAddress)
      .digest(),
  );

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const fromHex = (hex: string, field: string): Uint8Array => {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${identityPath()}: ${field} must be 64 hex characters`);
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
};
