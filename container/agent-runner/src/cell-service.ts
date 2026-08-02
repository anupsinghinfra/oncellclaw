/**
 * OnCell cell service entry point — the cell-side analogue of the docker
 * entrypoint + `--init` + host restart logic.
 *
 * OnCell supervises exactly one service per cell and injects PORT; the
 * preview proxy self-heals by hitting that port. This wrapper:
 *
 *   1. listens on PORT with a tiny liveness endpoint (JSON status), so the
 *      platform's health/self-heal machinery sees a live service even while
 *      the runner is between restarts
 *   2. spawns the agent-runner (index.ts) as a child and restarts it with
 *      exponential backoff when it exits non-zero — including exit 75, the
 *      poll-loop's deliberate "corrupt read view, respawn me" exit that the
 *      docker path handled by host-sweep respawning the container
 *
 * A clean SIGTERM (host stopService) stops the child and exits 0. All host
 * IO still flows through the session DB files — this wrapper never touches
 * them (see src/cell-session-io.ts on the host for the pump).
 */
import { spawn, type ChildProcess } from 'child_process';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const RESTART_BACKOFF_BASE_MS = 1000;
const RESTART_BACKOFF_MAX_MS = 30_000;
/** A child that stayed up this long resets the backoff counter. */
const STABLE_RUN_MS = 5 * 60 * 1000;

function log(msg: string): void {
  console.error(`[cell-service] ${msg}`);
}

const startedAt = Date.now();
let child: ChildProcess | null = null;
let restarts = 0;
let shuttingDown = false;

function runnerEntryPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts');
}

function spawnRunner(): void {
  if (shuttingDown) return;
  const childStartedAt = Date.now();
  child = spawn('bun', ['run', runnerEntryPath()], { stdio: ['ignore', 'inherit', 'inherit'] });
  log(`agent-runner started (pid ${child.pid}, restarts ${restarts})`);

  child.on('exit', (code, signal) => {
    child = null;
    if (shuttingDown) return;
    if (Date.now() - childStartedAt > STABLE_RUN_MS) restarts = 0;
    const backoff = Math.min(RESTART_BACKOFF_BASE_MS * 2 ** restarts, RESTART_BACKOFF_MAX_MS);
    restarts += 1;
    log(`agent-runner exited (code ${code}, signal ${signal}) — restarting in ${backoff}ms`);
    setTimeout(spawnRunner, backoff);
  });
}

function startLivenessServer(): void {
  const port = Number(process.env.PORT || 8080);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'oncellclaw-agent',
        runnerUp: child !== null,
        restarts,
        uptimeMs: Date.now() - startedAt,
      }),
    );
  });
  server.listen(port, () => log(`liveness endpoint on :${port}`));
}

function shutdown(signal: NodeJS.Signals): void {
  shuttingDown = true;
  log(`received ${signal} — stopping agent-runner`);
  const active = child;
  if (!active) {
    process.exit(0);
  } else {
    active.once('exit', () => process.exit(0));
    active.kill('SIGTERM');
    // Hard stop if the runner ignores SIGTERM.
    setTimeout(() => active.kill('SIGKILL'), 5000).unref();
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startLivenessServer();
spawnRunner();
