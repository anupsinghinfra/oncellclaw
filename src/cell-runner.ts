/**
 * Cell Runner — runs a NanoClaw agent session in an OnCell cell instead of a
 * local Docker container. Exposes the same surface as container-runner.ts
 * (wake / kill / isRunning / count / package install) so session-manager,
 * router, host-sweep and the modules are unchanged; container-runner
 * dispatches here when the OnCell runtime is selected (see runtime-select.ts).
 *
 * Mapping from the docker path:
 *
 *   docker bind mounts            → incremental door sync (cell-sync.ts):
 *     groups/<folder>  → claw/agent          (RW group memory, durable in cell)
 *     container/CLAUDE.md → claw/app/CLAUDE.md
 *     container/skills/*  → claw/app/skills/*
 *     container/agent-runner → claw/runner   (source + lockfile; bun install in-cell)
 *   session dir bind mount        → bidirectional pump (cell-session-io.ts):
 *     inbound.db/inbox pushed host→cell, outbound.db/.heartbeat/outbox pulled
 *     cell→host, so the host's delivery poll + sweep read local files unchanged
 *   docker run + --rm + restart   → cell service supervisor:
 *     the runner runs under container/agent-runner/src/cell-service.ts as THE
 *     cell service (PORT-listening liveness wrapper, in-cell child restarts);
 *     host-sweep's kill maps to stopService, after which the cell idles to ~$0
 *   OneCLI credential gateway     → service env at start:
 *     Anthropic credentials are passed only in the service env — they are
 *     never written into cell workspace files (cell-sync excludes .env files)
 *
 * One cell per agent group. Sessions of the same group share the cell but run
 * one at a time (the cell has a single service slot): a wake for a second
 * session while another holds the cell returns false, and host-sweep's
 * pending-message retry delivers it once the holder stops.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, ONCELL_API_KEY, ONCELL_API_URL, TIMEZONE } from './config.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { materializeContainerJson, type ContainerConfig } from './container-config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { getContainerConfig } from './db/container-configs.js';
import { readEnvFile } from './env.js';
import { initGroupFilesystem } from './group-init.js';
import { log } from './log.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { isNoAppRunning, type OnCellClient } from './oncell-client.js';
import { applyCellGatewayConfig, isOneCliConfigured } from './cell-gateway.js';
import { cellCustomerIdForGroup, getCellClient } from './cell-runtime.js';
import { syncToCell, type SyncSource } from './cell-sync.js';
import {
  applyHeartbeat,
  cellSessionRoot,
  fetchSessionStatus,
  pullOutboundDb,
  pullOutboxFile,
  pushFileToCell,
} from './cell-session-io.js';
import {
  heartbeatPath,
  inboundDbPath,
  markContainerRunning,
  markContainerStopped,
  outboundDbPath,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const PUMP_INTERVAL_MS = 1500;
const SERVICE_CHECK_EVERY_TICKS = 4;
const MAX_CONSECUTIVE_PUMP_FAILURES = 10;
/** Cell path of the generated service bootstrap script (see buildServiceBootstrapScript). */
export const BOOTSTRAP_SCRIPT_CELL_PATH = 'claw/service-start.sh';

/** Env keys forwarded from host .env/process.env into the cell service env. */
const CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const;

export interface CellSessionHandle {
  sessionId: string;
  agentGroupId: string;
  customerId: string;
  cellId: string;
  timer: NodeJS.Timeout | null;
  ticking: boolean;
  tickCount: number;
  consecutiveFailures: number;
  lastInboundSignature: string;
  pushedInboxFiles: Set<string>;
  pulledOutboxFiles: Set<string>;
  onExitCallbacks: Array<() => void>;
  stopped: boolean;
}

const activeCellSessions = new Map<string, CellSessionHandle>();
/** customerId → sessionId currently holding that group's cell. */
const cellHolders = new Map<string, string>();
const wakePromises = new Map<string, Promise<boolean>>();
/** cellId → absolute cell workspace root (from a one-time `pwd`). */
const cellWorkspaceRoots = new Map<string, string>();

export function getActiveCellSessionCount(): number {
  return activeCellSessions.size;
}

export function isCellSessionRunning(sessionId: string): boolean {
  return activeCellSessions.has(sessionId);
}

