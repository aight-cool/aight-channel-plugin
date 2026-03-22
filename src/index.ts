#!/usr/bin/env bun
/**
 * Aight Channel Plugin
 *
 * A Claude Code channel plugin that lets you chat with your session from your phone.
 * Connects to the Cloudflare relay at channels.aight.cool for pairing.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:aight
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { RelayClient } from "./relay-client";

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const RELAY_URL = process.env.AIGHT_RELAY_URL || "https://channels.aight.cool";
const STATE_DIR = join(homedir(), ".claude", "channels", "aight");
const CODE_FILE = join(STATE_DIR, "pairing-code.txt");

// ── Shared client tracking ──
type SendFn = (data: object) => void;

// All connected "senders" — either local WebSocket clients or the relay client
const senders: Map<string, SendFn> = new Map();
let messageCounter = 0;

/** Broadcast payload to all connected senders, pruning failed ones. */
function broadcast(payload: object): number {
  let sent = 0;
  for (const [id, send] of senders) {
    try {
      send(payload);
      sent++;
    } catch (err) {
      console.error(`[aight] Failed to send to ${id}: ${err}`);
      senders.delete(id);
    }
  }
  return sent;
}

function sentResult(sent: number, verb = "sent"): string {
  return sent > 0
    ? `${verb} (${sent} client${sent > 1 ? "s" : ""})`
    : "no clients connected";
}

// ── MCP Server ──
const mcp = new Server(
  { name: "aight", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `The sender reads the Aight mobile app, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches the app.\n\nMessages from the Aight mobile app arrive as <channel source="aight" sender="..." device="..." message_id="...">. Reply with the reply tool. Keep replies concise and readable on a small screen. You can use markdown — the app renders it.`,
  },
);

// ── Tools: reply + react ──
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a message back to the Aight mobile app",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: "The message text to send (supports markdown)",
          },
          reply_to: {
            type: "string",
            description: "Optional: ID of the message being replied to",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "react",
      description: "Send an emoji reaction to a message in the Aight app",
      inputSchema: {
        type: "object" as const,
        properties: {
          emoji: { type: "string", description: "Emoji to react with" },
          message_id: {
            type: "string",
            description: "Message ID to react to",
          },
        },
        required: ["emoji", "message_id"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "reply") {
    const { text, reply_to } = args as { text: string; reply_to?: string };
    const msgId = `claude_${++messageCounter}`;
    const payload = {
      type: "reply",
      id: msgId,
      replyTo: reply_to || null,
      content: text,
      timestamp: new Date().toISOString(),
    };

    const sent = broadcast(payload);
    return { content: [{ type: "text", text: sentResult(sent) }] };
  }

  if (name === "react") {
    const { emoji, message_id } = args as {
      emoji: string;
      message_id: string;
    };
    const payload = {
      type: "reaction",
      emoji,
      messageId: message_id,
      timestamp: new Date().toISOString(),
    };

    const sent = broadcast(payload);
    return { content: [{ type: "text", text: sentResult(sent, "reaction sent") }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ── Shared: forward a message from the app to Claude via MCP ──
async function forwardToMCP(data: {
  type: string;
  id?: string;
  content?: string;
  sender?: { name?: string; device?: string };
}): Promise<void> {
  if (data.type === "message" && data.content) {
    const meta: Record<string, string> = {
      sender: data.sender?.name || "phone",
      device: data.sender?.device || "iPhone",
    };
    if (data.id) meta.message_id = data.id;

    console.error(
      `[aight] 📤 Message from app: "${data.content.slice(0, 100)}"`,
    );

    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: { content: data.content, meta },
      });
    } catch (err) {
      console.error(`[aight] ❌ MCP notification failed: ${err}`);
    }
  }
}

// ── Connect to Claude Code over stdio ──
const transport = new StdioServerTransport();
await mcp.connect(transport);

// ── Connect to relay ──
console.error(`\n[aight] ⚡ Connecting to relay at ${RELAY_URL}`);

const relay = new RelayClient(RELAY_URL, {
  onMessage: async (data) => {
    await forwardToMCP(data);

    if (data.type === "message" && data.id) {
      relay.send({
        type: "ack",
        messageId: data.id,
        timestamp: new Date().toISOString(),
      });
      relay.send({
        type: "typing",
        timestamp: new Date().toISOString(),
      });
    }

    if (data.type === "ping") {
      relay.send({
        type: "pong",
        timestamp: new Date().toISOString(),
      });
    }
  },
  onStateChange: (state) => {
    console.error(`[aight-relay] State: ${state}`);
    if (state === "connected") {
      senders.set("relay", (data) => relay.send(data));
    } else {
      senders.delete("relay");
    }

    // Surface connection state to Claude
    if (state === "error") {
      mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: "⚠️ Aight relay connection failed. Check that channels.aight.cool is reachable.",
          meta: { sender: "aight-plugin", device: "system" },
        },
      }).catch(() => {});
    }
  },
  onPairingCode: (code, relayUrl) => {
    process.stderr.write(`\n[aight] ════════════════════════════════════════\n`);
    process.stderr.write(`[aight]   📱 Pairing Code: ${code}\n`);
    process.stderr.write(`[aight] ════════════════════════════════════════\n`);
    process.stderr.write(`[aight]   Enter this code in the Aight app to connect.\n`);
    process.stderr.write(`[aight]   Code expires in 5 minutes.\n\n`);

    // Write code to file so it's always accessible
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(CODE_FILE, `${code}\n`);
      process.stderr.write(`[aight]   Code also written to: ${CODE_FILE}\n\n`);
    } catch (err) {
      process.stderr.write(`[aight] ⚠️  Failed to write code file: ${err}\n`);
    }

    // Send pairing code via MCP notification so Claude can display it
    mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: `📱 Aight Pairing Code: ${code} — enter this in the Aight app to connect (expires in 5 min)`,
        meta: { sender: "aight-plugin", device: "system" },
      },
    }).catch(() => {});
  },
});

await relay.start();
