import type { WitnessContext } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import type { Ledger } from '@midnight-srs/contracts';

/**
 * Everything a learner keeps to themselves, for one deck.
 *
 * Built by `deckPrivateState` in `srs.ts` from the learner's keyfile identity. This store is
 * scoped per contract address by the SDK, which is why the identity itself lives outside it —
 * see `identity.ts`.
 *
 * None of this is on-chain. `sk` never leaves the machine, and `xp` exists on-chain only as
 * `commit(xp, xpSalt)` — which is what lets a learner prove a tier without publishing a score.
 *
 * That has a consequence worth stating plainly: **this state is the only copy of the XP
 * total.** The chain holds a commitment, not the value, so there is nothing to recover from
 * if the private-state store is lost — much like losing a wallet key. `reviewCount` on-chain
 * survives, so diligence history is not lost, but the score behind the tier ladder is.
 */
export interface SrsPrivateState {
  /**
   * The dapp secret behind this learner's pseudonym, `persistentHash(["srs:pk:", sk])`.
   *
   * Deliberately unrelated to any wallet key: that is the entire reason on-chain behaviour
   * cannot be linked back to a wallet. Two wallets sharing an `sk` would be *the same
   * learner* as far as the contract is concerned.
   */
  readonly sk: Uint8Array;

  /**
   * Running XP total, in interval-days earned.
   *
   * Must track the on-chain commitment exactly. The contract checks `commit(xp, xpSalt)`
   * against `xpCommit[learner]` before every update, so a stale value here fails the next
   * review rather than silently diverging. {@link applyAward} is the only thing that should
   * change it, and only after a review has finalised.
   */
  readonly xp: bigint;

  /**
   * Blinding factor for the XP commitment.
   *
   * Derived per deck from the keyfile root salt (`deckSalt`), not random, so it is recoverable
   * if this store is lost and so two decks never commit the same total identically.
   */
  readonly xpSalt: Uint8Array;
}

/**
 * Record an award after a review has finalised on-chain.
 *
 * Ordering matters: the contract advances the commitment to `commit(xp + award, salt)` as part
 * of the review, so this must be applied if and only if that transaction succeeded. Applying
 * it early (or twice) desynchronises the witness from the commitment and every later review
 * fails with "XP witness does not match the committed total".
 */
export const applyAward = (state: SrsPrivateState, award: bigint): SrsPrivateState => ({
  ...state,
  xp: state.xp + award,
});

/**
 * The three witnesses the contract declares.
 *
 * All three are pure reads — the contract never asks a witness to mutate state, so there is
 * no write-back path here. The XP total advances through {@link applyAward} after a
 * transaction finalises instead, which is what keeps it consistent with a transaction that
 * failed.
 */
export const srsWitnesses = {
  localSk: ({ privateState }: WitnessContext<Ledger, SrsPrivateState>): [SrsPrivateState, Uint8Array] => [
    privateState,
    privateState.sk,
  ],
  localXp: ({ privateState }: WitnessContext<Ledger, SrsPrivateState>): [SrsPrivateState, bigint] => [
    privateState,
    privateState.xp,
  ],
  localXpSalt: ({ privateState }: WitnessContext<Ledger, SrsPrivateState>): [SrsPrivateState, Uint8Array] => [
    privateState,
    privateState.xpSalt,
  ],
};
