// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// Main ships with three default channels:
//   `cli`      — the always-on local-terminal channel (Unix socket).
//   `web`      — HTTP chat on the process's existing port, for a browser or
//                any client with the bearer token. Starts only when
//                ONCELLCLAW_WEB_TOKEN is set (or the insecure flag is on).
//   `telegram` — dependency-free long-polling Bot API adapter. Dormant
//                (factory returns null) until TELEGRAM_BOT_TOKEN exists —
//                paired via POST /web/channels/telegram/pair or the CLI.
// Other channel skills (/add-slack, /add-discord, /add-whatsapp, ...) copy
// their module from the `channels` branch and append a self-registration
// import below.

import './cli.js';
import './web.js';
import './telegram.js';
