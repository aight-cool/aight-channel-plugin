#!/usr/bin/env bun
/**
 * Aight Channel Plugin — Phase 0 MVP
 * 
 * A Claude Code channel plugin that exposes a WebSocket endpoint on LAN.
 * The Aight iOS app connects directly via WebSocket to send/receive messages.
 * 
 * No relay, no cloud, no pairing codes. Just LAN.
 * 
 * Usage:
 *   1. Add to .mcp.json (or install as plugin)
 *   2. claude --dangerously-load-development-channels server:aight
 *   3. Connect Aight app to ws://<your-mac-ip>:8790
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PORT = parseInt(process.env.AIGHT_PORT || "8792", 10);

// ── Track connected app clients ──
type AppClient = {
  ws: any; // Bun WebSocket
  id: string;
  connectedAt: Date;
};

const clients = new Map<string, AppClient>();
let messageCounter = 0;

// ── MCP Server: declare as two-way channel ──
const mcp = new Server(
  { name: "aight", version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `The sender reads the Aight mobile app, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches the app.\n\nMessages from the Aight mobile app arrive as <channel source="aight" sender="..." device="..." message_id="...">. Reply with the reply tool. Keep replies concise and readable on a small screen. You can use markdown — the app renders it.`,
  }
);

// ── Tool: reply — send a message back to the app ──
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
          message_id: { type: "string", description: "Message ID to react to" },
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
    console.error(`[aight] 🎯 REPLY TOOL CALLED — text: "${text?.slice(0, 100)}" | clients: ${clients.size}`);
    const msgId = `claude_${++messageCounter}`;
    const payload = JSON.stringify({
      type: "reply",
      id: msgId,
      replyTo: reply_to || null,
      content: text,
      timestamp: new Date().toISOString(),
    });

    let sent = 0;
    for (const client of clients.values()) {
      try {
        client.ws.send(payload);
        sent++;
        console.error(`[aight] ✅ Sent reply to client ${client.id}`);
      } catch (err) {
        console.error(`[aight] ❌ Failed to send to client ${client.id}: ${err}`);
      }
    }

    const result = sent > 0 ? `sent (${sent} client${sent > 1 ? "s" : ""})` : "no clients connected";
    console.error(`[aight] Reply result: ${result}`);
    return {
      content: [{ type: "text", text: result }],
    };
  }

  if (name === "react") {
    const { emoji, message_id } = args as { emoji: string; message_id: string };
    const payload = JSON.stringify({
      type: "reaction",
      emoji,
      messageId: message_id,
      timestamp: new Date().toISOString(),
    });

    for (const client of clients.values()) {
      try {
        client.ws.send(payload);
      } catch {
        // client disconnected
      }
    }

    return {
      content: [{ type: "text", text: "reaction sent" }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});


// ── Connect to Claude Code over stdio (with debug logging) ──
const transport = new StdioServerTransport();
await mcp.connect(transport);



// ── WebSocket server for Aight app connections ──
const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0", // Listen on all interfaces (LAN accessible)

  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, {
        data: { id: `client_${Date.now()}` },
      });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    // Health / status endpoint
    if (url.pathname === "/status") {
      return Response.json({
        ok: true,
        name: "aight-channel",
        version: "0.0.1",
        clients: clients.size,
        uptime: process.uptime(),
      });
    }

    return new Response("Aight Channel Plugin\n\nWebSocket: ws://<ip>:${PORT}/ws\nStatus: /status\n", {
      headers: { "content-type": "text/plain" },
    });
  },

  websocket: {
    open(ws) {
      const id = (ws.data as any).id;
      clients.set(id, { ws, id, connectedAt: new Date() });
      // Let the app know the connection is live
      ws.send(
        JSON.stringify({
          type: "connected",
          channelName: "aight",
          timestamp: new Date().toISOString(),
        })
      );
      // Log to stderr (visible in Claude Code terminal)
      console.error(`[aight] Client connected: ${id} (${clients.size} total)`);
    },

    async message(ws, message) {
      try {
        const data = JSON.parse(String(message));

        if (data.type === "message") {
          // Forward user message to Claude Code via MCP channel notification
          const meta: Record<string, string> = {
            sender: data.sender?.name || "phone",
            device: data.sender?.device || "iPhone",
          };
          if (data.id) meta.message_id = data.id;

          console.error(`[aight] 📤 Sending notification to Claude: "${data.content?.slice(0, 100)}"`);
          try {
            await mcp.notification({
              method: "notifications/claude/channel",
              params: {
                content: data.content,
                meta,
              },
            });
            console.error(`[aight] ✅ Notification sent successfully`);
          } catch (notifErr) {
            console.error(`[aight] ❌ Notification FAILED: ${notifErr}`);
          }

          // Acknowledge receipt to app
          ws.send(
            JSON.stringify({
              type: "ack",
              messageId: data.id,
              timestamp: new Date().toISOString(),
            })
          );

          // Send typing indicator to app (Claude is now processing)
          ws.send(
            JSON.stringify({
              type: "typing",
              timestamp: new Date().toISOString(),
            })
          );
        }

        if (data.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
        }
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Invalid message format. Expected JSON.",
            timestamp: new Date().toISOString(),
          })
        );
      }
    },

    close(ws) {
      const id = (ws.data as any).id;
      clients.delete(id);
      console.error(`[aight] Client disconnected: ${id} (${clients.size} total)`);
    },
  },
});

// Print connection info to stderr (visible in Claude Code terminal, not sent over stdio)
import qrcode from "qrcode-terminal";
const networkInterfaces = Object.values(require("os").networkInterfaces()).flat();
const lanIps = (networkInterfaces as any[])
  .filter((i: any) => i && i.family === "IPv4" && !i.internal)
  .map((i: any) => i.address);

console.error(`\n[aight] ⚡ Aight Channel Plugin running`);
console.error(`[aight] Local:  ws://localhost:${PORT}/ws`);
for (const ip of lanIps) {
  console.error(`[aight] LAN:    ws://${ip}:${PORT}/ws`);
}
console.error(`[aight] Status: http://localhost:${PORT}/status`);

// Show QR code for the first LAN IP (scan from Aight app to connect)
if (lanIps.length > 0) {
  const wsUrl = `ws://${lanIps[0]}:${PORT}/ws`;
  console.error(`\n[aight] Scan this QR code in the Aight app to connect:\n`);
  qrcode.generate(wsUrl, { small: true }, (code: string) => {
    // qrcode-terminal outputs to stdout by default, redirect to stderr
    for (const line of code.split("\n")) {
      console.error(`  ${line}`);
    }
    console.error("");
  });
}
