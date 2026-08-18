import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import type { FinalizedTransaction } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type { MidnightProvider, UnboundTransaction, WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import type { NetworkConfig } from './network.js';
import type { Wallet } from './wallet.js';

/**
 * The provider set midnight-js needs: where to prove, where to read chain state, where to keep
 * private state, and how to pay for and submit a transaction.
 */
export interface ProviderOptions {
  /** Namespace for private state. Distinct per learner, so two identities never share a slot. */
  readonly privateStateStoreName: string;
  /** Directory holding the compiled circuit's prover keys. */
  readonly zkConfigPath: string;
  /** Absolute path for the LevelDB store, so it does not follow the working directory. */
  readonly dbPath: string;
}

/**
 * Adapt the wallet to the two provider interfaces midnight-js expects.
 *
 * `balanceTx` is where a contract call becomes payable: the unbound transaction is balanced against
 * the wallet's coins, signed with the unshielded key, and finalized.
 */
const walletProvider = async (wallet: Wallet): Promise<WalletProvider & MidnightProvider> => {
  const state = await wallet.facade.waitForSyncedState();
  return {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    balanceTx: async (tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> => {
      const recipe = await wallet.facade.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: wallet.shieldedSecretKeys, dustSecretKey: wallet.dustSecretKey },
        // Half an hour is ample: proving takes seconds and the transaction is submitted straight
        // after balancing.
        { ttl: ttl ?? new Date(Date.now() + 30 * 60_000) },
      );
      const signed = await wallet.facade.signRecipe(recipe, (payload) => wallet.keystore.signData(payload));
      return wallet.facade.finalizeRecipe(signed);
    },
    submitTx: (tx: FinalizedTransaction) => wallet.facade.submitTransaction(tx),
  };
};

export const configureProviders = async <PSI extends string, CIRC extends string>(
  wallet: Wallet,
  network: NetworkConfig,
  options: ProviderOptions,
) => {
  const wmp = await walletProvider(wallet);
  const zkConfigProvider = new NodeZkConfigProvider<CIRC>(options.zkConfigPath);

  // The private-state store encrypts at rest and asks for a password per access; the wallet's own
  // coin public key is a stable, per-wallet value to derive one from.
  const accountId = wmp.getCoinPublicKey();
  const storagePassword = `${Buffer.from(accountId, 'hex').toString('base64')}!`;

  return {
    privateStateProvider: levelPrivateStateProvider<PSI>({
      midnightDbName: options.dbPath,
      privateStateStoreName: options.privateStateStoreName,
      accountId,
      privateStoragePasswordProvider: () => storagePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(network.indexer, network.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(network.proofServer, zkConfigProvider),
    walletProvider: wmp,
    midnightProvider: wmp,
  };
};
