---
name: onecli-gateway
description: >-
  Handle credentials and authentication for external services. Use when you
  hit a 401, 403, or app_not_connected error, or when the user asks you to
  access an external service (Gmail, GitHub, Slack, Calendar, Stripe, etc.).
  Do NOT use browser extensions or manual auth flows — make HTTP requests
  directly; the OneCLI proxy injects credentials automatically.
---

# OneCLI Gateway: Credentials & Authentication

Your container routes all HTTPS traffic through the OneCLI proxy, which
injects stored credentials (API keys, OAuth tokens) at the proxy boundary.
You never see or handle credential values directly.

## Making Requests

Call the real API URL. The proxy intercepts and injects credentials automatically.

```bash
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5"
curl -s "https://api.github.com/user/repos?per_page=10"
curl -s "https://api.stripe.com/v1/charges?limit=5"
```

Any HTTP client (curl, fetch, axios, Python requests, Go net/http, git) honors
`HTTPS_PROXY` automatically. You do not need to set auth headers.

If a tool or library validates credentials locally before making the request,
pass any placeholder value (a fake string). The proxy replaces it with real
credentials at request time.

## When a Request Fails (401 / 403 / app_not_connected)

### Step 1 — Show the user a connect link

If the error response includes a `connect_url`, share it directly:

> To connect [service], open this link:
> [connect_url from the error response]

If there's no `connect_url`, tell the user to open the OneCLI dashboard and
connect the service there.

Do NOT ask the user for API keys or tokens. Do NOT suggest pasting credentials
into chat. The fix is always connecting the service in OneCLI.

### Step 2 — Retry after the user connects

After showing the link, let the user know you'll retry once they've connected.
When they confirm (or after a reasonable pause), retry the original request.

If the retry still fails, ask the user if they need help with the OneCLI setup.

## Rules

- **Never** say "I don't have access to X" without first making the HTTP
  request through the proxy.
- **Never** use browser extensions, gcloud, or manual auth flows. The proxy
  handles credentials for you.
- **Never** ask the user for API keys, tokens, or passwords directly.
- **Never** suggest the user open Gmail/Calendar/GitHub in their browser
  when they ask you to read or interact with those services. You have API
  access — use it.
- If the proxy returns a policy error (403 with a JSON body), respect the
  block. Do not retry or circumvent it.
