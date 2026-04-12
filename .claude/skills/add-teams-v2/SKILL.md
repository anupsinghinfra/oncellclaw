---
name: add-teams-v2
description: Add Microsoft Teams channel integration to NanoClaw v2 via Chat SDK.
---

# Add Microsoft Teams Channel

Connect NanoClaw to Microsoft Teams for interactive chat in team channels and direct messages.

## Pre-flight

Check if `src/channels/teams.ts` exists and the import is uncommented in `src/channels/index.ts`. If both are in place, skip to Credentials.

## Install

```bash
npm install @chat-adapter/teams
```

Uncomment the Teams import in `src/channels/index.ts`:

```typescript
import './teams.js';
```

Build:

```bash
npm run build
```

## Credentials

### Create Azure Bot

1. Go to [Azure Portal](https://portal.azure.com) > search **Azure Bot** > **Create**
2. Choose **Multi Tenant** (default) or **Single Tenant** depending on your org setup
3. After creation, go to **Configuration**:
   - Copy the **Microsoft App ID**
   - Note the **App Tenant ID** (shown for Single Tenant)
   - Set **Messaging endpoint** to `https://your-domain/webhook/teams`
4. Click **Manage Password** > **Certificates & secrets** > **New client secret** — copy the Value immediately (shown only once)
5. Go to **Channels** > add **Microsoft Teams** > Accept terms > Apply

### Create Teams App Package

Create a `manifest.json` with your App ID, zip it with two icon PNGs (32x32 outline, 192x192 color), and sideload in Teams via **Apps** > **Manage your apps** > **Upload a custom app**. Sideloading requires Teams admin or a developer tenant (free via Microsoft 365 Developer Program).

### Configure environment

Add to `.env`:

```bash
TEAMS_APP_ID=your-app-id
TEAMS_APP_PASSWORD=your-client-secret
# For Single Tenant only:
TEAMS_APP_TENANT_ID=your-tenant-id
TEAMS_APP_TYPE=SingleTenant
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Webhook server

The Chat SDK bridge automatically starts a shared webhook server on port 3000 (configurable via `WEBHOOK_PORT` env var). The server handles `/webhook/teams` for Teams and other webhook-based adapters. This port must be publicly reachable from the internet for Azure Bot Service to deliver activities.

If running locally, discuss options for exposing the server — e.g. ngrok (`ngrok http 3000`), Cloudflare Tunnel, or a reverse proxy on a VPS. The resulting public URL becomes the base for `https://your-domain/webhook/teams`.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `teams`
- **terminology**: Teams has "teams" containing "channels." The bot can also receive direct messages. Teams channels can have threaded replies.
- **how-to-find-id**: Right-click a channel in Teams > "Get link to channel" -- the channel ID is in the URL. Or use the Microsoft Graph API to list channels.
- **supports-threads**: yes
- **typical-use**: Interactive chat -- team channels or direct messages
- **default-isolation**: Same agent group for channels where you're the primary user. Separate agent group for channels with different teams or where different members have different information boundaries.