/**
 * Wake a cell session. Same contract as wakeContainer: never throws, returns
 * true on success, false on transient failure (host-sweep retries), and
 * dedupes concurrent wakes for the same session.
 */
export function wakeCellSession(session: Session): Promise<boolean> {
  if (activeCellSessions.has(session.id)) return Promise.resolve(true);
  const existing = wakePromises.get(session.id);
  if (existing) return existing;

  const promise = startCellSession(session)
    .catch((err: unknown) => {
      log.warn('wakeCellSession failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

/** Kill a cell session: stop the service, final state pull, mark stopped. */
export function killCellSession(sessionId: string, reason: string, onExit?: () => void): void {
  const handle = activeCellSessions.get(sessionId);
  if (!handle) return;
  if (onExit) handle.onExitCallbacks.push(onExit);

  log.info('Stopping cell session', { sessionId, reason, cellId: handle.cellId });
  void stopCellService(getCellClient(), handle).then(() => finalizeCellSession(handle, reason));
}

async function startCellSession(session: Session): Promise<boolean> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return false;
  }

  const customerId = cellCustomerIdForGroup(agentGroup.folder);
  const holder = cellHolders.get(customerId);
  if (holder && holder !== session.id) {
    log.debug('Cell busy with another session — deferring wake', { sessionId: session.id, holder, customerId });
    return false;
  }

  // Same host-side prep as the docker spawn path: routing refresh,
  // container.json materialization, idempotent group init, CLAUDE.md compose.
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);
  const containerConfig = materializeContainerJson(agentGroup.id);
  initGroupFilesystem(agentGroup, { provider: containerConfig.provider ?? 'claude' });
  composeGroupClaudeMd(agentGroup);
  if (containerConfig.additionalMounts.length > 0) {
    log.warn('additionalMounts are not supported on the OnCell runtime — ignored', { group: agentGroup.folder });
  }

  const client = getCellClient();
  const cell = await client.createCell(customerId);
  if (cell.status === 'paused') {
    await client.resumeCell(cell.cell_id);
  }
  const workspaceAbs = await resolveCellWorkspaceRoot(client, cell.cell_id);

  await syncToCell(client, cell.cell_id, buildSyncSources(agentGroup, containerConfig));
  await stageCellBootstrap(client, cell.cell_id, workspaceAbs);
  await prepareCellSession(client, cell.cell_id, workspaceAbs, containerConfig);
  await client.writeFile(cell.cell_id, 'claw/claude/settings.json', buildCellClaudeSettings(workspaceAbs));

  // Fresh-spawn grace: clear the stale local heartbeat exactly like the
  // docker spawn does, so host-sweep's ceiling check starts from zero.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const handle = createHandle(session, customerId, cell.cell_id);
  await pushSessionInputs(client, handle);

  // OneCLI gateway parity with the docker path: when configured, the vault
  // env replaces raw credentials and a failure aborts the wake (host-sweep
  // retries) — never a silent spawn with open credentials.
  const gatewayEnv = await applyCellGatewayConfig(client, cell.cell_id, workspaceAbs, agentGroup);

  await stopStaleService(client, cell.cell_id);
  await client.startService(
    cell.cell_id,
    buildServiceCmd(workspaceAbs),
    buildServiceEnv(workspaceAbs, containerConfig, gatewayEnv),
  );

  cellHolders.set(customerId, session.id);
  activeCellSessions.set(session.id, handle);
  markContainerRunning(session.id);
  handle.timer = setInterval(() => void runPumpTick(client, handle), PUMP_INTERVAL_MS);
  log.info('Cell session started', { sessionId: session.id, cellId: cell.cell_id, group: agentGroup.folder });
  return true;
}

function createHandle(session: Session, customerId: string, cellId: string): CellSessionHandle {
  return {
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    customerId,
    cellId,
    timer: null,
    ticking: false,
    tickCount: 0,
    consecutiveFailures: 0,
    lastInboundSignature: '',
    pushedInboxFiles: new Set(),
    pulledOutboxFiles: new Set(),
    onExitCallbacks: [],
    stopped: false,
  };
}

/** Sources mirrored into the cell workspace (see file header for the map). */
export function buildSyncSources(agentGroup: AgentGroup, containerConfig: ContainerConfig): SyncSource[] {
  const projectRoot = process.cwd();
  const runnerRoot = path.join(projectRoot, 'container', 'agent-runner');
  const sources: SyncSource[] = [
    { localPath: path.resolve(GROUPS_DIR, agentGroup.folder), cellPath: 'claw/agent' },
    { localPath: path.join(projectRoot, 'container', 'CLAUDE.md'), cellPath: 'claw/app/CLAUDE.md' },
    { localPath: path.join(runnerRoot, 'src'), cellPath: 'claw/runner/src' },
    { localPath: path.join(runnerRoot, 'package.json'), cellPath: 'claw/runner/package.json' },
    { localPath: path.join(runnerRoot, 'bun.lock'), cellPath: 'claw/runner/bun.lock' },
  ];
  for (const skill of selectedSkillNames(containerConfig)) {
    sources.push({
      localPath: path.join(projectRoot, 'container', 'skills', skill),
      cellPath: `claw/app/skills/${skill}`,
    });
  }
  return sources;
}

/**
 * Resolve the group's skill selection to concrete names. Duplicated from
 * container-runner.ts (private there) to avoid a container-runner ↔
 * cell-runner import cycle.
 */
function selectedSkillNames(containerConfig: ContainerConfig): string[] {
  const names =
    containerConfig.skills !== 'all'
      ? containerConfig.skills
      : (() => {
          const sharedSkillsDir = path.join(process.cwd(), 'container', 'skills');
          if (!fs.existsSync(sharedSkillsDir)) return [];
          return fs.readdirSync(sharedSkillsDir).filter((entry) => {
            try {
              return fs.statSync(path.join(sharedSkillsDir, entry)).isDirectory();
            } catch {
              return false;
            }
          });
        })();
  // Posture-aware: the onecli-gateway skill's own description tells the
  // agent it MUST route external-service requests through the vault — on a
  // raw-posture install (no gateway) that leads it to invent dashboards and
  // connect steps. Withhold the skill entirely; the CLAUDE.md compose
  // injects the honest "integrations not connected yet" note instead.
  return isOneCliConfigured() ? names : names.filter((name) => name !== 'onecli-gateway');
}

async function resolveCellWorkspaceRoot(client: OnCellClient, cellId: string): Promise<string> {
  const cached = cellWorkspaceRoots.get(cellId);
  if (cached) return cached;
  const result = await client.exec(cellId, { cmd: 'pwd', timeoutMs: 15_000, expectSuccess: true });
  const root = result.stdout.trim().split('\n')[0];
  if (!root.startsWith('/')) throw new Error(`unexpected cell workspace root: ${root}`);
  cellWorkspaceRoots.set(cellId, root);
  return root;
}

/**
 * Stage the service bootstrap script into the cell (host-side writeFile —
 * no cell network needed). The installs it performs run INSIDE the service,
 * which is the ONLY network-capable context in a cell: exec sandboxes run
 * with --network=none, so the old exec-driven bootstrap (curl bun, npm
 * install) could never succeed on a bare cell — curl doesn't exist and npm
 * black-holes. Idempotency lives in the script itself (marker file), so a
 * warm wake goes straight to the runner.
 */
async function stageCellBootstrap(client: OnCellClient, cellId: string, workspaceAbs: string): Promise<void> {
  log.info('Staging cell service bootstrap', { cellId, marker: bootstrapMarker() });
  await client.writeFile(
    cellId,
    BOOTSTRAP_SCRIPT_CELL_PATH,
    buildServiceBootstrapScript(readClaudeCodeVersion(), bootstrapMarker(), workspaceAbs),
  );
}

/**
 * Bootstrap identity: runner lockfile + pinned claude-code version. A bump
 * of either re-runs the installs on the next wake; anything else hits the
 * marker fast-path.
 */
export function bootstrapMarker(): string {
  const lockPath = path.join(process.cwd(), 'container', 'agent-runner', 'bun.lock');
  const lockStat = fs.statSync(lockPath, { throwIfNoEntry: false });
  return `v2:${lockStat ? `${lockStat.size}:${lockStat.mtimeMs}` : 'nolock'}:claude=${readClaudeCodeVersion() || 'latest'}`;
}

/** Pinned claude-code version from container/cli-tools.json ('' = latest). */
function readClaudeCodeVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), 'container', 'cli-tools.json'), 'utf-8');
    const tools = JSON.parse(raw) as Array<{ name?: string; version?: string }>;
    return tools.find((t) => t.name === '@anthropic-ai/claude-code')?.version ?? '';
  } catch {
    return '';
  }
}

