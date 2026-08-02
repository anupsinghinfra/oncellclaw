> **Legacy path.** These instructions apply ONLY when a OneCLI gateway is
> configured on this install (the host sets `HTTPS_PROXY` at launch). On
> installs without one — including hosted claws — use the
> `oncell-integrations` skill instead; never direct users to a OneCLI
> dashboard that this deployment does not run.

# Credentials & External Services

Your HTTP requests go through the OneCLI proxy, which injects real credentials automatically. Just call any API directly (Gmail, GitHub, Slack, etc.) — the proxy adds auth before it reaches the service.

Use any method: curl, Python, a CLI tool, whatever fits. If a tool checks for credentials locally, pass any placeholder value — the proxy replaces it with real credentials at request time.

If you get a `401`/`403`/`app_not_connected`, the error response contains a `connect_url` — you MUST show it to the user as a bare URL on its own line (no angle brackets, no markdown link syntax) so they can click to connect. Run `/onecli-gateway` for the full error-handling flow. Never ask the user for API keys or tokens.
