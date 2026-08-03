/**
 * The durability contract — what survives a hosted update, and why.
 *
 * A hosted claw is not a long-lived checkout. `scripts/cloud-start.sh`
 * extracts a PRISTINE trunk tarball per commit sha into `$BASE/src-<sha>`,
 * flips the `current` symlink, and prunes the old tree. Anything written
 * into the checkout — an npm dependency, an edited source file, a session
 * blob dropped next to the code — is gone on the next update.
 *
 * Exactly one escape hatch exists, and this module is its single source of
 * truth: `wire_state()` in cloud-start.sh replaces a fixed set of paths in
 * every checkout with symlinks into `$BASE/state/`, which is never pruned.
 * Those are DURABLE_DIRS and DURABLE_FILES below. Nothing else survives.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The channel convention (READ THIS BEFORE ADDING A CHANNEL)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A channel is CONFIGURATION, never INSTALLATION. Concretely:
 *
 *  1. The adapter ships in trunk (`src/channels/<name>.ts`, registered from
 *     `src/channels/index.ts`). It is present in every checkout because it
 *     IS the checkout — no copy step, no barrel edit, no `pnpm add` inside
 *     a live cell. Platform SDKs that cannot be avoided go in the root
 *     `package.json` (see `optionalDependencies`), so `pnpm install
 *     --frozen-lockfile` reproduces them on every sha.
 *
 *  2. Credentials go to `.env` through `upsertEnvVar` (src/env.ts) — the
 *     one canonical writer, used by the CLI path (setup/set-env.ts) and by
 *     the web pairing endpoints alike. `.env` is a DURABLE_FILE, so a token
 *     pasted into `POST /web/channels/<c>/pair` outlives every update.
 *
 *  3. Session/auth blobs that are not a single scalar (WhatsApp's Baileys
 *     multi-file auth state, for instance) go somewhere under `store/`,
 *     a DURABLE_DIR. Never next to the source, never in a temp dir, never
 *     under `node_modules`.
 *
 *  4. The registration declares both — `durability` on ChannelRegistration
 *     (src/channels/adapter.ts). `src/channels/channel-durability.test.ts`
 *     walks the live registry and fails the build if a trunk channel omits
 *     the declaration, names a path outside the wired set, or if
 *     cloud-start.sh's `wire_state()` drifts away from the constants here.
 *
 * A channel that cannot satisfy (1) — one that genuinely needs an
 * LLM-driven skill to install code into the checkout — cannot be hosted.
 * cloud-start.sh warns about exactly that case at boot (see
 * `warn_orphaned_channels`), because the alternative is a claw that pairs
 * once and silently goes dark on the next deploy.
 */
import path from 'path';

/**
 * Directory names cloud-start.sh replaces with symlinks into `$BASE/state/`.
 * The app's data/groups/store paths are cwd-relative and not env-configurable
 * (src/config.ts), so the links ARE the knob.
 */
export const DURABLE_DIRS = ['data', 'groups', 'store'] as const;

/** Files cloud-start.sh replaces with symlinks into `$BASE/state/`. */
export const DURABLE_FILES = ['.env'] as const;

/** Every checkout-relative path that survives an update, dirs and files. */
export const DURABLE_PATHS: readonly string[] = [...DURABLE_DIRS, ...DURABLE_FILES];

/**
 * True when `target` resolves inside (or onto) one of the wired paths, and
 * is therefore preserved across a hosted update.
 *
 * `target` may be absolute or relative to the install root. `root` defaults
 * to `process.cwd()` — the checkout — which is what every runtime caller
 * wants; tests pass a scratch root.
 */
export function isDurablePath(target: string, root: string = process.cwd()): boolean {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(absoluteRoot, target);
  return DURABLE_PATHS.some((name) => {
    const wired = path.join(absoluteRoot, name);
    if (absoluteTarget === wired) return true;
    return absoluteTarget.startsWith(`${wired}${path.sep}`);
  });
}

/**
 * Where a channel keeps multi-file session state it cannot express as an
 * `.env` scalar. Under `store/`, so it is durable by construction.
 *
 * Channels that predate this helper keep their historical path (WhatsApp's
 * `store/auth`, documented in half a dozen places and already durable) —
 * the contract is "declared and inside a wired path", not one blessed
 * layout. New channels should use this.
 */
export function channelStateDir(channel: string, root: string = process.cwd()): string {
  return path.join(root, 'store', 'channels', channel);
}