/**
 * The cell service's entry script: self-contained, node-only bootstrap that
 * then execs the bun runner. Design constraints, learned the hard way in
 * production:
 *
 *  - NETWORK: only the service has it. All installs happen here, never in
 *    a host-driven exec. Bun itself comes from npm (`npm i -g bun` ships
 *    platform binaries as optional deps) because there is no curl for
 *    bun.sh's installer.
 *  - READINESS: the supervisor kills a service that isn't accepting
 *    connections on $PORT within ~30s, and a cold install takes minutes —
 *    so a node placeholder binds $PORT first (503 {"ok":false,"phase":
 *    "bootstrap"}) and is killed just before the runner takes over. Same
 *    pattern as scripts/cloud-start.sh on the hosting side.
 *  - OBSERVABILITY: every phase echoes to stdout, which lands in the
 *    cell's /service/logs — the only debugging lifeline in production.
 *  - IDEMPOTENCY: the marker file short-circuits to `exec bun` on warm
 *    wakes; installs land under the workspace ($HOME/.claw-tools, bun's
 *    node_modules), which is durable across service restarts and
 *    pause/resume.
 */
export function buildServiceBootstrapScript(claudeCodeVersion: string, marker: string, workspaceAbs: string): string {
  const claudePkg = claudeCodeVersion ? `@anthropic-ai/claude-code@${claudeCodeVersion}` : '@anthropic-ai/claude-code';
  const npmFlags = '--no-fund --no-audit --loglevel=error';
  return [
    '#!/bin/sh',
    '# oncellclaw agent-cell service bootstrap — generated by src/cell-runner.ts.',
    '# Runs as THE cell service; see buildServiceBootstrapScript for the design.',
    'set -e',
    `cd '${workspaceAbs}'`,
    'TOOLS="$HOME/.claw-tools"',
    'export PATH="$TOOLS/bin:$PATH"',
    `MARKER='${marker}'`,
    'echo "[claw-boot] wake ($(date -u +%Y-%m-%dT%H:%M:%SZ)) marker=$MARKER"',
    '',
    'if [ "$(cat claw/.bootstrap-marker 2>/dev/null)" = "$MARKER" ] \\',
    '  && command -v bun >/dev/null 2>&1 \\',
    '  && command -v claude >/dev/null 2>&1 \\',
    '  && [ -d claw/runner/node_modules ]; then',
    '  echo "[claw-boot] bootstrap current — starting runner"',
    'else',
    '  echo "[claw-boot] bootstrap needed (cold cell, or lockfile/CLI version changed)"',
    '  # Hold $PORT while installing — the supervisor kills a service that',
    '  # is not accepting connections within its readiness window.',
    '  node -e \'require("http").createServer((q,s)=>{s.writeHead(503,{"content-type":"application/json"});s.end("{\\"ok\\":false,\\"phase\\":\\"bootstrap\\"}")}).listen(Number(process.env.PORT||8080),"0.0.0.0")\' &',
    '  placeholder_pid=$!',
    '  echo "[claw-boot] placeholder holding :${PORT:-8080} (pid $placeholder_pid)"',
    '',
    '  echo "[claw-boot] [1/3] installing bun (npm)"',
    `  command -v bun >/dev/null 2>&1 || npm install -g --prefix "$TOOLS" ${npmFlags} bun`,
    '  echo "[claw-boot] [2/3] installing runner dependencies (bun install)"',
    '  (cd claw/runner && bun install)',
    '  echo "[claw-boot] [3/3] installing claude-code CLI (npm)"',
    `  command -v claude >/dev/null 2>&1 || npm install -g --prefix "$TOOLS" ${npmFlags} ${claudePkg}`,
    '  printf \'%s\' "$MARKER" > claw/.bootstrap-marker',
    '  echo "[claw-boot] bootstrap complete"',
    '',
    '  kill "$placeholder_pid" 2>/dev/null || true',
    '  wait "$placeholder_pid" 2>/dev/null || true',
    '  # Give the kernel a beat to release the listener before bun rebinds.',
    '  i=0',
    '  while [ "$i" -lt 5 ]; do',
    '    node -e \'const s=require("net").createServer();s.once("error",()=>process.exit(1));s.listen(Number(process.env.PORT||8080),"0.0.0.0",()=>s.close(()=>process.exit(0)))\' 2>/dev/null && break',
    '    i=$((i+1)); sleep 1',
    '  done',
    'fi',
    '',
    'echo "[claw-boot] exec cell-service (bun $(bun --version 2>/dev/null || echo missing))"',
    `exec bun '${workspaceAbs}/claw/runner/src/cell-service.ts'`,
    '',
  ].join('\n');
}

