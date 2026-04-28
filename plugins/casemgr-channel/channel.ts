#!/usr/bin/env bun
/**
 * CaseMgr Channel Server for Claude Code
 *
 * Bridges CaseMgr AI work items into a running Claude Code session.
 * Connects to CaseMgr's SSE endpoint for real-time events, with MCP
 * polling as fallback if SSE is unavailable or disconnects.
 *
 * Environment variables:
 *   CASEMGR_TOKEN    - Bearer token for CaseMgr API (required)
 *   CASEMGR_URL      - CaseMgr base URL (default: https://casemgr.systems)
 *   POLL_INTERVAL_MS - Fallback poll interval in ms (default: 30000)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// --- Configuration ---

const CASEMGR_TOKEN = process.env.CASEMGR_TOKEN;
const CASEMGR_BASE_URL = (process.env.CASEMGR_URL || "https://casemgr.systems").replace(/\/mcp$/, "");
const CASEMGR_MCP_URL = `${CASEMGR_BASE_URL}/mcp`;
const CASEMGR_SSE_URL = `${CASEMGR_BASE_URL}/api/ai/events`;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);

if (!CASEMGR_TOKEN) {
  log("Error: CASEMGR_TOKEN environment variable is required");
  process.exit(1);
}

// --- Logging ---

const LOG_FILE = `${process.env.HOME}/.claude/channels/casemgr-channel.log`;

function log(msg: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}`;
  console.error(line);
  try {
    Bun.file(LOG_FILE).writer().write(line + "\n");
  } catch {
    // Log file writing is best-effort
  }
}

// --- State ---

// Track last poll time for timestamp-based dedup (survives better than ID set)
let lastPollTime: string | null = null;
// Also track notified IDs within a session for SSE events (which don't have timestamps)
const notifiedItems = new Set<string>();
// Reconnection backoff state
let consecutiveFailures = 0;
const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes max
// SSE state
let sseConnected = false;
let sseAbortController: AbortController | null = null;

// MCP client connection to CaseMgr (lazy-initialized)
let casemgrClient: Client | null = null;
let casemgrTransport: StreamableHTTPClientTransport | null = null;

// --- Channel Server (MCP Server → Claude Code over stdio) ---

const channelServer = new Server(
  { name: "casemgr-channel", version: "0.2.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
    },
    instructions: [
      "Events from <channel source=\"casemgr-channel\"> are AI work items from CaseMgr that need to be executed.",
      "When you receive a work item event:",
      "1. Call ai-claim_work_item with the work_item_id from the event",
      "2. Read the task details (the prompt/instructions are in the event content)",
      "3. Execute the work described in the task using the appropriate CaseMgr tools",
      "4. Call ai-complete_work_item with the work_item_id and a summary of what you did",
      "5. If the work fails, call ai-fail_work_item with the work_item_id and error description",
      "",
      "Use the existing casemgr MCP server tools (cases-get, items-list, items-create, etc.) to do the actual work.",
      "This channel is one-way — do NOT try to reply through it.",
    ].join("\n"),
  }
);

// --- CaseMgr MCP Client (connects to remote CaseMgr for polling fallback) ---

async function connectToCaseMgr(): Promise<Client> {
  if (casemgrClient) return casemgrClient;

  casemgrTransport = new StreamableHTTPClientTransport(
    new URL(CASEMGR_MCP_URL),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${CASEMGR_TOKEN}`,
        },
      },
    }
  );

  casemgrClient = new Client({
    name: "casemgr-channel-poller",
    version: "0.2.0",
  });

  await casemgrClient.connect(casemgrTransport);
  log(`Connected to CaseMgr MCP at ${CASEMGR_MCP_URL}`);
  consecutiveFailures = 0;

  return casemgrClient;
}

async function disconnectFromCaseMgr(): Promise<void> {
  if (casemgrClient) {
    try {
      await casemgrClient.close();
    } catch {
      // Ignore close errors
    }
    casemgrClient = null;
    casemgrTransport = null;
  }
}

// --- Notification Pushing ---

interface WorkItem {
  id: string;
  name: string;
  status: string;
  case_id?: string;
  agent_type?: string;
  prompt?: string;
  priority?: string;
  created_at?: string;
}

async function pushWorkItem(item: WorkItem): Promise<void> {
  if (notifiedItems.has(item.id)) return;
  notifiedItems.add(item.id);

  const content = [
    `AI Work Item: ${item.name}`,
    `Work Item ID: ${item.id}`,
    item.case_id ? `Case ID: ${item.case_id}` : null,
    item.agent_type ? `Agent Type: ${item.agent_type}` : null,
    item.priority ? `Priority: ${item.priority}` : null,
    item.prompt ? `\nTask:\n${item.prompt}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  await channelServer.notification({
    method: "notifications/claude/channel",
    params: {
      content,
      meta: {
        work_item_id: item.id,
        case_id: item.case_id || "",
        event_type: "ai_work_item",
        agent_type: item.agent_type || "",
        priority: item.priority || "medium",
      },
    },
  });

  log(`Pushed work item: ${item.id} - ${item.name}`);
}

// --- SSE Connection (Primary) ---

async function connectSSE(): Promise<void> {
  sseAbortController = new AbortController();

  log(`Connecting to SSE at ${CASEMGR_SSE_URL}`);

  try {
    const response = await fetch(CASEMGR_SSE_URL, {
      headers: {
        Authorization: `Bearer ${CASEMGR_TOKEN}`,
        Accept: "text/event-stream",
      },
      signal: sseAbortController.signal,
    });

    if (!response.ok) {
      log(`SSE connection failed: ${response.status} ${response.statusText}`);
      sseConnected = false;
      return;
    }

    if (!response.body) {
      log("SSE: no response body");
      sseConnected = false;
      return;
    }

    sseConnected = true;
    consecutiveFailures = 0;
    log("SSE connected — listening for work item events");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      let eventType = "";
      let eventData = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          eventData = line.slice(6);
        } else if (line === "" && eventData) {
          // End of event — process it
          if (eventType === "ai_work_item") {
            try {
              const parsed = JSON.parse(eventData);
              if (parsed.work_item) {
                await pushWorkItem(parsed.work_item);
              }
            } catch (err: any) {
              log(`SSE parse error: ${err.message}`);
            }
          }
          eventType = "";
          eventData = "";
        }
      }
    }

    // Stream ended normally
    log("SSE stream ended");
    sseConnected = false;
  } catch (err: any) {
    if (err.name === "AbortError") {
      log("SSE connection aborted");
    } else {
      log(`SSE error: ${err.message}`);
    }
    sseConnected = false;
  }
}

function disconnectSSE(): void {
  if (sseAbortController) {
    sseAbortController.abort();
    sseAbortController = null;
  }
  sseConnected = false;
}

// --- Polling Fallback ---

async function pollForWorkItems(): Promise<void> {
  try {
    const client = await connectToCaseMgr();

    const result = await client.callTool({
      name: "ai-list_work_items",
      arguments: { status: "pending" },
    });

    if (!result.content || result.isError) {
      throw new Error(`Poll returned error: ${JSON.stringify(result)}`);
    }

    const textContent = result.content.find(
      (c: any) => c.type === "text"
    ) as any;
    if (!textContent?.text) return;

    let data: any;
    try {
      data = JSON.parse(textContent.text);
    } catch {
      throw new Error(`Failed to parse poll response: ${textContent.text}`);
    }

    if (!data.success || !data.items || data.items.length === 0) {
      consecutiveFailures = 0;
      return;
    }

    // Filter by created_at if we have a last poll time
    for (const item of data.items as WorkItem[]) {
      if (lastPollTime && item.created_at && item.created_at <= lastPollTime) {
        // Already seen in a previous poll cycle — skip unless it's new to this session
        if (notifiedItems.has(item.id)) continue;
      }
      await pushWorkItem(item);
    }

    // Update last poll time to the most recent item
    const mostRecent = data.items.reduce((latest: string, item: WorkItem) => {
      return item.created_at && item.created_at > latest ? item.created_at : latest;
    }, lastPollTime || "");
    if (mostRecent) lastPollTime = mostRecent;

    consecutiveFailures = 0;
  } catch (err: any) {
    consecutiveFailures++;

    if (err.message?.includes("connect") || err.message?.includes("fetch") || err.message?.includes("ECONNREFUSED")) {
      log(`Connection error (attempt ${consecutiveFailures}), will retry: ${err.message}`);
      await disconnectFromCaseMgr();
    } else {
      log(`Poll error (attempt ${consecutiveFailures}): ${err.message || err}`);
    }

    // Alert Claude after 5 consecutive failures
    if (consecutiveFailures === 5) {
      try {
        await channelServer.notification({
          method: "notifications/claude/channel",
          params: {
            content: `Warning: CaseMgr channel has failed to poll ${consecutiveFailures} consecutive times. Last error: ${err.message}. The channel will continue retrying with backoff.`,
            meta: { event_type: "channel_health", severity: "warning" },
          },
        });
      } catch {
        // Can't notify Claude — just log
      }
    }
  }
}

// --- Main Loop ---

async function sseWithPollingFallback(): Promise<void> {
  // Try SSE first
  log("Attempting SSE connection...");
  const ssePromise = connectSSE();

  // Give SSE 3 seconds to connect
  await new Promise((resolve) => setTimeout(resolve, 3000));

  if (sseConnected) {
    log("SSE active — polling disabled");
    // SSE is connected, wait for it to end
    await ssePromise;
    // SSE disconnected — fall through to polling
    log("SSE disconnected — falling back to polling");
  } else {
    log("SSE unavailable — using polling mode");
    disconnectSSE();
  }

  // Polling fallback loop
  while (true) {
    await pollForWorkItems();

    // Exponential backoff on failures
    const backoff = consecutiveFailures > 0
      ? Math.min(POLL_INTERVAL_MS * Math.pow(2, consecutiveFailures - 1), MAX_BACKOFF_MS)
      : POLL_INTERVAL_MS;

    await new Promise((resolve) => setTimeout(resolve, backoff));

    // Periodically try to reconnect SSE (every 5 minutes)
    if (!sseConnected && consecutiveFailures === 0) {
      const sseRetry = connectSSE();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (sseConnected) {
        log("SSE reconnected — switching back from polling");
        await sseRetry;
        log("SSE disconnected again — resuming polling");
      } else {
        disconnectSSE();
      }
    }
  }
}

async function main(): Promise<void> {
  // Ensure log directory exists
  try {
    const dir = LOG_FILE.substring(0, LOG_FILE.lastIndexOf("/"));
    await Bun.$`mkdir -p ${dir}`.quiet();
  } catch { /* ignore */ }

  // Connect channel server to Claude Code over stdio
  await channelServer.connect(new StdioServerTransport());
  log("Channel server started (v0.2.0)");

  // Do an initial poll to catch any pending items
  await pollForWorkItems();

  // Start SSE with polling fallback
  sseWithPollingFallback().catch((err) => {
    log(`Fatal loop error: ${err.message}`);
  });

  // Handle shutdown
  const shutdown = async () => {
    log("Shutting down...");
    disconnectSSE();
    await disconnectFromCaseMgr();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log(`Fatal error: ${err}`);
  process.exit(1);
});
