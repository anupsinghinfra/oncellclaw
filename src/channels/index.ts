// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// Every channel here is CONFIGURATION, not INSTALLATION: the adapter ships in
// trunk and comes alive the moment its credential appears. That is what makes
// a hosted claw's channels survive an update — cloud-start.sh re-extracts a
// pristine trunk tarball per commit sha, so a channel whose code was
// INSTALLED into the checkout by a skill pairs once and silently goes dark on
// the next deploy. Each registration below declares where its credential and
// session state live (`durability`), and channel-durability.test.ts fails the
// build if any of it lands outside the paths cloud-start.sh keeps.
// See src/durable-state.ts for the whole contract.
//
// Main ships with five default channels:
//   `cli`      — the always-on local-terminal channel (Unix socket).
//   `web`      — HTTP chat on the process's existing port, for a browser or
//                any client with the bearer token. Starts only when
//                ONCELLCLAW_WEB_TOKEN is set (or the insecure flag is on).
//   `telegram` — dependency-free long-polling Bot API adapter. Dormant
//                (factory returns null) until TELEGRAM_BOT_TOKEN exists —
//                paired via POST /web/channels/telegram/pair or the CLI.
//   `discord`  — dependency-free gateway-websocket adapter (outbound
//                connection, no public URL needed). Dormant until
//                DISCORD_BOT_TOKEN exists — paired via
//                POST /web/channels/discord/pair.
//   `whatsapp` — Baileys linked-device adapter (optional trunk dependency,
//                lazily imported). Dormant until a QR scan writes the
//                session to store/auth — paired via
//                GET /web/channels/whatsapp/qr, or the pairing step on a
//                terminal.
// Channel skills that still install their own module (/add-slack,
// /add-signal, ...) copy it in and append a self-registration import below.
// Those channels are self-host-only: see the hosted section of the README.

import './cli.js';
import './web.js';
import './telegram.js';
import './discord.js';
import './whatsapp.js';