/**
 * Idempotent per-wake layout prep inside the cell: session dirs, the
 * agent symlink that recreates the docker mount layout, the shared-CLAUDE.md
 * symlink, and skill symlinks under CLAUDE_CONFIG_DIR.
 */
async function prepareCellSession(
  client: OnCellClient,
  cellId: string,
  workspaceAbs: string,
  containerConfig: ContainerConfig,
): Promise<void> {
  const fragments = [
    'mkdir -p claw/session/outbox claw/session/inbox claw/claude/skills claw/agent claw/app/skills',
    'rm -f claw/session/.heartbeat',
    'ln -sfn ../agent claw/session/agent',
    'ln -sfn ../app/CLAUDE.md claw/agent/.claude-shared.md',
    'find claw/claude/skills -maxdepth 1 -type l -exec rm -f {} +',
  ];
  for (const skill of selectedSkillNames(containerConfig)) {
    fragments.push(`ln -sfn '${workspaceAbs}/claw/app/skills/${skill}' 'claw/claude/skills/${skill}'`);
  }
  await client.exec(cellId, { cmd: fragments.join(' && '), timeoutMs: 30_000, expectSuccess: true });
}

/** settings.json for CLAUDE_CONFIG_DIR — group-init defaults with cell paths. */
export function buildCellClaudeSettings(workspaceAbs: string): string {
  return (
    JSON.stringify(
      {
        autoMemoryEnabled: false,
        env: {
          CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        },
        hooks: {
          PreCompact: [
            {
              hooks: [{ type: 'command', command: `bun ${workspaceAbs}/claw/runner/src/compact-instructions.ts` }],
            },
          ],
        },
      },
      null,
      2,
    ) + '\n'
  );
}

