import { deployContract, findDeployedContract, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import type { ContractProviders, DeployedContract, FoundContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import type { ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { Contract, ledger, pureCircuits, type Sched } from '@midnight-srs/contracts';
import { deckSalt, type LearnerIdentity } from './identity.js';
import { advance, type Sched as PlannedSched, startSchedule } from './planner.js';
import { applyAward, srsWitnesses, type SrsPrivateState } from './private-state.js';

const PRIVATE_STATE_ID = 'srsPrivateState' as const;

/** The generated contract, bound to this project's private state and witnesses. */
export type SrsContract = Contract<SrsPrivateState, typeof srsWitnesses>;

export type SrsProviders = ContractProviders<SrsContract>;
export type SrsCircuits = Parameters<typeof submitCallTx>[1]['circuitId'];
export type DeployedSrs = DeployedContract<SrsContract> | FoundContract<SrsContract>;

/**
 * There is exactly one contract here, so it is wired straight to the SDK rather than through a
 * generic factory: the compiled contract pairs the generated bindings with our witnesses, and
 * `zkConfigPath` points at the directory holding its prover keys.
 */
const compiled = (zkConfigPath: string) =>
  CompiledContract.make<SrsContract>('srs', Contract).pipe(
    CompiledContract.withWitnesses(srsWitnesses),
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  );

/**
 * Decode the deck's public state, or `null` if nothing is deployed at `address`.
 *
 * One fetch per call, so callers that need many fields should read once and pick them apart rather
 * than calling repeatedly.
 */
const readLedger = async (providers: SrsProviders, address: ContractAddress) => {
  const state = await providers.publicDataProvider.queryContractState(address);
  return state === null ? null : ledger(state.data);
};

/** The contract's `Vector<8, Maybe<Bytes<32>>>` constructor argument. */
const INITIAL_CARD_SLOTS = 8;

/**
 * Pad a card list into the fixed-width vector of optionals the constructor takes.
 *
 * Compact has no variable-length arguments, so a deck is seeded through a fixed vector and
 * grown afterwards with `publishCard`. The width is deliberately small — every slot costs
 * deploy-proof time whether or not it holds a card.
 */
const toCardSlots = (cards: readonly Uint8Array[]): { is_some: boolean; value: Uint8Array }[] => {
  if (cards.length > INITIAL_CARD_SLOTS) {
    throw new Error(
      `at most ${INITIAL_CARD_SLOTS} cards can be seeded at deploy; publish the remaining ${
        cards.length - INITIAL_CARD_SLOTS
      } with publishCard`,
    );
  }
  return Array.from({ length: INITIAL_CARD_SLOTS }, (_, i) => {
    const card = cards[i];
    return card === undefined ? { is_some: false, value: new Uint8Array(32) } : { is_some: true, value: card };
  });
};

/** This learner's on-chain pseudonym — the same hash the circuit derives. */
export const pseudonym = (identity: LearnerIdentity): Uint8Array => pureCircuits.dappPk(identity.sk);

/**
 * The private state to seed a deck with.
 *
 * `sk` is shared across every deck (one learner, one pseudonym); the XP salt is derived per deck
 * so two decks never produce the same commitment for the same total. `xp` starts at zero and is
 * advanced only by {@link review}, after a transaction finalises.
 */
export const deckPrivateState = (identity: LearnerIdentity, address: ContractAddress): SrsPrivateState => ({
  sk: identity.sk,
  xp: 0n,
  xpSalt: deckSalt(identity, address),
});

/**
 * Read this deck's private state, scoping the provider to the contract first.
 *
 * The scoping call is mandatory, not defensive: the store namespaces state by contract address
 * and throws `Contract address not set` on any `get`/`set` before it.
 */
export const readPrivateState = async (
  providers: SrsProviders,
  address: ContractAddress,
): Promise<SrsPrivateState | null> => {
  providers.privateStateProvider.setContractAddress(address);
  return providers.privateStateProvider.get(PRIVATE_STATE_ID);
};

/** The composite key under which one learner's progress on one card is stored. */
export const slotKey = (learner: Uint8Array, card: Uint8Array): Uint8Array => pureCircuits.slotKey(learner, card);

/**
 * Deploy a deck.
 *
 * The deployer becomes the author, since the constructor derives `author` from their witness
 * secret. `bond` is fixed for the deck's lifetime.
 */
export const deploy = async (
  providers: SrsProviders,
  zkConfigPath: string,
  identity: LearnerIdentity,
  opts: { readonly bond: bigint; readonly cards?: readonly Uint8Array[] },
): Promise<DeployedSrs> => {
  // The salt is derived from the contract address, which does not exist yet — so the deploy is
  // seeded with the address-independent parts and the salt is written once the address is known.
  // Only `subscribe` opens the commitment chain, so no circuit reads the salt before then.
  const deployed = await deployContract<SrsContract>(providers, {
    compiledContract: compiled(zkConfigPath),
    privateStateId: PRIVATE_STATE_ID,
    args: [opts.bond, toCardSlots(opts.cards ?? [])],
    initialPrivateState: { sk: identity.sk, xp: 0n, xpSalt: new Uint8Array(32) },
  });
  const address = deployed.deployTxData.public.contractAddress;
  providers.privateStateProvider.setContractAddress(address);
  await providers.privateStateProvider.set(PRIVATE_STATE_ID, deckPrivateState(identity, address));
  return deployed;
};

/**
 * Attach to an existing deck with this learner's own private state.
 *
 * The state must be passed explicitly. `findDeployedContract` writes whatever it is given
 * into the private-state store, so connecting without it would overwrite a learner's secrets
 * with the factory sentinel and lose their XP total.
 */
export const connect = async (
  providers: SrsProviders,
  zkConfigPath: string,
  identity: LearnerIdentity,
  address: ContractAddress,
): Promise<DeployedSrs> => {
  // Preserve an existing XP total: `findDeployedContract` writes whatever it is handed into the
  // store, so passing a freshly-seeded state on every connect would reset the total and break
  // the commitment chain on the next review.
  const existing = await readPrivateState(providers, address);
  return findDeployedContract<SrsContract>(providers, {
    compiledContract: compiled(zkConfigPath),
    contractAddress: address,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: existing ?? deckPrivateState(identity, address),
  });
};

// ---------------------------------------------------------------------------
// Deck curation and membership
// ---------------------------------------------------------------------------

export const publishCard = (deployed: DeployedSrs, card: Uint8Array) => deployed.callTx.publishCard(card);

/** Post the bond and join. Transfers `bondRequired` of the native token to the contract. */
export const subscribe = (deployed: DeployedSrs) => deployed.callTx.subscribe();

/**
 * Enrol a card into this learner's schedule, due immediately.
 *
 * `firstDue` comes from the planner rather than being chosen here, so it lands inside the window
 * the contract pins it to. For a new card that window is one-sided — `pinNotBeyond` caps how far
 * out the date may be but sets no floor — so the card is studiable straight away.
 */
export const startCard = async (deployed: DeployedSrs, card: Uint8Array, now = nowSecs()) => {
  const planned = startSchedule(now);
  return deployed.callTx.startCard(card, BigInt(planned.dueAt));
};

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export interface ReviewResult {
  /** The schedule now recorded on-chain. */
  readonly next: Sched;
  /** XP minted by this review, in interval-days. */
  readonly award: bigint;
}

/**
 * Review a card: plan the transition off-chain, prove it on-chain, then record the award.
 *
 * Three things happen in a specific order, and the order is the point:
 *
 * 1. The Rust planner computes the next schedule and refuses to return one the contract would
 *    reject, so a mis-scheduled card fails in microseconds instead of after a proof.
 * 2. The call goes through `callWithOptions` rather than `callTx`, because `review` forwards a
 *    shielded XP coin with `sendShielded`. Without the recipient's encryption public key in the
 *    transaction there is no ciphertext the recipient can open, and the coin is invisible to
 *    their wallet — permanently. `callTx` has no parameter for that mapping. The recipient here
 *    is the caller themselves, but the mapping is supplied explicitly rather than relying on
 *    the SDK to infer it.
 * 3. The private XP total advances only after the transaction has finalised. The contract
 *    checks `commit(xp, salt)` against the ledger before every update, so advancing early —
 *    or twice — would break every later review with "XP witness does not match the committed
 *    total".
 */
export const review = async (
  providers: SrsProviders,
  zkConfigPath: string,
  identity: LearnerIdentity,
  address: ContractAddress,
  card: Uint8Array,
  grade: number,
  now = nowSecs(),
): Promise<ReviewResult> => {
  const state = await readPrivateState(providers, address);
  if (state === null) {
    throw new Error('no private state for this deck — subscribe first');
  }
  const learner = pseudonym(identity);
  const current = await readSchedule(providers, address, learner, card);
  if (current === null) {
    throw new Error('card has not been started for this learner — call startCard first');
  }

  const { next, award } = advance(current, grade, now);

  const coinPublicKey = providers.walletProvider.getCoinPublicKey();
  const encryptionPublicKey = providers.walletProvider.getEncryptionPublicKey();

  await submitCallTx<SrsContract, 'review'>(providers, {
    compiledContract: compiled(zkConfigPath),
    contractAddress: address,
    circuitId: 'review',
    privateStateId: PRIVATE_STATE_ID,
    args: [card, BigInt(grade), toContractSched(next), { bytes: hexToBytes(coinPublicKey) }],
    additionalCoinEncPublicKeyMappings: new Map([[coinPublicKey, encryptionPublicKey]]),
  });

  // Finalised: it is now safe — and required — to advance the local total.
  await providers.privateStateProvider.set(PRIVATE_STATE_ID, applyAward(state, BigInt(award)));

  return { next: toContractSched(next), award: BigInt(award) };
};

/**
 * Publish a tier by proving the private XP total clears `threshold`.
 *
 * Nothing but the tier reaches the ledger. The only thing an observer learns beyond the tier
 * itself is the single bit that the total is at or above the line, which is inherent to
 * claiming a tier at all.
 */
export const claimTier = (deployed: DeployedSrs, tier: number, threshold: bigint) =>
  deployed.callTx.claimTier(BigInt(tier), threshold);

// ---------------------------------------------------------------------------
// Accountability
// ---------------------------------------------------------------------------

/** Prove a learner blew a deadline past the grace period. Permissionless. */
export const slash = (deployed: DeployedSrs, learner: Uint8Array, card: Uint8Array) =>
  deployed.callTx.slash(learner, card);

/** Begin unbonding. The cooldown is what prevents racing a pending slash. */
export const requestUnbond = (deployed: DeployedSrs, readyAt: number) =>
  deployed.callTx.requestUnbond(BigInt(readyAt));

/** Withdraw the bond once the cooldown has elapsed. */
export const withdrawBond = (deployed: DeployedSrs, to: Uint8Array) => deployed.callTx.withdrawBond({ bytes: to });

/** Author-only: sweep slashed bonds. */
export const sweepForfeited = (deployed: DeployedSrs, to: Uint8Array) =>
  deployed.callTx.sweepForfeited({ bytes: to });

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

/** The public view of a deck. Everything here is visible to anyone. */
export interface DeckState {
  readonly author: Uint8Array;
  readonly bondRequired: bigint;
  readonly cards: readonly Uint8Array[];
  readonly learners: readonly LearnerState[];
  readonly forfeited: bigint;
  /** Empty until the first review mints XP. */
  readonly xpColor: Uint8Array;
}

export interface LearnerState {
  readonly pseudonym: Uint8Array;
  readonly bond: bigint;
  readonly reviews: bigint;
  readonly lapses: bigint;
  readonly tier: bigint;
  /** Set once unbonding has been requested. */
  readonly unbondReadyAt: bigint | null;
}

export const readDeck = async (providers: SrsProviders, address: ContractAddress): Promise<DeckState | null> => {
  const state = await readLedger(providers, address);
  if (state == null) return null;

  const learners: LearnerState[] = [];
  for (const learner of state.learners) {
    learners.push({
      pseudonym: learner,
      bond: state.bonds.member(learner) ? state.bonds.lookup(learner) : 0n,
      reviews: state.reviewCount.member(learner) ? state.reviewCount.lookup(learner) : 0n,
      lapses: state.lapseCount.member(learner) ? state.lapseCount.lookup(learner) : 0n,
      tier: state.tier.member(learner) ? state.tier.lookup(learner) : 0n,
      unbondReadyAt: state.unbondReadyAt.member(learner) ? state.unbondReadyAt.lookup(learner) : null,
    });
  }

  return {
    author: state.author,
    bondRequired: state.bondRequired,
    cards: [...state.cards],
    learners,
    forfeited: state.forfeited,
    xpColor: state.xpColor,
  };
};

/**
 * Every schedule this learner has for the given cards, from a single ledger read.
 *
 * `readSchedule` fetches the whole ledger per call, so listing a deck card-by-card would refetch
 * it once per card. Returned map is keyed by card id; absent means the card was never started.
 */
export const readSchedules = async (
  providers: SrsProviders,
  address: ContractAddress,
  learner: Uint8Array,
  cardIds: readonly Uint8Array[],
): Promise<Map<string, PlannedSched>> => {
  const out = new Map<string, PlannedSched>();
  const state = await readLedger(providers, address);
  if (state == null) return out;
  for (const card of cardIds) {
    const key = slotKey(learner, card);
    if (state.sched.member(key)) {
      out.set(bytesToHex(card), fromContractSched(state.sched.lookup(key)));
    }
  }
  return out;
};

/** One learner's schedule for one card, or `null` if they have not started it. */
export const readSchedule = async (
  providers: SrsProviders,
  address: ContractAddress,
  learner: Uint8Array,
  card: Uint8Array,
): Promise<PlannedSched | null> => {
  const state = await readLedger(providers, address);
  if (state == null) return null;
  const key = slotKey(learner, card);
  if (!state.sched.member(key)) return null;
  return fromContractSched(state.sched.lookup(key));
};

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

/**
 * The contract's `Sched` uses `bigint` for every numeric field; the planner's JSON uses
 * `number`. Every field is small — timestamps are ~2^31, intervals under 2^16 — so the
 * conversion is lossless in both directions.
 */
const toContractSched = (s: PlannedSched): Sched => ({
  dueAt: BigInt(s.dueAt),
  intervalDays: BigInt(s.intervalDays),
  ease: BigInt(s.ease),
  reps: BigInt(s.reps),
  lapses: BigInt(s.lapses),
});

const fromContractSched = (s: Sched): PlannedSched => ({
  dueAt: Number(s.dueAt),
  intervalDays: Number(s.intervalDays),
  ease: Number(s.ease),
  reps: Number(s.reps),
  lapses: Number(s.lapses),
});

export const nowSecs = (): number => Math.floor(Date.now() / 1000);

export const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`hex string has an odd length: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

export const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
