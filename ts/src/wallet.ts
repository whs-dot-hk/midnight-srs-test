import { DustSecretKey, ZswapSecretKeys } from '@midnight-ntwrk/ledger-v8';
import { LedgerParameters } from '@midnight-ntwrk/ledger-v8';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  DustWallet,
  HDWallet,
  InMemoryTransactionHistoryStorage,
  Roles,
  ShieldedWallet,
  UnshieldedWallet,
  WalletEntrySchema,
  WalletFacade,
  PublicKey,
  createKeystore,
  mergeWalletEntries,
  type FacadeState,
  type UnshieldedKeystore,
} from '@midnightntwrk/wallet-sdk';
import * as Rx from 'rxjs';
import type { NetworkConfig } from './network.js';
import { clearSnapshot, readSnapshot, writeSnapshot } from './snapshot.js';

/**
 * A running wallet, plus the keys the providers need.
 *
 * The facade owns three sub-wallets — shielded, unshielded, dust — and is the only thing here that
 * talks to the network. Every key is derived from one seed.
 */
export interface Wallet {
  readonly facade: WalletFacade;
  readonly shieldedSecretKeys: ZswapSecretKeys;
  readonly dustSecretKey: DustSecretKey;
  readonly keystore: UnshieldedKeystore;
  /** Persist the synced state so the next run resumes from it rather than rescanning the chain. */
  readonly persist: (state: FacadeState) => void;
  readonly stop: () => Promise<void>;
}

/** How long to wait for a synced state, or for DUST to appear, before giving up. */
export const SYNC_TIMEOUT_MS = 15 * 60_000;

/**
 * Derive the three keys a wallet needs from a 64-character hex seed.
 *
 * Account zero, key index zero, three roles: `Zswap` for shielded coins, `Dust` for fee capacity,
 * and `NightExternal` for the unshielded signing key. The root material is cleared immediately
 * afterwards so it does not sit in memory for the life of the process.
 */
const deriveKeys = (seed: string, networkId: string) => {
  const bytes = Uint8Array.from(Buffer.from(seed, 'hex'));
  if (bytes.length !== 32) {
    throw new Error(`MN_SEED must be 64 hex characters (32 bytes); got ${bytes.length} bytes`);
  }

  const root = HDWallet.fromSeed(bytes);
  if (root.type !== 'seedOk') {
    throw new Error(`could not derive keys from the seed: ${String(root.error)}`);
  }

  const derived = root.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  root.hdWallet.clear();

  if (derived.type !== 'keysDerived') {
    throw new Error(`key derivation out of bounds for roles ${derived.roles.join(', ')}`);
  }

  return {
    shieldedSecretKeys: ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]),
    dustSecretKey: DustSecretKey.fromSeed(derived.keys[Roles.Dust]),
    keystore: createKeystore(derived.keys[Roles.NightExternal], networkId as never),
  };
};