function buildServiceCmd(workspaceAbs: string): string {
  // The staged bootstrap script installs whatever is missing (with its own
  // network — the service context is the only one that has any) and execs
  // the bun runner. See buildServiceBootstrapScript.
  return `sh '${workspaceAbs}/${BOOTSTRAP_SCRIPT_CELL_PATH}'`;
}

/**
 * Service env: agent credentials + timezone + path overrides. Credentials
 * come from the host .env (readEnvFile keeps them out of process.env) with a
 * process.env fallback, and travel ONLY here — never into workspace files.
 *
 * With a OneCLI gateway env (docker-parity vault mode) the RAW credentials
 * are withheld: the vault injects them at request time, which is the entire
 * point — an agent that also carried the raw key would make the gateway
 * decorative. The gateway env merges last so its base-url/proxy settings
 * win.
 */
export function buildServiceEnv(
  workspaceAbs: string,
  containerConfig: ContainerConfig,
  gatewayEnv?: Record<string, string> | null,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (!gatewayEnv) {
    const fromEnvFile = readEnvFile([...CREDENTIAL_ENV_KEYS]);
    for (const key of CREDENTIAL_ENV_KEYS) {
      const value = process.env[key] || fromEnvFile[key];
      if (value) env[key] = value;
    }
  }
  return {
    ...env,
    TZ: containerConfig.timezone ?? TIMEZONE,
    NANOCLAW_WORKSPACE_ROOT: `${workspaceAbs}/claw/session`,
    CLAUDE_CONFIG_DIR: `${workspaceAbs}/claw/claude`,
    NANOCLAW_CELL: '1',
    // OnCell-native integrations (oncell-integrations skill): the agent
    // calls the credential-injecting proxy with the same developer key that
    // runs its cell. Env-only, like every other credential here.
    ...(ONCELL_API_KEY ? { ONCELL_API_KEY, ONCELL_API_URL: ONCELL_API_URL || 'https://api.oncell.ai' } : {}),
    ...(gatewayEnv ?? {}),
  };
}

