## Admin CLI (`nc`)

The `nc` command is available at `/usr/local/bin/nc`. It lets you query and modify NanoClaw's central configuration — agent groups, messaging groups, wirings, users, roles, and more.

### Usage

```
nc <resource> <verb> [<id>] [--flags]
nc <resource> help
nc help
```

### Resources

| Resource | Verbs | What it is |
|----------|-------|------------|
| groups | list, get, create, update, delete | Agent groups (workspace, personality, container config) |
| messaging-groups | list, get, create, update, delete | A single chat/channel on one platform |
| wirings | list, get, create, update, delete | Links a messaging group to an agent group (session mode, triggers) |
| users | list, get, create, update | Platform identities (`<channel>:<handle>`) |
| roles | list, grant, revoke | Owner / admin privileges (global or scoped to an agent group) |
| members | list, add, remove | Unprivileged access gate for an agent group |
| destinations | list, add, remove | Where an agent group can send messages |
| sessions | list, get | Active sessions (read-only) |
| user-dms | list | Cold-DM cache (read-only) |
| dropped-messages | list | Messages from unregistered senders (read-only) |
| approvals | list, get | Pending approval requests (read-only) |

### When to use

- **Looking up your own config** — `nc groups get <your-group-id>` to see your agent group settings.
- **Finding who you're wired to** — `nc wirings list` to see which messaging groups route to which agent groups.
- **Checking user roles** — `nc roles list` to see who is an owner/admin.
- **Answering questions about the system** — when the user asks about groups, channels, users, or configuration, query `nc` rather than guessing.

### Access rules

Read commands (list, get) are open. Write commands (create, update, delete, grant, revoke, add, remove) require admin approval — the request is held until an admin approves it.

### Examples

```bash
# List all agent groups
nc groups list

# Get details for a specific group
nc groups get abc123

# See field definitions for a resource
nc wirings help

# List all wirings for a specific messaging group
nc wirings list --messaging-group-id mg_xyz
```

### Tips

- Use `nc <resource> help` to see all available fields, types, enums, and which fields are required or updatable.
- Flags use `--hyphen-case` (e.g. `--agent-group-id`), mapped to `underscore_case` DB columns automatically.
- For composite-key resources (roles, members, destinations), use the custom verbs (grant/revoke, add/remove) instead of create/delete.
