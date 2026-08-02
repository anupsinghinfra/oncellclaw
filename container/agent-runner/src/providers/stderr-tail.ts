/**
 * Bounded stderr capture for provider CLI subprocesses.
 *
 * The Claude Agent SDK surfaces a failed CLI spawn as just "Claude Code
 * process exited with code 1" — the process's stderr (the actual reason) is
 * discarded unless the caller registers the SDK's `stderr` callback. Flying
 * blind on exit codes cost a live debugging hour; this tail makes every
 * such failure carry its last stderr bytes.
 *
 * Pure and dependency-free so it is unit-testable outside Bun (the rest of
 * the provider transitively imports bun:sqlite).
 */

export const STDERR_TAIL_MAX_BYTES = 2048;

export interface StderrTail {
  /** SDK `stderr` callback — append a chunk, keeping only the last cap bytes. */
  append(chunk: string): void;
  /** The captured tail, trimmed. Empty string when nothing was captured. */
  tail(): string;
}

export function createStderrTail(capBytes: number = STDERR_TAIL_MAX_BYTES): StderrTail {
  let buffer = '';
  return {
    append(chunk: string): void {
      buffer = (buffer + chunk).slice(-capBytes);
    },
    tail(): string {
      return buffer.trim();
    },
  };
}

/**
 * Re-throwable error enriched with the subprocess's stderr tail. Keeps the
 * original as `cause`; when nothing was captured the original error is
 * returned unchanged (no misleading empty suffix).
 */
export function enrichWithStderr(err: unknown, tail: string): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  if (!tail) return original;
  return new Error(`${original.message} — claude stderr: ${tail}`, { cause: original });
}
