/**
 * Runtime path roots for the agent-runner.
 *
 * Under docker (upstream NanoClaw) the session dir is bind-mounted at
 * /workspace and the defaults below apply unchanged. Under the OnCell
 * runtime there are no mounts — the host lays the same tree out inside the
 * cell workspace and points the runner at it via NANOCLAW_WORKSPACE_ROOT
 * (see src/cell-runner.ts on the host side).
 */

/** Session root: contains inbound.db, outbound.db, .heartbeat, agent/, outbox/. */
export function workspaceRoot(): string {
  return process.env.NANOCLAW_WORKSPACE_ROOT || '/workspace';
}

/** The agent group working dir (CLAUDE.md, container.json, memory). */
export function agentDir(): string {
  return `${workspaceRoot()}/agent`;
}
