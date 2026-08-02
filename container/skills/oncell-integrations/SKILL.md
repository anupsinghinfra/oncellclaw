---
name: oncell-integrations
description: >-
  OnCell integrations: call external services (Google Calendar, Gmail,
  GitHub) through the OnCell credential-injecting proxy. Use this whenever
  the user asks you to read email, check or edit a calendar, access GitHub
  repos or issues, or interact with any connected external service. Do NOT
  use browser OAuth flows or ask for API keys — the proxy injects
  credentials for connected providers.
metadata:
  author: oncell
  version: '1.0'
---

# OnCell Integrations

External services are reached through the OnCell integrations proxy. It
injects the user's stored credentials server-side — you never see or handle
tokens. Authentication to the proxy itself uses the `ONCELL_API_KEY` already
in your environment.

## Endpoints

List providers and their connection status:

```bash
curl -s -H "Authorization: Bearer $ONCELL_API_KEY" \
  "${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations"
# → [{"provider":"google-calendar","connected":true},{"provider":"gmail","connected":false},…]
```

Call a provider's API through the generic proxy — append the provider's own
API path after `/proxy`; method, query string, and body pass through
unchanged, credentials are injected:

```bash
# Gmail — latest messages
curl -s -H "Authorization: Bearer $ONCELL_API_KEY" \
  "${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations/gmail/proxy/gmail/v1/users/me/messages?maxResults=5"

# Google Calendar — today's events
curl -s -H "Authorization: Bearer $ONCELL_API_KEY" \
  "${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations/google-calendar/proxy/calendar/v3/calendars/primary/events?timeMin=2026-08-02T00:00:00Z"

# GitHub — your repos
curl -s -H "Authorization: Bearer $ONCELL_API_KEY" \
  "${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations/github/proxy/user/repos?per_page=10"

# Writes work the same way (method + body pass through)
curl -s -X POST -H "Authorization: Bearer $ONCELL_API_KEY" -H 'Content-Type: application/json' \
  -d '{"title":"Fix the flaky test"}' \
  "${ONCELL_API_URL:-https://api.oncell.ai}/api/v1/integrations/github/proxy/repos/OWNER/REPO/issues"
```

Providers available today: `google-calendar`, `gmail`, `github`.

## When a provider is not connected

A call to an unconnected provider returns:

```json
{ "error": "not_connected", "connectUrl": "https://oncell.ai/dashboard/integrations" }
```

Tell the user exactly this, substituting the provider name:

> Connect {Provider} on your OnCell dashboard → Integrations
> (https://oncell.ai/dashboard/integrations), then tell me and I'll retry.

Then retry the original request once they confirm.

## Rules

- Never say "I don't have access to X" without first trying the proxy.
- Never mention a "OneCLI dashboard" — connections happen on the OnCell
  dashboard's Integrations tab, nowhere else.
- Never invent connect steps and never ask the user for API keys, tokens,
  or passwords.
- Never route the user through browser OAuth yourself; the dashboard owns
  the connect flow.
- If `ONCELL_API_KEY` is missing from your environment, integrations are
  not available on this install — say so plainly.
