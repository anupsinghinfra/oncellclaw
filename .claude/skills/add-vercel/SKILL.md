---
name: add-vercel
description: Add Vercel deployment capability to NanoClaw agents. Installs the Vercel CLI in agent containers and sets up OneCLI credential injection for api.vercel.com. Use when the user wants agents to deploy web applications to Vercel.
---

# Add Vercel

This skill gives NanoClaw agents the ability to deploy web applications to Vercel. It installs the Vercel CLI in agent containers and configures OneCLI to inject Vercel credentials automatically.

**Principle:** Do the work — don't tell the user to do it. Only ask for their input when it genuinely requires manual action (pasting a token).

## Phase 1: Pre-flight

### Check if already applied

Check if the container skill exists:

```bash
test -d container/skills/vercel-cli && echo "INSTALLED" || echo "NOT_INSTALLED"
```

If `INSTALLED`, skip to Phase 3 (Configure Credentials).

### Check prerequisites

Verify OneCLI is working (required for credential injection):

```bash
onecli version 2>/dev/null && echo "ONECLI_OK" || echo "ONECLI_MISSING"
```

If `ONECLI_MISSING`, tell the user to run `/init-onecli` first, then retry `/add-vercel`. Stop here.

## Phase 2: Install Container Skill

Copy the bundled container skill into the container skills directory:

```bash
rsync -a .claude/skills/add-vercel/container-skills/ container/skills/
```

Verify:

```bash
head -5 container/skills/vercel-cli/SKILL.md
```

## Phase 3: Configure Credentials

### Check if Vercel credential already exists

```bash
onecli secrets list 2>/dev/null | grep -i vercel
```

If a Vercel credential already exists, skip to Phase 4.

### Set up Vercel API credential

The agent needs a Vercel personal access token. Tell the user:

> I need your Vercel personal access token. Go to https://vercel.com/account/tokens and create one with these settings:
>
> - **Token name:** `nanoclaw` (or any name you'll recognize)
> - **Scope:** "Full Account" — the agent needs to create projects, deploy, and manage domains
> - **Expiration:** "No expiration" recommended (avoids credential rotation), or pick a date if your security policy requires it
>
> After creating the token, copy it — you'll only see it once.

Once the user provides the token, add it to OneCLI:

```bash
onecli secrets create \
  --name "Vercel API Token" \
  --type generic \
  --value "<TOKEN>" \
  --host-pattern "api.vercel.com" \
  --header-name "Authorization" \
  --value-format "Bearer {value}"
```

Verify:

```bash
onecli secrets list | grep -i vercel
```

## Phase 4: Install Vercel CLI in Container

The Vercel CLI needs to be installed in the agent container image. The agent does this via the self-modification flow:

1. Agent calls `install_packages(npm: ["vercel"], reason: "Vercel CLI for deploying web applications")`
2. Admin approves the installation
3. Agent calls `request_rebuild(reason: "Apply Vercel CLI installation")`
4. Admin approves the rebuild

If you're setting this up from the host, tell the user to message their agent and ask it to install the Vercel CLI. The agent will use the `vercel-cli` container skill to guide itself.

**Alternative for base image:** If you want Vercel CLI available to ALL agent groups without per-group rebuilds, add it to `container/Dockerfile`:

```dockerfile
RUN npm install -g vercel
```

Then rebuild the base image:

```bash
./container/build.sh
```

## Phase 5: Verify

### Test authentication

Have the agent run:

```bash
vercel whoami --token placeholder
```

This should print the Vercel account name. If it fails:
- Check OneCLI is running: `onecli version`
- Check the secret exists: `onecli secrets list | grep -i vercel`
- Check the credential hostPattern matches `api.vercel.com`

### Test deployment

Have the agent create and deploy a minimal test project:

```bash
mkdir -p /tmp/vercel-test && echo '<!DOCTYPE html><html><body><h1>NanoClaw Vercel Test</h1></body></html>' > /tmp/vercel-test/index.html && vercel deploy --yes --prod --token placeholder --cwd /tmp/vercel-test
```

The output should include a live URL. Open it to verify the deployment worked.

Clean up the test project after verifying:

```bash
rm -rf /tmp/vercel-test
```

## Done

The agent can now deploy web applications to Vercel. Key commands:

- `vercel deploy --yes --prod --token placeholder` — deploy to production
- `vercel ls --token placeholder` — list deployments
- `vercel whoami --token placeholder` — check auth

For the full command reference, the agent has the `vercel-cli` container skill loaded automatically.
