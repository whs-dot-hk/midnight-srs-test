import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The deck the CLI is currently pointed at.
 *
 * Remembered so `--address` need not be retyped on every command. A 64-character hex address is
 * not something anyone should be pasting a dozen times to work through a study session.
 *
 * This is convenience only — no secrets. Identity lives in `identity.ts`, XP in the SDK's
 * private-state store.
 */
export interface DeckPointer {
  /** Contract address of the deck. */
  readonly address: string;
  /**
   * Deck file the cards came from, so `--card` can accept an index or the card's front text
   * instead of a content hash.
   */
  readonly deckFile: string;
}

const FILE = 'deck.json';

export const projectRoot = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/ -> ts/ -> project root
  return path.resolve(here, '..', '..');
};

const pointerPath = (): string => path.join(projectRoot(), '.cache', FILE);

/** The remembered deck, or `null` if none has been deployed or selected yet. */
export const readDeckPointer = (): DeckPointer | null => {
  try {
    const raw = JSON.parse(readFileSync(pointerPath(), 'utf8')) as Partial<DeckPointer>;
    if (typeof raw.address !== 'string' || typeof raw.deckFile !== 'string') return null;
    return { address: raw.address, deckFile: raw.deckFile };
  } catch {
    // Absent or unreadable both mean "nothing remembered", which is not an error.
    return null;
  }
};

export const writeDeckPointer = (pointer: DeckPointer): void => {
  const file = pointerPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(pointer, null, 2)}\n`);
};

/**
 * The address to act on: an explicit `--address` wins, otherwise the remembered deck.
 *
 * @throws with the exact next step when neither is available.
 */
export const resolveAddress = (explicit: string | undefined): string => {
  if (explicit !== undefined && explicit !== '') return explicit;
  const pointer = readDeckPointer();
  if (pointer !== null) return pointer.address;
  throw new Error(
    'no deck selected — deploy one with `yarn srs deploy --bond 1000000`, ' +
      'or point at an existing one with `yarn srs use --address <addr>`',
  );
};
