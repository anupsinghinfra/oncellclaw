/**
 * OnCell cell runtime for oncellclaw — the cell-side counterpart of
 * container-runtime.ts. One OnCell cell per agent group, named by
 * customer_id `claw-{groupFolder}` (the API derives the full cell id as
 * `{developerId}--{customer_id}`).
 *
 * The runtime-readiness and orphan-cleanup semantics mirror the docker
 * runtime: fail fast at startup when the runtime is unreachable, and stop
 * agent services left running by a previous host process (the host lost its
 * in-memory active map, and a stale runner service must not keep writing
 * outbound.db while a new one is started).
 */
import { ONCELL_API_KEY, ONCELL_API_URL } from './config.js';
import { log } from './log.js';
import { createOnCellClient, isNoAppRunning, type OnCellClient } from './oncell-client.js';

/** Prefix identifying oncellclaw-owned cells in the developer's cell list. */
export const CELL_CUSTOMER_PREFIX = 'claw-';

let sharedClient: OnCellClient | null = null;

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
 * Customer id for a group's cell. Group folders are already restricted to
 * [A-Za-z0-9_-]; lowercase and map '_' to '-' for a conservative identifier.
 */
export function cellCustomerIdForGroup(groupFolder: string): string {
  return `${CELL_CUSTOMER_PREFIX}${groupFolder.toLowerCase().replace(/_/g, '-')}`;
}

/**
 * Verify the OnCell runtime is usable: API key present and the API
 * reachable. Mirrors ensureContainerRuntimeRunning()'s fail-fast contract.
 */
export async function ensureCellRuntimeReady(): Promise<void> {
  if (!ONCELL_API_KEY) {
    printCellRuntimeFailure('ONCELL_API_KEY is not set');
    throw new Error('OnCell runtime selected but ONCELL_API_KEY is not configured');
  }
  try {
    await getCellClient().listCells();
    log.debug('OnCell API reachable');
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
 * Stop agent-runner services left running in claw-* cells by a previous
 * host run. Scoped by the customer-id prefix so unrelated cells under the
 * same developer account are never touched. Cells themselves are kept —
 * durable group state is the point — only the runner services are stopped.
 */
export async function cleanupOrphanCellServices(): Promise<void> {
  let stopped = 0;
  try {
    const cells = await getCellClient().listCells();
    for (const cell of cells) {
      if (!cell.customer_id?.startsWith(CELL_CUSTOMER_PREFIX)) continue;
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
