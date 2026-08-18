/**
 * Network endpoints.
 *
 * The node RPC and indexer are public per-network services. The node entry is the wallet's relay,
 * which submits transactions over a substrate WebSocket connection — so it is `wss://` (`ws://`
 * locally) and not the same origin's `https://` JSON-RPC, which the relay rejects outright.
 *
 * The proof server is always loopback: proving receives the circuit's witness data — the preimage
 * of your pseudonym, your XP total, and the salt that would unmask the on-chain commitment — so it
 * must not leave the machine.
 */
export interface NetworkConfig {
  readonly indexer: string;
  readonly indexerWS: string;
  readonly node: string;
  readonly proofServer: string;
  readonly networkId: string;
}

/** Every network this CLI can target. */
export const ENV_NAMES = ['undeployed', 'preview', 'preprod', 'qanet'] as const;

export type EnvName = (typeof ENV_NAMES)[number];

export const isEnvName = (value: string): value is EnvName => (ENV_NAMES as readonly string[]).includes(value);

const LOCAL_PROOF_SERVER = 'http://127.0.0.1:6300';

/** Hosted networks differ only in hostname, so they are built from one shape. */
const hosted = (name: EnvName): NetworkConfig => ({
  indexer: `https://indexer.${name}.midnight.network/api/v4/graphql`,
  indexerWS: `wss://indexer.${name}.midnight.network/api/v4/graphql/ws`,
  node: `wss://rpc.${name}.midnight.network`,
  proofServer: LOCAL_PROOF_SERVER,
  networkId: name,
});

const NETWORKS: Record<EnvName, NetworkConfig> = {
  // A local stack, for which every service is on loopback.
  undeployed: {
    indexer: 'http://127.0.0.1:8088/api/v4/graphql',
    indexerWS: 'ws://127.0.0.1:8088/api/v4/graphql/ws',
    node: 'ws://127.0.0.1:9944',
    proofServer: LOCAL_PROOF_SERVER,
    networkId: 'undeployed',
  },
  preview: hosted('preview'),
  preprod: hosted('preprod'),
  qanet: hosted('qanet'),
};

export const networkFor = (env: EnvName): NetworkConfig => NETWORKS[env];
