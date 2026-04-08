import { getPendingMessages, markProcessing, markCompleted, touchProcessing } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { formatMessages, extractRouting, type RoutingContext } from './formatter.js';
import type { AgentProvider, AgentQuery, McpServerConfig, ProviderEvent } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;
const IDLE_END_MS = 20_000; // End stream after 20s with no SDK events

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  cwd: string;
  mcpServers: Record<string, McpServerConfig>;
  systemPrompt?: string;
  env: Record<string, string | undefined>;
  additionalDirectories?: string[];
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  let sessionId: string | undefined;
  let resumeAt: string | undefined;

  while (true) {
    const messages = getPendingMessages();

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    log(`Processing ${messages.length} message(s), kinds: ${[...new Set(messages.map((m) => m.kind))].join(',')}`);

    // Set routing context as env vars for MCP tools
    setRoutingEnv(routing, config.env);

    const query = config.provider.query({
      prompt,
      sessionId,
      resumeAt,
      cwd: config.cwd,
      mcpServers: config.mcpServers,
      systemPrompt: config.systemPrompt,
      env: config.env,
      additionalDirectories: config.additionalDirectories,
    });

    // Process the query while concurrently polling for new messages
    try {
      const result = await processQuery(query, routing, config, ids);
      if (result.sessionId) sessionId = result.sessionId;
      if (result.resumeAt) resumeAt = result.resumeAt;
    } catch (err) {
      log(`Query error: ${err instanceof Error ? err.message : String(err)}`);
      // Write error response so the user knows something went wrong
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: `Error: ${err instanceof Error ? err.message : String(err)}` }),
      });
    }

    markCompleted(ids);
    log(`Completed ${ids.length} message(s)`);
  }
}

interface QueryResult {
  sessionId?: string;
  resumeAt?: string;
}

async function processQuery(query: AgentQuery, routing: RoutingContext, config: PollLoopConfig, processingIds: string[]): Promise<QueryResult> {
  let querySessionId: string | undefined;
  let done = false;
  let lastEventTime = Date.now();

  // Concurrent polling: push follow-ups, checkpoint WAL, detect idle
  const pollHandle = setInterval(() => {
    if (done) return;

    const newMessages = getPendingMessages();
    if (newMessages.length > 0) {
      const newIds = newMessages.map((m) => m.id);
      markProcessing(newIds);

      const prompt = formatMessages(newMessages);
      log(`Pushing ${newMessages.length} follow-up message(s) into active query`);
      query.push(prompt);

      const newRouting = extractRouting(newMessages);
      setRoutingEnv(newRouting, config.env);

      markCompleted(newIds);
      lastEventTime = Date.now(); // new input counts as activity
    }

    // End stream when agent is idle: no SDK events and no pending messages
    if (Date.now() - lastEventTime > IDLE_END_MS) {
      log(`No SDK events for ${IDLE_END_MS / 1000}s, ending query`);
      query.end();
    }
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      lastEventTime = Date.now();
      handleEvent(event, routing);
      touchProcessing(processingIds);

      if (event.type === 'init') {
        querySessionId = event.sessionId;
      } else if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: generateId(),
          in_reply_to: routing.inReplyTo,
          kind: routing.channelType ? 'chat' : 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }
  } finally {
    done = true;
    clearInterval(pollHandle);
  }

  return { sessionId: querySessionId };
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.sessionId}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(`Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`);
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
  }
}

function setRoutingEnv(routing: RoutingContext, env: Record<string, string | undefined>): void {
  env.NANOCLAW_PLATFORM_ID = routing.platformId ?? undefined;
  env.NANOCLAW_CHANNEL_TYPE = routing.channelType ?? undefined;
  env.NANOCLAW_THREAD_ID = routing.threadId ?? undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
