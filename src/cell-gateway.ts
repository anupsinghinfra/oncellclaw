/**
 * OneCLI gateway on the OnCell runtime — the cell analogue of the docker
 * path's `onecli.applyContainerConfig` (src/container-runner.ts).
 *
 * On docker, every agent container is spawned behind the OneCLI Agent
 * Vault: `applyContainerConfig` injects the gateway env (proxy/base-url),
 * bind-mounts the interception CA and any credential stubs, and the spawn
 * REFUSES to proceed when the gateway can't be applied — agents never hold
 * raw API keys. The cell runtime shipped without any of this: raw
 * credentials rode the service env.
 *
 * This module restores parity where OneCLI is configured:
 *
 *   docker mechanism                 cell mechanism
 *   ──────────────────────────       ──────────────────────────────────────
 *   -e KEY=VALUE per env entry   →   merged into the service env (env-only
 *                                    rule preserved — nothing on disk)
 *   CA bind-mount at              →  CA written to claw/onecli/ca.pem via
 *   caCertificateContainerPath       the request door; every env value
 *                                    naming the container path is remapped
 *   credential-stub bind-mounts   →  stub content written under
 *                                    claw/onecli/stubs/… (container HOME
 *                                    prefixes remapped to the cell
 *                                    workspace); env values remapped
 *   refuse-to-spawn on failure    →  the wake throws (host-sweep retries),
 *                                    identical failure semantics
 *
 * When OneCLI is NOT configured (no ONECLI_URL and no ONECLI_API_KEY) the
 * cell path keeps its raw-credential behavior — hosted claws don't have a
 * gateway yet, and hard-requiring one would take them down. The mode is
 * logged once per boot so the posture is visible.
 */
import { ONECLI_API_KEY, ONECLI_URL } from './config.js';
import { log } from './log.js';
import type { OnCellClient } from './oncell-client.js';
import type { AgentGroup } from './types.js';

/** Cell-side landing spots (workspace-relative for the request door). */
export const CELL_CA_PATH = 'claw/onecli/ca.pem';
export const CELL_STUBS_DIR = 'claw/onecli/stubs';

/** Container HOME prefixes remapped into the cell workspace (cell HOME). */
const CONTAINER_HOME_PREFIXES = ['/home/node', '/root', '/home/user'];

export interface GatewayContainerConfig {
  env: Record<string, string>;
  caCertificate: string;
  caCertificateContainerPath: string;
  credentialStubs?: Array<{ containerPath: string; content: string }>;
}

/** The two OneCLI SDK calls this module needs — injectable for tests. */
export interface GatewayClient {
  ensureAgent(input: { name: string; identifier: string }): Promise<unknown>;
  getContainerConfig(options: { agent: string }): Promise<GatewayContainerConfig>;
}

let injectedGateway: GatewayClient | null | undefined;
let loggedRawMode = false;

/** Test seam: inject a fake gateway client (undefined resets to real). */
export function _setGatewayClientForTesting(client: GatewayClient | null | undefined): void {
  injectedGateway = client;
  loggedRawMode = false;
}

let configuredOverride: boolean | undefined;

/** Test seam: force the configured/raw posture (undefined resets). */
export function _setOneCliConfiguredForTesting(value: boolean | undefined): void {
  configuredOverride = value;
}

export function isOneCliConfigured(): boolean {
  return configuredOverride ?? Boolean(ONECLI_URL || ONECLI_API_KEY);
}

async function resolveGatewayClient(): Promise<GatewayClient> {
  if (injectedGateway) return injectedGateway;
  // Deferred import: the SDK reads config at construction, and cell-only
  // installs without OneCLI never need it loaded.
  const { OneCLI } = await import('@onecli-sh/sdk');
  return new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY }) as unknown as GatewayClient;
}

/** Remap a docker-container path to its cell-workspace equivalent. */
export function remapStubPath(containerPath: string, workspaceAbs: string): string {
  for (const prefix of CONTAINER_HOME_PREFIXES) {
    if (containerPath === prefix || containerPath.startsWith(`${prefix}/`)) {
      return `${workspaceAbs}${containerPath.slice(prefix.length)}`;
    }
  }
  // Anywhere else on the docker rootfs has no cell equivalent (the cell
  // rootfs is shared and must not be written) — land it under the stubs
  // dir, flattened, and remap env references to match.
  const flat = containerPath.replace(/^\/+/, '').replace(/\//g, '_');
  return `${workspaceAbs}/${CELL_STUBS_DIR}/${flat}`;
}

/** Workspace-relative form for the request door (which roots at the workspace). */
function doorPath(absolutePath: string, workspaceAbs: string): string {
  return absolutePath.startsWith(`${workspaceAbs}/`) ? absolutePath.slice(workspaceAbs.length + 1) : absolutePath;
}

/**
 * Apply the OneCLI gateway to a group cell before its service starts.
 *
 * Returns the gateway env to merge into the service env, or null when
 * OneCLI is not configured (raw-credential mode). Throws when OneCLI IS
 * configured but the gateway can't be applied — the wake fails and
 * host-sweep retries, exactly like the docker path's refusal to spawn.
 */
export async function applyCellGatewayConfig(
  client: OnCellClient,
  cellId: string,
  workspaceAbs: string,
  agentGroup: AgentGroup,
): Promise<Record<string, string> | null> {
  if (!isOneCliConfigured() && !injectedGateway) {
    if (!loggedRawMode) {
      loggedRawMode = true;
      log.info('OneCLI gateway not configured — cell services receive raw agent credentials', {
        hint: 'set ONECLI_URL/ONECLI_API_KEY to route agent traffic through the vault',
      });
    }
    return null;
  }

  const gateway = await resolveGatewayClient();
  await gateway.ensureAgent({ name: agentGroup.name, identifier: agentGroup.id });
  const config = await gateway.getContainerConfig({ agent: agentGroup.id });

  // CA + stubs land in the cell workspace via the request door (host-side
  // push — no cell network involved, same transport as workspace sync).
  const cellCaAbs = `${workspaceAbs}/${CELL_CA_PATH}`;
  await client.writeFile(cellId, CELL_CA_PATH, config.caCertificate);

  const pathRemaps = new Map<string, string>([[config.caCertificateContainerPath, cellCaAbs]]);
  for (const stub of config.credentialStubs ?? []) {
    const cellAbs = remapStubPath(stub.containerPath, workspaceAbs);
    pathRemaps.set(stub.containerPath, cellAbs);
    await client.writeFile(cellId, doorPath(cellAbs, workspaceAbs), stub.content);
  }

  // Gateway env with every docker-container path rewritten to its cell
  // location, plus the CA handed to Node explicitly (docker relied on the
  // system trust store at caCertificateContainerPath; cells cannot).
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(config.env)) {
    let remapped = value;
    for (const [from, to] of pathRemaps) {
      remapped = remapped.split(from).join(to);
    }
    env[key] = remapped;
  }
  env.NODE_EXTRA_CA_CERTS ??= cellCaAbs;

  log.info('OneCLI gateway applied to cell', { cellId, agentGroupId: agentGroup.id });
  return env;
}
