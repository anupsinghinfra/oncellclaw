/**
 * NanoClaw v2 — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start delivery polls, start sweep.
 * Channel adapters are started separately (Phase 4).
 */
import path from 'path';

import { DATA_DIR } from './config.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter } from './delivery.js';
import { startHostSweep } from './host-sweep.js';
import { log } from './log.js';

async function main(): Promise<void> {
  log.info('NanoClaw v2 starting');

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  // 3. Channel adapters (Phase 4 — placeholder)
  // TODO: init channel adapters, set up delivery adapter
  // setDeliveryAdapter({ deliver: async (...) => { ... } });

  // 4. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 5. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  log.info('NanoClaw v2 running');
}

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
