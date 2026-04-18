/**
 * Approvals module — admin-gated self-modification and OneCLI credential flow.
 *
 * Registers:
 *   - Three delivery actions the container writes via self-mod MCP tools:
 *     install_packages, request_rebuild, add_mcp_server.
 *   - A response handler that claims `pending_approvals` rows (agent-initiated
 *     approvals) + OneCLI credential approvals (resolved via in-memory Promise).
 *   - An adapter-ready callback that starts the OneCLI manual-approval handler
 *     once the delivery adapter is set.
 *   - A shutdown callback that stops the OneCLI handler cleanly.
 */
import { registerDeliveryAction, onDeliveryAdapterReady } from '../../delivery.js';
import { registerResponseHandler, onShutdown } from '../../response-registry.js';
import { handleAddMcpServer, handleInstallPackages, handleRequestRebuild } from './request-approval.js';
import { handleApprovalsResponse } from './response-handler.js';
import { startOneCLIApprovalHandler, stopOneCLIApprovalHandler } from './onecli-approvals.js';

registerDeliveryAction('install_packages', async (content, session) => {
  await handleInstallPackages(content, session);
});
registerDeliveryAction('request_rebuild', async (content, session) => {
  await handleRequestRebuild(content, session);
});
registerDeliveryAction('add_mcp_server', async (content, session) => {
  await handleAddMcpServer(content, session);
});

registerResponseHandler(handleApprovalsResponse);

onDeliveryAdapterReady((adapter) => {
  startOneCLIApprovalHandler(adapter);
});

onShutdown(() => {
  stopOneCLIApprovalHandler();
});
