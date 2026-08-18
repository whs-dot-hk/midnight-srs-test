import { readFileSync } from 'node:fs';
import path from 'node:path';
import { addressDeck, type AddressedCard } from './planner.js';
import { projectRoot, readDeckPointer } from './state.js';

/** The deck shipped with the project, used when nothing else is specified. */
export const DEFAULT_DECK_FILE = 'decks/kanji-basics.json';

/** A deck loaded from disk with every card's content address resolved. */
export interface LoadedDeck {
  readonly name: string;
  readonly file: string;
  readonly cards: readonly AddressedCard[];
}

/**
 * Load a deck and content-address its cards.
 *
 * Resolution order: an explicit path, then the deck the current pointer was deployed from, then
 * the bundled default. Relative paths resolve against the project root, so the CLI works from any
 * working directory.
 */
export const loadDeck = (explicitFile?: string): LoadedDeck => {
  const file = explicitFile ?? readDeckPointer()?.deckFile ?? DEFAULT_DECK_FILE;
  const abs = path.isAbsolute(file) ? file : path.join(projectRoot(), file);

  let parsed: { name?: string; cards?: { front?: string; back?: string }[] };
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8')) as typeof parsed;
  } catch (cause) {
    throw new Error(`could not read deck ${abs}: ${(cause as Error).message}`, { cause });
  }
  if (!Array.isArray(parsed.cards) || parsed.cards.length === 0) {
    throw new Error(`${abs}: expected a non-empty "cards" array of {front, back}`);
  }

  const cards = parsed.cards.map((c, i) => {
    if (typeof c.front !== 'string' || typeof c.back !== 'string') {
      throw new Error(`${abs}: card ${i + 1} needs string "front" and "back" fields`);
    }
    return { front: c.front, back: c.back };
  });

  const addressed = addressDeck({ name: parsed.name ?? path.basename(abs, '.json'), cards });
  return { name: addressed.name, file, cards: addressed.cards };
};

/**
 * Resolve a human-friendly card reference against a deck.
 *
 * Accepts, in order of precedence:
 *
 *   - a 1-based index into the deck — `--card 3`
 *   - the card's front text — `--card 水`
 *   - a full 64-character content hash, or any unambiguous prefix of one — `--card 7391bd`
 *
 * Nobody should have to paste a content hash to review a flashcard, and an ambiguous prefix is
 * reported rather than silently resolved to the first match.
 */
export const resolveCard = (deck: LoadedDeck, reference: string): AddressedCard => {
  const ref = reference.trim();
  if (ref === '') throw new Error('--card needs a value: an index, the card front, or a card id');

  if (/^\d+$/.test(ref)) {
    const index = Number.parseInt(ref, 10);
    const card = deck.cards[index - 1];
    if (card === undefined) {
      throw new Error(`--card ${index} is out of range: ${deck.name} has ${deck.cards.length} cards`);
    }
    return card;
  }

  const byFront = deck.cards.filter((c) => c.front === ref);
  if (byFront.length === 1) return byFront[0]!;
  if (byFront.length > 1) {
    throw new Error(`"${ref}" matches ${byFront.length} cards by front text — use an index instead`);
  }

  if (/^[0-9a-fA-F]+$/.test(ref)) {
    const lower = ref.toLowerCase();
    const byId = deck.cards.filter((c) => c.id.startsWith(lower));
    if (byId.length === 1) return byId[0]!;
    if (byId.length > 1) {
      throw new Error(`card id prefix "${ref}" is ambiguous — ${byId.length} cards match`);
    }
  }

  throw new Error(
    `no card in ${deck.name} matches "${ref}" — run \`yarn srs cards\` to list them ` +
      `(reference a card by index, front text, or id prefix)`,
  );
};

/** 1-based position of a card in its deck, for display. */
export const cardIndex = (deck: LoadedDeck, id: string): number => deck.cards.findIndex((c) => c.id === id) + 1;
