/**
 * Pure removal planner: inventory + per-group decisions → ordered actions.
 *
 * The order is load-bearing:
 *   1. Service / processes / containers / image / symlink — stop the host
 *      first so it can't respawn containers mid-removal.
 *   2. OneCLI agent deletions — before the data group, which removes the
 *      data/v2.db the mine/orphan split was computed from.
 *   3. Data group, with the .env backup strictly before its deletion.
 *   4. User group (groups/, store/).
 *   5. Runtime tail: dist/ then node_modules/ — ALWAYS last. The uninstaller
 *      runs on tsx out of node_modules; nothing may load after this.
 */
import path from 'path';

import type { VaultAgent } from './onecli-agents.js';
import type { Inventory, PathItem } from './scan.js';

export interface Decisions {
  service: boolean;
  data: boolean;
  user: boolean;
  onecliDelete: VaultAgent[];
}

export type RemovalAction =
  | {
      kind: 'unload-service';
      flavor: 'launchd' | 'systemd-user' | 'systemd-system';
      unitPath: string;
      /** systemd unit name without .service (unused for launchd). */
      unitName: string;
    }
  | { kind: 'kill-pid'; pidFile: string }
  | { kind: 'pkill-host'; pattern: string }
  | { kind: 'rm-containers'; runtime: string; containerIds: string[] }
  | { kind: 'rmi'; runtime: string; image: string }
  | { kind: 'rm-ncl-symlink'; linkPath: string }
  | { kind: 'delete-onecli-agent'; agent: VaultAgent }
  | { kind: 'backup-env'; envPath: string }
  | { kind: 'delete-path'; item: PathItem }
  | { kind: 'delete-runtime-path'; item: PathItem };

export function buildRemovalPlan(inv: Inventory, d: Decisions): RemovalAction[] {
  const actions: RemovalAction[] = [];

  if (d.service) {
    const s = inv.service;
    if (s.launchdPlist) {
      actions.push({
        kind: 'unload-service',
        flavor: 'launchd',
        unitPath: s.launchdPlist,
        unitName: path.basename(s.launchdPlist, '.plist'),
      });
    }
    if (s.systemdUserUnit) {
      actions.push({
        kind: 'unload-service',
        flavor: 'systemd-user',
        unitPath: s.systemdUserUnit,
        unitName: path.basename(s.systemdUserUnit, '.service'),
      });
    }
    if (s.systemdSystemUnit) {
      actions.push({
        kind: 'unload-service',
        flavor: 'systemd-system',
        unitPath: s.systemdSystemUnit,
        unitName: path.basename(s.systemdSystemUnit, '.service'),
      });
    }
    if (s.pidFile) actions.push({ kind: 'kill-pid', pidFile: s.pidFile });
    actions.push({
      kind: 'pkill-host',
      pattern: `${inv.projectRoot}/dist/index.js`,
    });
    if (s.containerIds.length > 0) {
      actions.push({
        kind: 'rm-containers',
        runtime: inv.containerRuntime,
        containerIds: s.containerIds,
      });
    }
    if (s.image) {
      actions.push({ kind: 'rmi', runtime: inv.containerRuntime, image: s.image });
    }
    if (s.nclSymlink) {
      actions.push({ kind: 'rm-ncl-symlink', linkPath: s.nclSymlink });
    }
  }

  for (const agent of d.onecliDelete) {
    actions.push({ kind: 'delete-onecli-agent', agent });
  }

  if (d.data) {
    const env = inv.data.find((i) => path.basename(i.path) === '.env');
    if (env) actions.push({ kind: 'backup-env', envPath: env.path });
    for (const item of inv.data) actions.push({ kind: 'delete-path', item });
  }

  if (d.user) {
    for (const item of inv.user) actions.push({ kind: 'delete-path', item });
  }

  if (d.data) {
    const tail = [...inv.runtime].sort(
      (a, b) =>
        Number(path.basename(a.path) === 'node_modules') -
        Number(path.basename(b.path) === 'node_modules'),
    );
    for (const item of tail) actions.push({ kind: 'delete-runtime-path', item });
  }

  return actions;
}
