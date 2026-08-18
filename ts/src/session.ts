import path from 'node:path';
import { loadEnvFile } from './env.js';
import { identityName, loadOrCreateIdentity, type LearnerIdentity } from './identity.js';
import { isEnvName, networkFor, type EnvName, type NetworkConfig } from './network.js';
import { configureProviders } from './providers.js';
import type { SrsCircuits, SrsProviders } from './srs.js';
import { projectRoot } from './state.js';
import { awaitReady, buildWallet, type Wallet } from './wallet.js';

/** Everything one CLI invocation needs: a synced wallet, providers, and the learner identity. */
export interface Session {
  readonly env: EnvName;
  readonly network: NetworkConfig;
  readonly wallet: Wallet;
  readonly providers: SrsProviders;
  readonly zkConfigPath: string;
  /**
   * The learner's stable identity, from a keyfile.
   *
   * Deliberately not the contract's private state: that store is scoped per contract address and
   * throws until an address is set, so it cannot hold anything needed before a deck is known.
   */
  readonly identity: LearnerIdentity;
  readonly stop: () => Promise<void>;
}

const PRIVATE_STATE_ID = 'srsPrivateState' as const;

/** Where `compact compile` writes this contract's prover keys and verifier data. */
export const zkConfigPath = (): string => path.join(projectRoot(), 'contracts', 'src', 'managed', 'srs');

/**
 * Read `MN_ENV` and `MN_SEED`, then bring up a wallet and providers.
 *
 * State locations are anchored to the project rather than the working directory. A cwd-relative
 * path would otherwise differ depending on where the command was run from, which surfaces much
 * later as a review failing because the XP witness no longer matches the on-chain commitment.
 */
export const openSession = async (): Promise<Session> => {
  const envName = process.env.MN_ENV ?? 'preview';
  if (!isEnvName(envName)) {
    throw new Error(`MN_ENV=${envName} is not a known network`);
  }

  // Seeds normally live in `.env.<network>`; real environment variables take precedence so CI can
  // inject them without the file existing.
  const envFile = loadEnvFile(envName);

  const seed = process.env.MN_SEED;
  if (seed === undefined || seed === '') {
    throw new Error(
      `MN_SEED is required (a 64-character hex seed for a funded, DUST-registered wallet). ` +
        `Set it in the environment or in .env.${envName}` +
        `${envFile === null ? ` (no such file yet — copy .env.preview.example)` : ` (read ${envFile})`}.`,
    );
  }

  const network = networkFor(envName);
  const wallet = await buildWallet(network, seed);
  await awaitReady(wallet);

  // The private-state store is keyed by wallet, so two identities on one wallet would otherwise
  // share a slot and overwrite each other's secret and XP total. Namespace it by identity.
  const who = identityName();
  const providers = (await configureProviders<typeof PRIVATE_STATE_ID, SrsCircuits>(wallet, network, {
    privateStateStoreName: who === 'default' ? 'srs-private-state' : `srs-private-state-${who}`,
    zkConfigPath: zkConfigPath(),
    dbPath: path.join(projectRoot(), 'midnight-level-db'),
  })) as unknown as SrsProviders;

  return {
    env: envName,
    network,
    wallet,
    providers,
    zkConfigPath: zkConfigPath(),
    identity: loadOrCreateIdentity(),
    stop: wallet.stop,
  };
};
