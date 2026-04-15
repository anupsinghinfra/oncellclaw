/**
 * NanoClaw v2 — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import { execFileSync } from 'child_process';
import path from 'path';

import { setSwapApprovalDelivery } from './builder-agent/approval.js';
import { handleSwapConfirmationResponse, setDeadmanDelivery, startDeadman } from './builder-agent/deadman.js';
import { handlePromoteResponse, setPromoteDelivery } from './builder-agent/promote.js';
import { runBuilderAgentStartupSweep } from './builder-agent/startup.js';
import {
  applySwapFiles,
  bailSwapForRetry,
  captureSwapPreState,
  commitSwap,
  isHostLevelSwap,
  parseSwapSummary,
  requiresFullHostRebuild,
} from './builder-agent/swap.js';
import { removeDevWorktree } from './builder-agent/worktree.js';
import { DATA_DIR } from './config.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { getPendingSwap, updatePendingSwapStatus } from './db/pending-swaps.js';
import { getMessagingGroupsByChannel, getMessagingGroupAgents } from './db/messaging-groups.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import {
  ONECLI_ACTION,
  resolveOneCLIApproval,
  startOneCLIApprovalHandler,
  stopOneCLIApprovalHandler,
} from './onecli-approvals.js';
import {
  getCredentialForModal,
  handleCredentialChannelUnsupported,
  handleCredentialReject,
  handleCredentialSubmit,
  setCredentialDeliveryAdapter,
} from './credentials.js';
import { routeInbound } from './router.js';
import {
  getPendingQuestion,
  deletePendingQuestion,
  getPendingApproval,
  deletePendingApproval,
  getSession,
} from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { updateContainerConfig } from './container-config.js';
import { writeSessionMessage } from './session-manager.js';
import { wakeContainer, buildAgentGroupImage, killContainer } from './container-runner.js';
import { log } from './log.js';

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

import type { ChannelAdapter, ChannelSetup, ConversationConfig } from './channels/adapter.js';
import { initChannelAdapters, teardownChannelAdapters, getChannelAdapter } from './channels/channel-registry.js';

async function main(): Promise<void> {
  log.info('NanoClaw v2 starting');

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 1b. Builder-agent startup sweep — resumes any in-flight deadmans (from a
  // host-level swap restart or an unexpected host crash) and cleans up
  // orphan worktrees. Must run before channel adapters start so any
  // rollback path-exit happens cleanly without partial startup state.
  await runBuilderAgentStartupSweep();

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    const conversations = buildConversationConfigs(adapter.channelType);
    return {
      conversations,
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        handleQuestionResponse(questionId, selectedOption, userId).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
      getCredentialForModal,
      onCredentialReject(credentialId) {
        handleCredentialReject(credentialId).catch((err) =>
          log.error('Failed to handle credential reject', { credentialId, err }),
        );
      },
      onCredentialSubmit(credentialId, value) {
        handleCredentialSubmit(credentialId, value).catch((err) =>
          log.error('Failed to handle credential submit', { credentialId, err }),
        );
      },
      onCredentialChannelUnsupported(credentialId) {
        handleCredentialChannelUnsupported(credentialId).catch((err) =>
          log.error('Failed to handle credential channel-unsupported', { credentialId, err }),
        );
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('./channels/adapter.js').OutboundFile[],
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
  setDeliveryAdapter(deliveryAdapter);
  setCredentialDeliveryAdapter(deliveryAdapter);
  setSwapApprovalDelivery(deliveryAdapter);
  setDeadmanDelivery(deliveryAdapter);
  setPromoteDelivery(deliveryAdapter);

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 7. Start OneCLI manual-approval handler
  startOneCLIApprovalHandler(deliveryAdapter);

  log.info('NanoClaw v2 running');
}

/** Build ConversationConfig[] for a channel type from the central DB. */
function buildConversationConfigs(channelType: string): ConversationConfig[] {
  const groups = getMessagingGroupsByChannel(channelType);
  const configs: ConversationConfig[] = [];

  for (const mg of groups) {
    const agents = getMessagingGroupAgents(mg.id);
    for (const agent of agents) {
      const triggerRules = agent.trigger_rules ? JSON.parse(agent.trigger_rules) : null;
      configs.push({
        platformId: mg.platform_id,
        agentGroupId: agent.agent_group_id,
        triggerPattern: triggerRules?.pattern,
        requiresTrigger: triggerRules?.requiresTrigger ?? false,
        sessionMode: agent.session_mode,
      });
    }
  }

  return configs;
}

