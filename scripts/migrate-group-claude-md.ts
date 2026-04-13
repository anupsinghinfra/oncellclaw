/**
 * One-shot migration: prepend `@/workspace/global/CLAUDE.md` to each
 * existing group's CLAUDE.md so it imports the global memory under the
 * new model where the host no longer reads global CLAUDE.md at bootstrap.
 *
 * - Skips entirely if `groups/global/CLAUDE.md` doesn't exist (nothing
 *   to import; running the script would just add a broken @-import).
 * - Skips any group whose CLAUDE.md already references
 *   `/workspace/global/CLAUDE.md` (idempotent).
 * - Skips groups with no CLAUDE.md (nothing to prepend to).
 *
 * Usage: npx tsx scripts/migrate-group-claude-md.ts
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../src/config.js';

const GLOBAL_CLAUDE_MD = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
const IMPORT_LINE = '@/workspace/global/CLAUDE.md';
// Must match the @-import syntax exactly — a bare path reference inside
// instructional prose ("you can write to /workspace/global/CLAUDE.md")
// shouldn't count as "already wired."
const IMPORT_REGEX = /@\/workspace\/global\/CLAUDE\.md/;

if (!fs.existsSync(GLOBAL_CLAUDE_MD)) {
  console.error(`No global CLAUDE.md at ${GLOBAL_CLAUDE_MD} — nothing to migrate.`);
  process.exit(1);
}

if (!fs.existsSync(GROUPS_DIR)) {
  console.error(`No groups dir at ${GROUPS_DIR} — nothing to migrate.`);
  process.exit(1);
}

const entries = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
let updated = 0;
let alreadyWired = 0;
let missingClaudeMd = 0;

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  if (entry.name === 'global') continue; // not a group

  const claudeMd = path.join(GROUPS_DIR, entry.name, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    console.log(`[skip]  ${entry.name}: no CLAUDE.md`);
    missingClaudeMd++;
    continue;
  }

  const body = fs.readFileSync(claudeMd, 'utf-8');
  if (IMPORT_REGEX.test(body)) {
    console.log(`[wired] ${entry.name}: already imports ${IMPORT_LINE}`);
    alreadyWired++;
    continue;
  }

  const newBody = `${IMPORT_LINE}\n\n${body}`;
  fs.writeFileSync(claudeMd, newBody);
  console.log(`[ok]    ${entry.name}: prepended import`);
  updated++;
}

console.log(`\nDone. updated=${updated} alreadyWired=${alreadyWired} missingClaudeMd=${missingClaudeMd}`);
