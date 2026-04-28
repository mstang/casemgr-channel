#!/usr/bin/env bun
/**
 * Quick test: verify MCP client can connect to CaseMgr and list work items.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CASEMGR_TOKEN = process.env.CASEMGR_TOKEN;
const CASEMGR_URL = process.env.CASEMGR_URL || "https://casemgr.systems/mcp";

if (!CASEMGR_TOKEN) {
  console.error("CASEMGR_TOKEN not set");
  process.exit(1);
}

async function main() {
  console.log(`Connecting to ${CASEMGR_URL}...`);

  const transport = new StreamableHTTPClientTransport(new URL(CASEMGR_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${CASEMGR_TOKEN}` },
    },
  });

  const client = new Client({ name: "test-client", version: "0.1.0" });

  try {
    await client.connect(transport);
    console.log("Connected!");
    console.log("Server:", client.getServerVersion());

    // List available tools (just show count + first few names)
    const tools = await client.listTools();
    console.log(`\nAvailable tools: ${tools.tools.length}`);
    console.log(
      "First 10:",
      tools.tools.slice(0, 10).map((t) => t.name)
    );

    // Try listing pending work items
    console.log("\nCalling ai-list_work_items (status=pending)...");
    const result = await client.callTool({
      name: "ai-list_work_items",
      arguments: { status: "pending" },
    });

    if (result.isError) {
      console.error("Error:", result);
    } else {
      const text = (result.content as any[]).find(
        (c) => c.type === "text"
      )?.text;
      if (text) {
        const data = JSON.parse(text);
        console.log(`Pending work items: ${data.count}`);
        if (data.items?.length > 0) {
          for (const item of data.items) {
            console.log(`  - ${item.id}: ${item.name} (${item.status})`);
          }
        }
      }
    }

    // Also check count
    console.log("\nCalling ai-count_pending...");
    const countResult = await client.callTool({
      name: "ai-count_pending",
      arguments: {},
    });
    const countText = (countResult.content as any[]).find(
      (c) => c.type === "text"
    )?.text;
    if (countText) {
      console.log("Result:", JSON.parse(countText));
    }
  } finally {
    await client.close();
    console.log("\nDone.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