/** Handle a user's response to an ask_user_question card or an approval card. */
async function handleQuestionResponse(questionId: string, selectedOption: string, userId: string): Promise<void> {
  // OneCLI credential approvals — resolved via in-memory Promise, not session DB
  if (resolveOneCLIApproval(questionId, selectedOption)) {
    return;
  }

  // Check if this is a pending approval (install_packages, request_rebuild)
  const approval = getPendingApproval(questionId);
  if (approval) {
    if (approval.action === ONECLI_ACTION) {
      // Row exists but the in-memory resolver is gone (timer fired or process
      // was in a weird state). Nothing to do — just drop the row.
      deletePendingApproval(questionId);
      return;
    }
    await handleApprovalResponse(approval, selectedOption, userId);
    return;
  }

  const pq = getPendingQuestion(questionId);
  if (!pq) {
    log.warn('Pending question not found (may have expired)', { questionId });
    return;
  }

  const session = getSession(pq.session_id);
  if (!session) {
    log.warn('Session not found for pending question', { questionId, sessionId: pq.session_id });
    deletePendingQuestion(questionId);
    return;
  }

  // Write the response to the session DB as a system message
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `qr-${questionId}-${Date.now()}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: pq.platform_id,
    channelType: pq.channel_type,
    threadId: pq.thread_id,
    content: JSON.stringify({
      type: 'question_response',
      questionId,
      selectedOption,
      userId,
    }),
  });

  deletePendingQuestion(questionId);
  log.info('Question response routed', { questionId, selectedOption, sessionId: session.id });

  // Wake the container so the MCP tool's poll picks up the response
  await wakeContainer(session);
}

/**
 * Handle an admin's response to an approval card.
 * Fire-and-forget model: the agent doesn't poll for this — we write a chat
 * notification to its session DB, and optionally kill the container so the
 * next wake picks up new config/images.
 */
async function handleApprovalResponse(
  approval: import('./types.js').PendingApproval,
  selectedOption: string,
  userId: string,
): Promise<void> {
  // Builder-agent actions are handled out-of-band from the install_packages
  // family: their session linkage is different and swap_confirmation doesn't
  // use `payload.session_id` at all (the session is derived from the swap's
  // originating_group_id). Dispatch them first.
  if (approval.action === 'swap_confirmation') {
    const payload = JSON.parse(approval.payload) as { swapRequestId?: string };
    if (payload.swapRequestId) {
      await handleSwapConfirmationResponse(approval.approval_id, payload.swapRequestId, selectedOption);
    } else {
      deletePendingApproval(approval.approval_id);
    }
    return;
  }
  if (approval.action === 'swap_request') {
    await handleSwapRequestApproval(approval, selectedOption, userId);
    return;
  }
  if (approval.action === 'promote_template') {
    const payload = JSON.parse(approval.payload) as { swapRequestId?: string };
    if (payload.swapRequestId) {
      await handlePromoteResponse(approval.approval_id, payload.swapRequestId, selectedOption);
    } else {
      deletePendingApproval(approval.approval_id);
    }
    return;
  }

  if (!approval.session_id) {
    deletePendingApproval(approval.approval_id);
    return;
  }
  const session = getSession(approval.session_id);
  if (!session) {
    deletePendingApproval(approval.approval_id);
    return;
  }

  const notify = (text: string): void => {
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    });
  };

  if (selectedOption !== 'approve') {
    notify(`Your ${approval.action} request was rejected by admin.`);
    log.info('Approval rejected', { approvalId: approval.approval_id, action: approval.action, userId });
    deletePendingApproval(approval.approval_id);
    await wakeContainer(session);
    return;
  }

  const payload = JSON.parse(approval.payload);

  if (approval.action === 'install_packages') {
    const agentGroup = getAgentGroup(session.agent_group_id);
    if (!agentGroup) {
      notify('install_packages approved but agent group missing.');
      return;
    }
    updateContainerConfig(agentGroup.folder, (cfg) => {
      if (payload.apt) cfg.packages.apt.push(...(payload.apt as string[]));
      if (payload.npm) cfg.packages.npm.push(...(payload.npm as string[]));
    });

    const pkgs = [...(payload.apt || []), ...(payload.npm || [])].join(', ');
    log.info('Package install approved', { approvalId: approval.approval_id, userId });
    try {
      await buildAgentGroupImage(session.agent_group_id);
      killContainer(session.id, 'rebuild applied');
      // Schedule a follow-up prompt a few seconds after kill so the host sweep
      // respawns the container on the new image and the agent verifies + reports.
      writeSessionMessage(session.agent_group_id, session.id, {
        id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: session.agent_group_id,
        channelType: 'agent',
        threadId: null,
        content: JSON.stringify({
          text: `Packages installed (${pkgs}) and container rebuilt. Verify the new packages are available (e.g. run them or check versions) and report the result to the user.`,
          sender: 'system',
          senderId: 'system',
        }),
        processAfter: new Date(Date.now() + 5000)
          .toISOString()
          .replace('T', ' ')
          .replace(/\.\d+Z$/, ''),
      });
      log.info('Container rebuild completed (bundled with install)', { approvalId: approval.approval_id });
    } catch (e) {
      notify(
        `Packages added to config (${pkgs}) but rebuild failed: ${e instanceof Error ? e.message : String(e)}. Call request_rebuild to retry.`,
      );
      log.error('Bundled rebuild failed after install approval', { approvalId: approval.approval_id, err: e });
    }
  } else if (approval.action === 'request_rebuild') {
    try {
      await buildAgentGroupImage(session.agent_group_id);
      // Kill the container so the next wake uses the new image
      killContainer(session.id, 'rebuild applied');
      notify('Container image rebuilt. Your container will restart with the new image on the next message.');
      log.info('Container rebuild approved and completed', { approvalId: approval.approval_id, userId });
    } catch (e) {
      notify(`Rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
      log.error('Container rebuild failed', { approvalId: approval.approval_id, err: e });
    }
  } else if (approval.action === 'add_mcp_server') {
    const agentGroup = getAgentGroup(session.agent_group_id);
    if (!agentGroup) {
      notify('add_mcp_server approved but agent group missing.');
      return;
    }
    updateContainerConfig(agentGroup.folder, (cfg) => {
      cfg.mcpServers[payload.name as string] = {
        command: payload.command as string,
        args: (payload.args as string[]) || [],
        env: (payload.env as Record<string, string>) || {},
      };
    });

    // Kill the container so next wake loads the new MCP server config
    killContainer(session.id, 'mcp server added');
    notify(`MCP server "${payload.name}" added. Your container will restart with it on the next message.`);
    log.info('MCP server add approved', { approvalId: approval.approval_id, userId });
  }

  deletePendingApproval(approval.approval_id);
  await wakeContainer(session);
}

