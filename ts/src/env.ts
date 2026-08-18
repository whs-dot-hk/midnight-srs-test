import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load `.env.<network>` from the project root, if present.
 *
 * Hand-rolled rather than pulling in `dotenv`: the format this needs is a handful of
 * `KEY=value` lines, and a seed file is not somewhere to add a dependency casually.
 *
 * Real environment variables always win, so `MN_SEED=… node …` overrides the file and CI can
 * supply secrets without one existing at all.
 */
export const loadEnvFile = (network: string): string | null => {
  const file = path.join(projectRoot(), `.env.${network}`);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`could not read ${file}: ${(cause as Error).message}`, { cause });
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip one layer of matching quotes, so a mnemonic with spaces can be quoted.
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value[0]!)) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return file;
};

const projectRoot = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/ -> ts/ -> project root
  return path.resolve(here, '..', '..');
};
