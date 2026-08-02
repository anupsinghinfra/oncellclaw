/**
 * OnCell cell runtime for oncellclaw — the cell-side counterpart of
 * container-runtime.ts. One OnCell cell per agent group.
 *
 * CELL NAMING — two structurally distinct namespaces in one account:
 *
 *   claw-*                       hosting cells. The dashboard runs each
 *                                hosted oncellclaw INSTANCE inside a cell it
 *                                names `claw-{slug}`. This process may be
 *                                running INSIDE one of these. Never created,
 *                                stopped, or otherwise touched here.
 *   clawg-{namespace}-{group}    agent-GROUP cells owned by one oncellclaw
 *                                instance. `namespace` isolates instances
 *                                sharing an account (two users' claws both
 *                                having a group "assistant" must not share a
 *                                cell); `group` is the agent group folder.
 *                                (The API derives the full cell id as
 *                                `{developerId}--{customer_id}`.)
 *
 * The namespace comes from ONCELLCLAW_CELL_NAMESPACE (hosted: set by the
 * dashboard, unique per instance) and defaults to this install's slug
 * (sha1 of the checkout path — stable per install, distinct per checkout).
 *
 * The runtime-readiness and orphan-cleanup semantics mirror the docker
 * runtime: fail fast at startup when the runtime is unreachable, and stop
 * agent services left running by a previous host process (the host lost its
 * in-memory active map, and a stale runner service must not keep writing
 * outbound.db while a new one is started). Cleanup is scoped to THIS
 * instance's namespace — never bare `claw-*` (that would kill our own
 * hosting cell and every other user's), never a sibling namespace.
 */
import { INSTALL_SLUG, ONCELL_API_KEY, ONCELL_API_URL, ONCELLCLAW_CELL_NAMESPACE } from './config.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { log } from './log.js';
import { createOnCellClient, isNoAppRunning, type CellRecord, type OnCellClient } from './oncell-client.js';

/** Prefix of agent-group cells (followed by `{namespace}-{group}`). */
export const CELL_GROUP_PREFIX = 'clawg-';

/**
 * The pre-namespace group-cell prefix — ALSO the prefix the dashboard uses
 * for instance HOSTING cells. Only ever used read-only here (legacy-cell
 * detection); nothing under it is ever stopped or created.
 */
export const LEGACY_CELL_CUSTOMER_PREFIX = 'claw-';

const NAMESPACE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAMESPACE_LEN = 24;
/** Conservative ceiling for customer_id length (the API does not document
 *  one; stay well under typical identifier limits). */
const MAX_CUSTOMER_ID_LEN = 40;

let sharedClient: OnCellClient | null = null;
let cachedNamespace: string | null = null;

/** Lazily construct the shared client. Throws when ONCELL_API_KEY is absent. */
export function getCellClient(): OnCellClient {
  if (sharedClient) return sharedClient;
  sharedClient = createOnCellClient({
    apiKey: ONCELL_API_KEY,
    ...(ONCELL_API_URL ? { baseUrl: ONCELL_API_URL } : {}),
  });
  return sharedClient;
}

/** Test seam: inject a fake client (pass null to reset). */
export function _setCellClientForTesting(client: OnCellClient | null): void {
  sharedClient = client;
}

/**
 * Validate/derive the instance namespace. Pure — the module-level cache is
 * getCellNamespace(). Invalid configuration throws rather than falling back:
 * a hosted instance silently using the wrong namespace is exactly the
 * cross-instance collision this exists to prevent.
 */
export function resolveCellNamespace(
  raw: string = ONCELLCLAW_CELL_NAMESPACE,
  installSlug: string = INSTALL_SLUG,
): string {
  const value = raw.trim().toLowerCase();
  if (!value) return installSlug.slice(0, MAX_NAMESPACE_LEN);
  if (value.length > MAX_NAMESPACE_LEN) {
    throw new Error(`ONCELLCLAW_CELL_NAMESPACE is too long (${value.length} > ${MAX_NAMESPACE_LEN} chars): ${value}`);
  }
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new Error(
      `ONCELLCLAW_CELL_NAMESPACE must be kebab-case ([a-z0-9] groups separated by single dashes): ${raw}`,
    );
  }
  return value;
}

/** This instance's effective cell namespace (validated once, then cached). */
export function getCellNamespace(): string {
  cachedNamespace ??= resolveCellNamespace();
  return cachedNamespace;
}

/** Test seam: clear the cached namespace so env changes take effect. */
export function _resetCellNamespaceForTesting(): void {
  cachedNamespace = null;
}

/** `clawg-{namespace}-` — everything this instance owns starts with this. */
export function ownGroupCellPrefix(namespace: string = getCellNamespace()): string {
  return `${CELL_GROUP_PREFIX}${namespace}-`;
}

/**
 * Customer id for a group's cell: `clawg-{namespace}-{group}`. Group folders
 * are already restricted to [A-Za-z0-9_-]; lowercase and map '_' to '-' for
 * a conservative identifier. When the full id would exceed the length
 * ceiling, the NAMESPACE is truncated (never the group — group names must
 * stay collision-free within the instance).
 */
export function cellCustomerIdForGroup(groupFolder: string, namespace: string = getCellNamespace()): string {
  const group = groupFolder.toLowerCase().replace(/_/g, '-');
  const budget = MAX_CUSTOMER_ID_LEN - CELL_GROUP_PREFIX.length - 1 - group.length;
  const ns = namespace.length <= budget ? namespace : truncatedNamespace(namespace, budget);
  return `${CELL_GROUP_PREFIX}${ns}-${group}`;
}

/** Truncate to `budget` chars (min 1) without leaving a trailing dash. */
function truncatedNamespace(namespace: string, budget: number): string {
  const cut = namespace.slice(0, Math.max(1, budget)).replace(/-+$/, '');
  return cut || namespace.slice(0, 1);
}

