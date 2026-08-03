/**
 * WhatsApp linked-device session state — the one place its on-disk location
 * is decided.
 *
 * WhatsApp has no token to paste: the credential IS a linked-device session,
 * a directory of JSON files Baileys writes and keeps rewriting (`creds.json`
 * plus rotating `app-state-sync-*` / `session-*` / `pre-key-*` blobs). Three
 * separate processes touch it and they MUST agree on the path or a scan is
 * lost on the next boot:
 *
 *   setup/whatsapp-auth.ts   writes it during pairing (its own process)
 *   src/channels/whatsapp.ts reads it at boot, rewrites it as keys rotate
 *   src/channels/whatsapp-qr.ts  probes it to answer "already paired?"
 *
 * Location: `store/auth` under the install root. `store/` is a DURABLE_DIR
 * (src/durable-state.ts) — cloud-start.sh symlinks it into `$BASE/state/`,
 * so a QR scanned today survives every later deploy, restart and pause. That
 * is the whole reason the path lives here rather than being spelled out
 * three times.
 *
 * ONCELLCLAW_WA_AUTH_DIR overrides it — the test seam, and the escape hatch
 * for an operator with an unusual layout. An override that points outside
 * the durable set is the operator's problem; `isDurablePath` is available if
 * a caller wants to check.
 *
 * This module is a LEAF on purpose: node builtins only, no logger, no
 * registry. `setup/whatsapp-auth.ts` runs as its own tsx process during
 * pairing and must not drag the host's module graph in behind it.
 */
import fs from 'fs';
import path from 'path';

export const WHATSAPP_AUTH_DIR_ENV_KEY = 'ONCELLCLAW_WA_AUTH_DIR';

/**
 * Trunk's OPTIONAL WhatsApp dependencies (package.json
 * `optionalDependencies`). Baileys is ~46 MB installed and only a paired
 * WhatsApp claw ever touches it, so it is optional and lazily imported —
 * which means it CAN be absent, and both the adapter's error and the QR
 * relay's preflight must name the same list. Declared in this leaf so
 * neither has to import the other to agree.
 */
export const WHATSAPP_OPTIONAL_DEPS = ['pino', '@whiskeysockets/baileys'] as const;

/** Checkout-relative auth directory — what the durability declaration names. */
export const WHATSAPP_AUTH_SUBPATH = path.join('store', 'auth');

/** Absolute path to the linked-device session directory. */
export function whatsappAuthDir(): string {
  return process.env[WHATSAPP_AUTH_DIR_ENV_KEY] || path.join(process.cwd(), WHATSAPP_AUTH_SUBPATH);
}

/**
 * The pairing-code scratch file. Beside the session directory, not inside
 * it — `useMultiFileAuthState` owns the contents of the auth dir, and a
 * stray file in there is asking for trouble on some future Baileys.
 */
export function whatsappPairingCodeFile(): string {
  return path.join(path.dirname(whatsappAuthDir()), 'pairing-code.txt');
}

/** Linked-device credentials on disk = this install is paired. */
export function isWhatsappPaired(): boolean {
  try {
    return fs.existsSync(path.join(whatsappAuthDir(), 'creds.json'));
  } catch {
    return false;
  }
}

/** Bare phone digits from a WhatsApp JID (`14155551234:12@s.whatsapp.net`). */
export function phoneFromJid(jid?: string | null): string {
  if (!jid) return '';
  return jid.split('@')[0]!.split(':')[0]!;
}

/**
 * Normalise a JID to its addressable form by dropping the device suffix:
 * `14155551234:12@s.whatsapp.net` → `14155551234@s.whatsapp.net`.
 *
 * Load-bearing beyond tidiness: a device-suffixed JID contains a colon, and
 * the permissions layer treats a sender handle containing ':' as ALREADY
 * channel-namespaced (src/modules/permissions/index.ts). Left raw, the same
 * human would land under a different user id on every device rotation.
 */
export function normalizeJid(jid: string): string {
  const at = jid.indexOf('@');
  if (at === -1) return jid;
  const user = jid.slice(0, at).split(':')[0]!;
  return `${user}@${jid.slice(at + 1)}`;
}

/** The linked number, read back from saved credentials ('' when unpaired). */
export function readLinkedPhone(): string {
  try {
    const raw = fs.readFileSync(path.join(whatsappAuthDir(), 'creds.json'), 'utf-8');
    const creds = JSON.parse(raw) as { me?: { id?: string } };
    return phoneFromJid(creds.me?.id);
  } catch {
    return '';
  }
}