/** Stop a service left over from a crash/restart (503 NO_APP_RUNNING is fine). */
async function stopStaleService(client: OnCellClient, cellId: string): Promise<void> {
  try {
    const service = await client.getService(cellId);
    if (service.running) {
      log.warn('Stale cell service found — stopping before restart', { cellId });
      await client.stopService(cellId);
    }
  } catch (err: unknown) {
    if (!isNoAppRunning(err)) throw err;
  }
}

/** Push inbound.db (when changed, no journal mid-write) and new inbox files. */
async function pushSessionInputs(client: OnCellClient, handle: CellSessionHandle): Promise<void> {
  const localInbound = inboundDbPath(handle.agentGroupId, handle.sessionId);
  const stat = fs.statSync(localInbound, { throwIfNoEntry: false });
  if (stat && !fs.existsSync(`${localInbound}-journal`)) {
    const signature = `${stat.mtimeMs}:${stat.size}`;
    if (signature !== handle.lastInboundSignature) {
      await pushFileToCell(client, handle.cellId, localInbound, `${cellSessionRoot()}/inbound.db`);
      handle.lastInboundSignature = signature;
    }
  }

  const inboxDir = path.join(sessionDir(handle.agentGroupId, handle.sessionId), 'inbox');
  for (const relPath of listFilesRecursive(inboxDir)) {
    if (handle.pushedInboxFiles.has(relPath)) continue;
    await pushFileToCell(client, handle.cellId, path.join(inboxDir, relPath), `${cellSessionRoot()}/inbox/${relPath}`);
    handle.pushedInboxFiles.add(relPath);
  }
}

function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const files: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current)) {
      const full = path.join(current, entry);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) walk(full, `${prefix}${entry}/`);
      else if (stat.isFile()) files.push(`${prefix}${entry}`);
    }
  };
  walk(dir, '');
  return files;
}

/** One pump tick. Exported (underscored) for tests with a fake client. */
export async function _runPumpTickForTesting(client: OnCellClient, handle: CellSessionHandle): Promise<void> {
  return pumpTickBody(client, handle);
}

async function runPumpTick(client: OnCellClient, handle: CellSessionHandle): Promise<void> {
  if (handle.ticking || handle.stopped) return;
  handle.ticking = true;
  try {
    await pumpTickBody(client, handle);
    handle.consecutiveFailures = 0;
  } catch (err: unknown) {
    handle.consecutiveFailures += 1;
    log.warn('Cell pump tick failed', { sessionId: handle.sessionId, failures: handle.consecutiveFailures, err });
    if (handle.consecutiveFailures >= MAX_CONSECUTIVE_PUMP_FAILURES) {
      finalizeCellSession(handle, 'pump failures');
    }
  } finally {
    handle.ticking = false;
  }
}

async function pumpTickBody(client: OnCellClient, handle: CellSessionHandle): Promise<void> {
  handle.tickCount += 1;

  await pushSessionInputs(client, handle);

  const status = await fetchSessionStatus(client, handle.cellId, cellSessionRoot());
  if (!status.missing) {
    if (status.outboundStaged) {
      await pullOutboundDb(
        client,
        handle.cellId,
        cellSessionRoot(),
        outboundDbPath(handle.agentGroupId, handle.sessionId),
      );
    }
    applyHeartbeat(heartbeatPath(handle.agentGroupId, handle.sessionId), status.heartbeatEpochSec);
    await syncOutbox(client, handle, status.outboxFiles);
  }

  // Periodic service liveness: a stopped/crashed service is the analogue of
  // the docker container 'close' event.
  if (handle.tickCount % SERVICE_CHECK_EVERY_TICKS === 0) {
    const running = await isServiceRunning(client, handle.cellId);
    if (!running) {
      log.info('Cell service exited', { sessionId: handle.sessionId, cellId: handle.cellId });
      finalizeCellSession(handle, 'service exited');
    }
  }
}

async function isServiceRunning(client: OnCellClient, cellId: string): Promise<boolean> {
  try {
    return (await client.getService(cellId)).running;
  } catch (err: unknown) {
    if (isNoAppRunning(err)) return false;
    throw err;
  }
}