/** Build and start a wallet against `network`. */
export const buildWallet = async (network: NetworkConfig, seed: string): Promise<Wallet> => {
  // Address encoding reads a process-wide network id; set it before deriving anything.
  setNetworkId(network.networkId as never);

  const keys = deriveKeys(seed, network.networkId);

  // All three sub-wallets take the same configuration shape, so it is built once.
  const configuration = {
    networkId: network.networkId as never,
    indexerClientConnection: { indexerHttpUrl: network.indexer, indexerWsUrl: network.indexerWS },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    relayURL: new URL(network.node),
    provingServerUrl: new URL(network.proofServer),
    costParameters: {
      // How many blocks of fee headroom to allow when balancing. Two is enough to survive a price
      // adjustment between building and submitting a transaction. It is an exponent, so larger
      // values get unreasonable fast.
      feeBlocksMargin: 2,
      // A flat surcharge on every computed fee, and load-bearing rather than cosmetic.
      //
      // The dust balancer works from the *deficit* a transaction has: it selects coins until the
      // fee is covered, and it decides how many to select from `imbalances(0, fee)`. A bare
      // contract call that moves none of the wallet's own coins prices out at a fee of zero
      // before balancing, so there is no deficit, so no coin is selected, so the coverage stays
      // zero — and then the fee for the balancing intent itself (1 SPECK) is compared against
      // that zero coverage. It never converges: `Effect.iterate` spins synchronously, allocating,
      // until the heap gives out. Any nonzero surcharge gives the balancer a deficit to work
      // from on the first pass, and it converges immediately.
      additionalFeeOverhead: 1_000_000n,
    },
  };

  const dustParameters = LedgerParameters.initialParameters().dust;

  // Resume from a snapshot when one exists. A snapshot for a chain that has moved on is rejected by
  // `restore`, in which case it is discarded and this run syncs from scratch — self-healing, so a
  // stale file never needs clearing by hand.
  const snapshot = readSnapshot(network.networkId, seed);
  let resumed = snapshot !== null;

  /** Restore a sub-wallet from its snapshot, falling back to a fresh start if that fails. */
  const resume = <T>(serialized: string | undefined, restore: (s: string) => T, fresh: () => T): T => {
    if (serialized === undefined) return fresh();
    try {
      return restore(serialized);
    } catch {
      resumed = false;
      return fresh();
    }
  };

  const facade = await WalletFacade.init({
    configuration,
    shielded: (config) => {
      const wallet = ShieldedWallet(config);
      return resume(snapshot?.shielded, (x) => wallet.restore(x), () =>
        wallet.startWithSecretKeys(keys.shieldedSecretKeys),
      );
    },
    unshielded: (config) => {
      const wallet = UnshieldedWallet(config);
      return resume(snapshot?.unshielded, (x) => wallet.restore(x), () =>
        wallet.startWithPublicKey(PublicKey.fromKeyStore(keys.keystore)),
      );
    },
    dust: (config) => {
      const wallet = DustWallet(config);
      return resume(snapshot?.dust, (x) => wallet.restore(x), () =>
        wallet.startWithSecretKey(keys.dustSecretKey, dustParameters),
      );
    },
  });

  if (snapshot !== null && !resumed) clearSnapshot(network.networkId, seed);

  await facade.start(keys.shieldedSecretKeys, keys.dustSecretKey);

  return {
    facade,
    shieldedSecretKeys: keys.shieldedSecretKeys,
    dustSecretKey: keys.dustSecretKey,
    keystore: keys.keystore,
    persist: (state) =>
      writeSnapshot(network.networkId, seed, {
        shielded: state.shielded.serialize(),
        unshielded: state.unshielded.serialize(),
        dust: state.dust.serialize(),
      }),
    stop: async () => {
      await facade.stop().catch(() => undefined);
    },
  };
};

/**
 * Wait until the wallet has caught up, and make sure it can pay for transactions.
 *
 * A wallet holding only NIGHT cannot submit anything: fees are paid in DUST, and DUST is generated
 * by NIGHT that has been registered for it. So after syncing, register any unregistered NIGHT and
 * wait for the first DUST to arrive. Both waits are bounded, so a seed with no NIGHT fails with a
 * clear message rather than hanging.
 */
export const awaitReady = async (wallet: Wallet, timeoutMs = SYNC_TIMEOUT_MS): Promise<FacadeState> => {
  const synced = await withTimeout(wallet.facade.waitForSyncedState(), timeoutMs, 'wallet did not finish syncing');

  if (synced.dust.availableCoins.length > 0) {
    wallet.persist(synced);
    return synced;
  }

  const unregistered = synced.unshielded.availableCoins.filter((c) => !c.meta.registeredForDustGeneration);
  if (unregistered.length === 0) {
    throw new Error(
      'this wallet has no DUST and no NIGHT to generate it from — fund the address from the faucet first',
    );
  }

  await registerForDust(wallet, unregistered);

  // DUST accrues over time rather than arriving in one block, so wait for a coin to show up.
  const funded = await withTimeout(
    Rx.firstValueFrom(wallet.facade.state().pipe(Rx.filter((s) => s.dust.availableCoins.length > 0))),
    timeoutMs,
    'registered NIGHT for DUST generation, but no spendable DUST appeared',
  );
  wallet.persist(funded);
  return funded;
};

/** Register NIGHT UTXOs so they generate the DUST that pays for fees. */
const registerForDust = async (
  wallet: Wallet,
  utxos: Parameters<WalletFacade['registerNightUtxosForDustGeneration']>[0],
): Promise<void> => {
  const sign = (payload: Uint8Array) => wallet.keystore.signData(payload);
  const recipe = await wallet.facade.registerNightUtxosForDustGeneration(
    utxos,
    wallet.keystore.getPublicKey(),
    sign,
  );
  const signed = await wallet.facade.signRecipe(recipe, sign);
  await wallet.facade.submitTransaction(await wallet.facade.finalizeRecipe(signed));
};

const withTimeout = async <T>(work: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${message} (waited ${Math.round(ms / 1000)}s)`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