/**
 * Verify the OnCell runtime is usable: API key present, namespace valid, and
 * the API reachable. Mirrors ensureContainerRuntimeRunning()'s fail-fast
 * contract — listCells carries the client's request timeout, so an API blip
 * fails loudly instead of hanging boot.
 */
export async function ensureCellRuntimeReady(): Promise<void> {
  if (!ONCELL_API_KEY) {
    printCellRuntimeFailure('ONCELL_API_KEY is not set');
    throw new Error('OnCell runtime selected but ONCELL_API_KEY is not configured');
  }
  // Validate the namespace before any cell is created under a wrong name.
  const namespace = getCellNamespace();
  try {
    await getCellClient().listCells();
    log.debug('OnCell API reachable', { namespace });
  } catch (err: unknown) {
    log.error('Failed to reach the OnCell API', { err });
    printCellRuntimeFailure('The OnCell API is unreachable');
    throw new Error('OnCell runtime is required but unreachable', { cause: err });
  }
}

function printCellRuntimeFailure(reason: string): void {
  console.error('\n╔════════════════════════════════════════════════════════════════╗');
  console.error('║  FATAL: OnCell runtime unavailable                             ║');
  console.error(`║  ${reason.padEnd(62)}║`);
  console.error('║                                                                ║');
  console.error('║  Agents cannot run without the OnCell runtime. To fix:         ║');
  console.error('║  1. Set ONCELL_API_KEY in .env (see config-examples/)          ║');
  console.error('║  2. Check https://api.oncell.ai is reachable                   ║');
  console.error('║  3. Or set ONCELLCLAW_RUNTIME=docker to run locally            ║');
  console.error('╚════════════════════════════════════════════════════════════════╝\n');
}

/**
 * Ownership predicate for cleanup. Prefix match on the full namespace covers
 * the normal case (including cells of groups since deleted from the DB); the
 * exact-id set additionally covers ids whose namespace segment was
 * length-truncated, which a plain prefix match would miss.
 */
function isOwnGroupCell(customerId: string, ownIds: ReadonlySet<string>): boolean {
  return customerId.startsWith(ownGroupCellPrefix()) || ownIds.has(customerId);
}

/** Exact customer ids for every group in this instance's DB. Empty when the
 *  DB isn't up (defensive — cleanup must never throw over this). */
function ownGroupCellIds(): Set<string> {
  try {
    return new Set(getAllAgentGroups().map((group) => cellCustomerIdForGroup(group.folder)));
  } catch {
    return new Set();
  }
}

/**
 * Stop agent-runner services left running in THIS INSTANCE's group cells by
 * a previous host run. Scoped strictly to the instance namespace
 * (`clawg-{namespace}-…` plus this instance's exact ids):
 *   - hosting cells (`claw-*`) are never touched — one of them is likely the
 *     cell THIS PROCESS runs in, and stopping it is self-termination;
 *   - sibling instances' group cells (`clawg-{other}-…`) are never touched.
 * Cells themselves are kept — durable group state is the point — only the
 * runner services are stopped.
 */
export async function cleanupOrphanCellServices(): Promise<void> {
  let stopped = 0;
  try {
    const cells = await getCellClient().listCells();
    const ownIds = ownGroupCellIds();
    warnAboutLegacyCells(cells, ownIds);
    for (const cell of cells) {
      if (!cell.customer_id || !isOwnGroupCell(cell.customer_id, ownIds)) continue;
      try {
        await getCellClient().stopService(cell.cell_id);
        stopped += 1;
      } catch (err: unknown) {
        if (!isNoAppRunning(err)) {
          log.warn('Failed to stop orphan cell service', { cellId: cell.cell_id, err });
        }
      }
    }
    if (stopped > 0) {
      log.info('Stopped orphan cell services', { count: stopped });
    }
  } catch (err: unknown) {
    log.warn('Failed to clean up orphan cell services', { err });
  }
}

/**
 * Migration aid for installs that predate the namespace scheme: their group
 * cells are named `claw-{group}` and will no longer be found — the next wake
 * creates a fresh `clawg-{namespace}-{group}` cell WITHOUT the old cell's
 * files or memory. Detect that (a legacy-named cell exists for one of this
 * instance's groups while no namespaced one does) and say so loudly. Never
 * auto-adopt: `claw-{group}` is also the dashboard's HOSTING-cell prefix, so
 * ownership of any given claw-* cell is ambiguous by construction.
 */
function warnAboutLegacyCells(cells: readonly CellRecord[], ownIds: ReadonlySet<string>): void {
  const byCustomerId = new Set(cells.map((cell) => cell.customer_id).filter((id): id is string => !!id));
  let groups: Array<{ folder: string }>;
  try {
    groups = getAllAgentGroups();
  } catch {
    return;
  }
  for (const group of groups) {
    const normalized = group.folder.toLowerCase().replace(/_/g, '-');
    const legacyId = `${LEGACY_CELL_CUSTOMER_PREFIX}${normalized}`;
    const namespacedId = cellCustomerIdForGroup(group.folder);
    if (byCustomerId.has(legacyId) && !byCustomerId.has(namespacedId) && ownIds.has(namespacedId)) {
      log.warn(
        'Legacy cell naming detected — this group will start a FRESH cell under the namespaced scheme, ' +
          "without the legacy cell's files/memory. To keep the old state, migrate it manually via the " +
          'OnCell API (fork or rename the cell to the new customer_id), then delete the legacy cell. ' +
          'Not auto-adopted: claw-* is also the hosting-cell namespace, so ownership is ambiguous.',
        { group: group.folder, legacyCustomerId: legacyId, newCustomerId: namespacedId },
      );
    }
  }
}
