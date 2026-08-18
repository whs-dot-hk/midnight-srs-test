import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { projectRoot } from './state.js';

/**
 * A serialized wallet state, so a later run resumes from a checkpoint instead of scanning the chain
 * from the beginning. Without this every command pays a full sync, which is minutes rather than
 * seconds.
 *
 * The three sub-wallets serialize independently, so all three strings are needed to restore.
 */
export interface Snapshot {
  readonly shielded: string;
  readonly unshielded: string;
  readonly dust: string;
}

/**
 * Snapshots hold coin and UTXO data — no secret keys, which are always supplied fresh from the seed
 * — but they still describe someone's holdings. Written `0600` under a gitignored directory.
 */
const FILE_MODE = 0o600;

const dir = (): string => path.join(projectRoot(), '.cache', 'wallet-state');

/**
 * One file per (network, wallet).
 *
 * Named by network plus the first and last eight characters of the seed: enough to say *which*
 * wallet on *which* network is cached, without writing the seed itself to disk.
 */
const file = (networkId: string, seed: string): string =>
  path.join(dir(), `${networkId.replace(/[^a-z0-9_-]/gi, '_')}-${seed.slice(0, 8)}-${seed.slice(-8)}.gz`);

/** Read the snapshot for this wallet, or `null` if there is none or it is unreadable. */
export const readSnapshot = (networkId: string, seed: string): Snapshot | null => {
  const target = file(networkId, seed);
  if (!existsSync(target)) return null;
  try {
    const parsed = JSON.parse(gunzipSync(readFileSync(target)).toString('utf8')) as Partial<Snapshot>;
    if (typeof parsed.shielded !== 'string' || typeof parsed.unshielded !== 'string' || typeof parsed.dust !== 'string') {
      return null;
    }
    return { shielded: parsed.shielded, unshielded: parsed.unshielded, dust: parsed.dust };
  } catch {
    // A corrupt or half-written snapshot is not worth failing over — sync from scratch instead.
    return null;
  }
};

/**
 * Write the snapshot, replacing any previous one.
 *
 * Written to a temporary file and renamed, so an interrupted write cannot leave a half-file that
 * the next run would have to detect and discard.
 */
export const writeSnapshot = (networkId: string, seed: string, snapshot: Snapshot): void => {
  const target = file(networkId, seed);
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8')), { mode: FILE_MODE });
  renameSync(temporary, target);
};

/** Discard the snapshot, so the next run syncs from scratch. */
export const clearSnapshot = (networkId: string, seed: string): void => {
  try {
    unlinkSync(file(networkId, seed));
  } catch {
    // Already absent.
  }
};
