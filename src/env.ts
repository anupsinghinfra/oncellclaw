import fs from 'fs';
import path from 'path';
import { log } from './log.js';

/** The install's .env file. On hosted installs this is a symlink into the
 *  durable state dir, so writes survive source-tree swaps. */
export function envFilePath(): string {
  return path.join(process.cwd(), '.env');
}

/**
 * Upsert a `KEY=VALUE` line into an .env file, returning whether the key
 * already existed. THE canonical .env writer — setup/set-env.ts (the CLI
 * path) and the web channel's pairing endpoints (the API path) both call
 * this, so credentials land in exactly one place however they arrive.
 * Never log the value.
 */
export function upsertEnvVar(key: string, value: string, envFile: string = envFilePath()): { existed: boolean } {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(`Invalid env key: ${key} (must be UPPER_SNAKE_CASE)`);
  }
  let content = '';
  if (fs.existsSync(envFile)) {
    content = fs.readFileSync(envFile, 'utf-8');
  }
  const lineRegex = new RegExp(`^${key}=.*$`, 'm');
  const existed = lineRegex.test(content);
  const newLine = `${key}=${value}`;
  if (existed) {
    content = content.replace(lineRegex, newLine);
  } else {
    const sep = content && !content.endsWith('\n') ? '\n' : '';
    content = content + sep + newLine + '\n';
  }
  fs.writeFileSync(envFile, content);
  return { existed };
}

/** Remove a `KEY=...` line from an .env file. Returns whether it existed. */
export function removeEnvVar(key: string, envFile: string = envFilePath()): { existed: boolean } {
  if (!fs.existsSync(envFile)) return { existed: false };
  const content = fs.readFileSync(envFile, 'utf-8');
  const lineRegex = new RegExp(`^${key}=.*\\n?`, 'm');
  if (!lineRegex.test(content)) return { existed: false };
  fs.writeFileSync(envFile, content.replace(lineRegex, ''));
  return { existed: true };
}

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    log.debug('.env file not found, using defaults', { err });
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