/**
 * Handle an approver's response to a builder-agent `swap_request` card.
 * Approve → capture pre-state, apply files, commit, rebuild if needed,
 * restart, start deadman. Reject → teardown worktree + dev agent, notify.
 *
 * Kept separate from the install_packages / request_rebuild flow because:
 *   - Host-level swaps require `process.exit(0)` for supervisor respawn,
 *     which the other flows never do.
 *   - Swap state lives in `pending_swaps`, not `pending_approvals.payload`.
 */
async function handleSwapRequestApproval(
  approval: import('./types.js').PendingApproval,
  selectedOption: string,
  userId: string,
): Promise<void> {
  const payload = JSON.parse(approval.payload) as { swapRequestId?: string };
  const swapRequestId = payload.swapRequestId;
  if (!swapRequestId) {
    deletePendingApproval(approval.approval_id);
    return;
  }
  const swap = getPendingSwap(swapRequestId);
  if (!swap) {
    deletePendingApproval(approval.approval_id);
    return;
  }

  // Notify the dev agent's session about the outcome. Uses the existing
  // session for the dev agent group so the dev agent sees it as an inbound
  // chat message with sender=system.
  const { findSessionByAgentGroup } = await import('./db/sessions.js');
  const devSession = findSessionByAgentGroup(swap.dev_agent_id);
  const notifyDev = (text: string): void => {
    if (!devSession) return;
    writeSessionMessage(devSession.agent_group_id, devSession.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: devSession.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    });
  };

  if (selectedOption !== 'approve') {
    notifyDev(`Your proposed code change was rejected by ${userId}.`);
    log.info('Swap request rejected', { requestId: swapRequestId, userId, selectedOption });
    updatePendingSwapStatus(swapRequestId, 'rejected');
    try {
      removeDevWorktree(swapRequestId);
    } catch (err) {
      log.warn('Failed to remove worktree after rejection', { swapRequestId, err });
    }
    deletePendingApproval(approval.approval_id);
    return;
  }

  log.info('Swap request approved — executing swap dance', { requestId: swapRequestId, userId });

  // Swap execution. Any failure inside the try (captureSwapPreState,
  // applySwapFiles, commitSwap, npm run build, startDeadman, restart
  // orchestration) triggers a unified retryable-bail: revert any on-disk
  // changes via git, reset the pending_swaps row back to pending_approval,
  // leave the dev agent + worktree ALIVE so the dev agent can fix the
  // issue and call request_swap again. Only explicit rejection tears
  // down the dev agent.
  try {
    // 1. Capture pre-state (pre_swap_sha + DB snapshot).
    await captureSwapPreState(swapRequestId);

    // 2. Apply files from worktree to swap targets.
    const touchedAbs = applySwapFiles(swapRequestId);

    // 3. Commit the swap to main.
    const summary = parseSwapSummary(swap);
    commitSwap(swapRequestId, touchedAbs, summary.overallSummary || 'no summary');

    // 4. Host-level rebuild. If the diff touched host code that compiles
    // to dist/ (src/**, package.json, etc.), run `npm run build` now so
    // the respawned host process runs the new compiled output rather
    // than stale dist/. Group-level swaps need no rebuild — /app/src is
    // runtime-compiled inside each container on spawn, skills/CLAUDE.md
    // are mounted.
    if (requiresFullHostRebuild(touchedAbs)) {
      notifyDev('Code change applied and committed. Running `npm run build` before the host restart…');
      try {
        execFileSync('npm', ['run', 'build'], { cwd: process.cwd(), stdio: 'inherit' });
        log.info('npm run build succeeded for host-level swap', { requestId: swapRequestId });
      } catch (buildErr) {
        const msg = buildErr instanceof Error ? buildErr.message : String(buildErr);
        // Wrap with context and re-throw so the outer catch runs the
        // unified bail path.
        throw new Error(`npm run build failed: ${msg}`);
      }
    }

    // 5. Start the deadman. This sets status=awaiting_confirmation, posts
    // the handshake card, and schedules the timer. For host-level swaps
    // we then exit so the supervisor respawns the host on the new code;
    // the startup sweep will resume this deadman after restart.
    await startDeadman(swapRequestId);

    if (isHostLevelSwap(swap)) {
      notifyDev(
        'Code change applied and committed. Triggering host restart so the new code takes effect. Awaiting user confirmation after restart.',
      );
      log.warn('Host-level swap triggering process exit for supervisor respawn', {
        requestId: swapRequestId,
      });
      // Give log sinks and the deadman card delivery a moment to flush
      // before exiting.
      setTimeout(() => process.exit(0), 500);
    } else {
      // Group-level: kill the originating agent's active container so its
      // next wake respawns it with the new per-group runner/skills mounted.
      const originatingSession = findSessionByAgentGroup(swap.originating_group_id);
      if (originatingSession) {
        killContainer(originatingSession.id, 'swap applied');
      }
      notifyDev(
        'Code change applied and committed. The originating agent will restart on its next message. Awaiting user confirmation.',
      );
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error('Swap execution failed — bailing for retry', { requestId: swapRequestId, err });
    bailSwapForRetry(swapRequestId);
    notifyDev(
      `❌ Code change failed: ${errMsg}\n\n` +
        `Your worktree and dev-agent group are still alive. Review the error above, ` +
        `fix the issue in /worktree, commit, and call \`request_swap\` again to retry.`,
    );
  }

  deletePendingApproval(approval.approval_id);
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  stopOneCLIApprovalHandler();
  stopDeliveryPolls();
  stopHostSweep();
  await teardownChannelAdapters();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
