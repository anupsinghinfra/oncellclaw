import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

const GLOBAL_CLAUDE_IMPORT = '@/workspace/global/CLAUDE.md';

const DEFAULT_SETTINGS_JSON =
  JSON.stringify(
    {
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    },
    null,
    2,
  ) + '\n';

/**
 * Initialize the on-disk filesystem state for an agent group. Idempotent —
 * every step is gated on the target not already existing, so re-running on
 * an already-initialized group is a no-op.
 *
 * Called once per group lifetime: at creation, or defensively from
 * `buildMounts()` for groups that pre-date this code path. After init, the
 * host never overwrites any of these paths automatically — agents own them.
 * To pull in upstream changes, use the host-mediated reset/refresh tools.
 */
export function initGroupFilesystem(group: AgentGroup, opts?: { instructions?: string }): void {
  const projectRoot = process.cwd();
  const initialized: string[] = [];

  // 1. groups/<folder>/ — group memory + working dir
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
    initialized.push('groupDir');
  }

  // groups/<folder>/CLAUDE.md — written once, then owned by the group
  const claudeMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdFile)) {
    const body = [GLOBAL_CLAUDE_IMPORT, '', opts?.instructions ?? `# ${group.name}`].join('\n') + '\n';
    fs.writeFileSync(claudeMdFile, body);
    initialized.push('CLAUDE.md');
  }

  // 2. data/v2-sessions/<id>/.claude-shared/ — Claude state + per-group skills
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', group.id, '.claude-shared');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
    initialized.push('.claude-shared');
  }

  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, DEFAULT_SETTINGS_JSON);
    initialized.push('settings.json');
  }

  const skillsDst = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDst)) {
    const skillsSrc = path.join(projectRoot, 'container', 'skills');
    if (fs.existsSync(skillsSrc)) {
      fs.cpSync(skillsSrc, skillsDst, { recursive: true });
      initialized.push('skills/');
    }
  }

  // 3. data/v2-sessions/<id>/agent-runner-src/ — per-group source copy
  const groupRunnerDir = path.join(DATA_DIR, 'v2-sessions', group.id, 'agent-runner-src');
  if (!fs.existsSync(groupRunnerDir)) {
    const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
    if (fs.existsSync(agentRunnerSrc)) {
      fs.cpSync(agentRunnerSrc, groupRunnerDir, { recursive: true });
      initialized.push('agent-runner-src/');
    }
  }

  if (initialized.length > 0) {
    log.info('Initialized group filesystem', {
      group: group.name,
      folder: group.folder,
      id: group.id,
      steps: initialized,
    });
  }
}
