import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isEnvName, networkFor } from './network.js';
import { projectRoot } from './state.js';

/**
 * Preconditions for running against a network, each with the exact command that fixes it.
 *
 * This exists because every one of these has already cost real debugging time. The stale-binary
 * check in particular encodes a bug that reached a live network: `planner.ts` runs
 * `target/release/srs-plan`, `cargo test` builds only the debug binary, and the resulting stale
 * scheduler wrote a due date twelve minutes into the future. Nothing announced it — the review
 * simply refused. It is a checkable condition, so it is checked.
 */
export interface Check {
  readonly name: string;
  readonly ok: boolean;
  /** What was found. */
  readonly detail: string;
  /** Present when `ok` is false: the command or edit that resolves it. */
  readonly fix?: string;
}

export const runChecks = async (): Promise<Check[]> => {
  const checks: Check[] = [nodeVersion(), zkKeys(), plannerBinary(), seed()];
  checks.push(await proofServer());
  return checks;
};

/** `true` when every check passed. */
export const allPassed = (checks: readonly Check[]): boolean => checks.every((c) => c.ok);

const nodeVersion = (): Check => {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  return {
    name: 'node 22+',
    ok: major >= 22,
    detail: `found ${process.version}`,
    ...(major >= 22 ? {} : { fix: 'install Node 22 or newer (the wallet SDK requires it)' }),
  };
};

const zkKeys = (): Check => {
  const dir = path.join(projectRoot(), 'contracts', 'src', 'managed', 'srs', 'keys');
  let count = 0;
  try {
    count = readdirSync(dir).length;
  } catch {
    count = 0;
  }
  // Nine circuits, a prover and a verifier key each.
  const ok = count >= 18;
  return {
    name: 'contract zk keys',
    ok,
    detail: ok ? `${count} key files` : count === 0 ? 'not compiled' : `only ${count} key files (expected 18)`,
    ...(ok ? {} : { fix: 'yarn compact   # compiles 9 circuits with ZK keys; takes several minutes' }),
  };
};

const plannerBinary = (): Check => {
  const bin = process.env.SRS_PLAN_BIN ?? path.join(projectRoot(), 'target', 'release', 'srs-plan');
  let builtAt: number;
  try {
    builtAt = statSync(bin).mtimeMs;
  } catch {
    return {
      name: 'srs-plan binary',
      ok: false,
      detail: 'missing',
      fix: 'yarn core   # cargo build --release',
    };
  }

  const newestSource = newestMtime(path.join(projectRoot(), 'crates'));
  if (newestSource !== null && newestSource > builtAt) {
    const behind = Math.round((newestSource - builtAt) / 1000);
    return {
      name: 'srs-plan binary',
      ok: false,
      detail: `stale — Rust sources are ${behind}s newer than the release build`,
      // The failure this prevents is silent: a stale scheduler proposes schedules under old
      // rules, and the only symptom is a refusal that names the wrong cause.
      fix: 'yarn core   # rebuild; `cargo test` alone only builds the debug binary',
    };
  }
  return { name: 'srs-plan binary', ok: true, detail: 'present and newer than sources' };
};

const seed = (): Check => {
  const envName = process.env.MN_ENV ?? 'preview';
  if (!isEnvName(envName)) {
    return {
      name: 'wallet seed',
      ok: false,
      detail: `MN_ENV=${envName} is not a known network`,
      fix: 'set MN_ENV to one of: undeployed, preview, preprod, qanet',
    };
  }

  if (process.env.MN_SEED !== undefined && process.env.MN_SEED !== '') {
    return { name: 'wallet seed', ok: true, detail: 'MN_SEED set in the environment' };
  }

  const file = path.join(projectRoot(), `.env.${envName}`);
  let contents: string;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    return {
      name: 'wallet seed',
      ok: false,
      detail: `no MN_SEED, and .env.${envName} does not exist`,
      fix: `cp .env.${envName}.example .env.${envName}   # then set MN_SEED to a funded 64-hex seed`,
    };
  }

  const line = contents.split('\n').find((l) => l.trim().startsWith('MN_SEED='));
  const value = line?.slice(line.indexOf('=') + 1).trim() ?? '';
  const looksReal = /^[0-9a-fA-F]{64}$/.test(value);
  return {
    name: 'wallet seed',
    ok: looksReal,
    detail: looksReal ? `64-hex seed in .env.${envName}` : `.env.${envName} has no usable MN_SEED`,
    ...(looksReal ? {} : { fix: `set MN_SEED in .env.${envName} to a funded, DUST-registered 64-hex seed` }),
  };
};

const proofServer = async (): Promise<Check> => {
  const envName = process.env.MN_ENV ?? 'preview';
  const url = isEnvName(envName) ? networkFor(envName).proofServer : 'http://127.0.0.1:6300';
  try {
    // Short timeout: this is a local container either listening or not.
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    const ok = response.ok;
    return {
      name: 'proof server',
      ok,
      detail: ok ? `reachable at ${url}` : `${url} answered ${response.status}`,
      ...(ok ? {} : { fix: dockerHint }),
    };
  } catch {
    return {
      name: 'proof server',
      ok: false,
      // Worth spelling out: the node and indexer are remote, but proving is always local.
      detail: `not reachable at ${url}`,
      fix: dockerHint,
    };
  }
};

const dockerHint =
  'docker run -d --name srs-proof-server -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:8.1.0';

/** Newest mtime under a directory tree, or `null` if it cannot be read. */
const newestMtime = (dir: string): number | null => {
  let newest: number | null = null;
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'target' || entry.name === 'node_modules') continue;
        walk(full);
      } else {
        try {
          const { mtimeMs } = statSync(full);
          if (newest === null || mtimeMs > newest) newest = mtimeMs;
        } catch {
          // Unreadable file: not worth failing the check over.
        }
      }
    }
  };
  walk(dir);
  return newest;
};
