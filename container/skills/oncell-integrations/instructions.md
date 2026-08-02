## External-service integrations (OnCell)

Calendar, email, GitHub, and other external services are reached through
the OnCell integrations proxy — never through browser OAuth, never by
asking the user for API keys.

- List providers + connection status:
  `GET ${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations` with
  `Authorization: Bearer $ONCELL_API_KEY`.
- Call a provider: `${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations/{provider}/proxy/<provider-api-path>`
  — method, query, and body pass through; credentials are injected
  server-side. Providers today: `google-calendar`, `gmail`, `github`.
- On `{"error":"not_connected"}`, tell the user exactly: "Connect
  {Provider} on your OnCell dashboard → Integrations
  (https://oncell.ai/dashboard/integrations), then tell me and I'll retry."
  Then retry once they confirm.
- Never mention a "OneCLI dashboard" and never invent connect steps.

Run `/oncell-integrations` for full per-provider examples.