/** Pull new outbox files; delete cell copies once delivered locally. */
async function syncOutbox(client: OnCellClient, handle: CellSessionHandle, outboxFiles: string[]): Promise<void> {
  const localSession = sessionDir(handle.agentGroupId, handle.sessionId);
  for (const relPath of outboxFiles) {
    if (handle.pulledOutboxFiles.has(relPath)) continue;
    await pullOutboxFile(client, handle.cellId, cellSessionRoot(), relPath, localSession);
    handle.pulledOutboxFiles.add(relPath);
  }

  // Local outbox dirs are removed by clearOutbox() after delivery — mirror
  // the deletion into the cell so its outbox doesn't grow forever.
  const deliveredDirs = new Set<string>();
  for (const relPath of handle.pulledOutboxFiles) {
    if (!fs.existsSync(path.join(localSession, relPath))) {
      const parts = relPath.split('/');
      if (parts.length >= 2 && parts[0] === 'outbox') deliveredDirs.add(`${parts[0]}/${parts[1]}`);
      handle.pulledOutboxFiles.delete(relPath);
    }
  }
  if (deliveredDirs.size > 0) {
    const rms = [...deliveredDirs].map((d) => `rm -rf '${cellSessionRoot()}/${d.replace(/'/g, '')}'`).join(' && ');
    await client.exec(handle.cellId, { cmd: rms, timeoutMs: 30_000 });
  }
}

async function stopCellService(client: OnCellClient, handle: CellSessionHandle): Promise<void> {
  try {
    await client.stopService(handle.cellId);
  } catch (err: unknown) {
    if (!isNoAppRunning(err)) {
      log.warn('Failed to stop cell service', { cellId: handle.cellId, err });
    }
  }
}

/** Tear down host-side state for a session (docker 'close' analogue). */
function finalizeCellSession(handle: CellSessionHandle, reason: string): void {
  if (handle.stopped) return;
  handle.stopped = true;
  if (handle.timer) clearInterval(handle.timer);
  activeCellSessions.delete(handle.sessionId);
  if (cellHolders.get(handle.customerId) === handle.sessionId) {
    cellHolders.delete(handle.customerId);
  }
  markContainerStopped(handle.sessionId);
  stopTypingRefresh(handle.sessionId);
  log.info('Cell session stopped', { sessionId: handle.sessionId, reason });
  for (const cb of handle.onExitCallbacks.splice(0)) {
    try {
      cb();
    } catch (err: unknown) {
      log.error('Cell session onExit callback threw', { sessionId: handle.sessionId, err });
    }
  }
}

/**
 * OnCell analogue of buildAgentGroupImage: install the group's configured
 * apt/npm packages directly in the cell (there is no image to derive).
 */
export async function installCellPackages(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');
  const configRow = getContainerConfig(agentGroupId);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  // HONESTY GUARD (OnCell runtime): cell exec sandboxes have NO network, so
  // apt/npm installs over exec black-hole for minutes and then die with an
  // opaque gateway timeout (the old implementation did exactly that — see
  // git history for the exec-based body). Until installs run through the
  // service pattern (like the runner bootstrap in
  // buildServiceBootstrapScript), fail fast with a message the agent can
  // relay verbatim instead of hanging the approval flow.
  log.warn('Cell package install refused — exec has no network on cells', {
    agentGroupId,
    apt: aptPackages,
    npm: npmPackages,
  });
  throw new Error(
    'Package installs are not yet supported on the hosted (OnCell) runtime — coming soon. ' +
      'Tell the user their package request is noted but cannot be installed in this deployment yet.',
  );
}

/** Test seam: clear module-level session registries. */
export function _resetCellRunnerForTesting(): void {
  for (const handle of activeCellSessions.values()) {
    if (handle.timer) clearInterval(handle.timer);
  }
  activeCellSessions.clear();
  cellHolders.clear();
  wakePromises.clear();
  cellWorkspaceRoots.clear();
}

/** Test seam: register a fake handle (returned so tests can drive the pump). */
export function _createHandleForTesting(session: Session, customerId: string, cellId: string): CellSessionHandle {
  return createHandle(session, customerId, cellId);
}
