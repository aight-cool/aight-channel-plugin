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

import { writeFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync, statSync } from "fs";
import { join, extname, basename } from "path";
import { homedir } from "os";

const RELAY_URL = process.env.AIGHT_RELAY_URL || "https://channels.aight.cool";
const STATE_DIR = join(homedir(), ".claude", "channels", "aight");
const INBOX_DIR = join(STATE_DIR, "inbox");
const HOOK_PORT = parseInt(process.env.AIGHT_HOOK_PORT || "0", 10); // 0 = auto-assign
// No session persistence — each Claude instance gets its own relay session.
// The DO expires after 30 min of inactivity anyway, making persistence unreliable.

// Per-process pairing code file — avoids collisions when multiple
// Claude Code sessions run simultaneously
const CODE_FILE = join(STATE_DIR, `pairing-code-${process.pid}.txt`);

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
          files: {
            type: "array",
            items: { type: "string" },
            description: "Optional: absolute file paths to attach (images render inline)",
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
    const { text, reply_to, files } = args as {
      text: string;
      reply_to?: string;
      files?: string[];
    };
    const msgId = `claude_${++messageCounter}`;

    // Encode file attachments for the app
    const attachments: Array<{ fileName: string; mimeType: string; data: string }> = [];
    if (files?.length) {
      for (const filePath of files) {
        const encoded = readFileAsBase64(filePath);
        if (encoded) {
          attachments.push({
            fileName: basename(filePath),
            mimeType: encoded.mimeType,
            data: encoded.data,
          });
        }
      }
    }

    const payload: Record<string, unknown> = {
      type: "reply",
      id: msgId,
      replyTo: reply_to || null,
      content: text,
      sender: {
        id: "claude",
        name: "Claude",
        emoji: "🤖",
        username: "claude",
      },
      timestamp: new Date().toISOString(),
    };
    if (attachments.length > 0) payload.attachments = attachments;

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
    return {
      content: [{ type: "text", text: sentResult(sent, "reaction sent") }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ── Attachment helpers ──
interface InboundAttachment {
  fileName: string;
  mimeType: string;
  content: string; // base64
}

function saveAttachment(att: InboundAttachment): string {
  mkdirSync(INBOX_DIR, { recursive: true });
  const ts = Date.now();
  const safeName = att.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = join(INBOX_DIR, `${ts}-${safeName}`);
  const buffer = Buffer.from(att.content, "base64");
  writeFileSync(filePath, buffer, { mode: 0o600 });
  console.error(`[aight] 📎 Saved attachment: ${filePath} (${buffer.length} bytes)`);
  return filePath;
}

function readFileAsBase64(filePath: string): { data: string; mimeType: string } | null {
  try {
    const buffer = readFileSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
      ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
    };
    return {
      data: buffer.toString("base64"),
      mimeType: mimeMap[ext] || "application/octet-stream",
    };
  } catch {
    return null;
  }
}

// Clean up old inbox files (>24h)
function cleanInbox(): void {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const f of readdirSync(INBOX_DIR)) {
      const p = join(INBOX_DIR, f);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch { /* skip */ }
    }
  } catch { /* inbox doesn't exist yet */ }
}

// ── Shared: forward a message from the app to Claude via MCP ──
async function forwardToMCP(data: {
  type: string;
  id?: string;
  content?: string;
  sender?: { name?: string; device?: string };
  attachments?: InboundAttachment[];
}): Promise<void> {
  if (data.type === "message" && data.content) {
    const meta: Record<string, string> = {
      sender: data.sender?.name || "phone",
      device: data.sender?.device || "iPhone",
    };
    if (data.id) meta.message_id = data.id;

    // Save attachments and include file paths in meta
    if (data.attachments?.length) {
      const paths = data.attachments.map(saveAttachment);
      meta.file_path = paths[0]; // Primary file path for Claude to Read
      if (paths.length > 1) meta.file_paths = paths.join(",");
    }

    console.error(
      `[aight] 📤 Message from app: "${data.content.slice(0, 100)}"${data.attachments?.length ? ` (${data.attachments.length} attachments)` : ""}`,
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

// ── Cleanup PID-specific files on exit ──
function cleanupOnExit() {
  try { unlinkSync(CODE_FILE); } catch { /* already gone */ }
  try { unlinkSync(join(STATE_DIR, `hook-port-${process.pid}.txt`)); } catch { /* already gone */ }
}
process.on("exit", cleanupOnExit);
process.on("SIGINT", () => { cleanupOnExit(); process.exit(0); });
process.on("SIGTERM", () => { cleanupOnExit(); process.exit(0); });

// ── Clean old inbox files ──
cleanInbox();

// ── Hook event HTTP server ──
// Claude Code hooks POST tool events here. We forward them through the relay.
const hookServer = Bun.serve({
  port: HOOK_PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    if (req.method === "POST" && new URL(req.url).pathname === "/hook-event") {
      try {
        const event = await req.json();
        const hookEvent = event.hook_event_name;
        const toolName = event.tool_name;
        const toolInput = event.tool_input;
        const toolResult = event.tool_result;

        // Forward tool events to the app via relay
        if (hookEvent === "PreToolUse" || hookEvent === "PostToolUse" || hookEvent === "PostToolUseFailure") {
          // Summarize input for display (avoid sending huge payloads)
          let inputSummary = "";
          if (toolInput) {
            if (toolName === "Bash" && toolInput.command) {
              inputSummary = toolInput.command.slice(0, 200);
            } else if (toolName === "Read" && toolInput.file_path) {
              inputSummary = toolInput.file_path;
            } else if (toolName === "Edit" && toolInput.file_path) {
              inputSummary = toolInput.file_path;
            } else if (toolName === "Write" && toolInput.file_path) {
              inputSummary = toolInput.file_path;
            } else {
              inputSummary = JSON.stringify(toolInput).slice(0, 200);
            }
          }

          broadcast({
            type: "tool_event",
            event: hookEvent === "PreToolUse" ? "start" :
                   hookEvent === "PostToolUse" ? "end" : "error",
            tool: toolName,
            input: inputSummary,
            ...(hookEvent === "PostToolUseFailure" && toolResult
              ? { error: String(toolResult).slice(0, 200) }
              : {}),
            timestamp: new Date().toISOString(),
          });
        }

        // Forward subagent events
        if (hookEvent === "SubagentStart" || hookEvent === "SubagentStop") {
          broadcast({
            type: "tool_event",
            event: hookEvent === "SubagentStart" ? "subagent_start" : "subagent_end",
            tool: "SubAgent",
            input: event.session_id || "",
            timestamp: new Date().toISOString(),
          });
        }

        return Response.json({ ok: true });
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
    }
    return new Response("Not found", { status: 404 });
  },
});

const hookPort = hookServer.port;
// Write hook port so hook config can reference it
mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(join(STATE_DIR, `hook-port-${process.pid}.txt`), String(hookPort), { mode: 0o600 });
console.error(`[aight] 🪝 Hook server listening on http://127.0.0.1:${hookPort}/hook-event`);
console.error(`[aight]   Configure hooks in .claude/settings.json:`);
console.error(`[aight]   "hooks": { "PreToolUse": [{ "type": "http", "url": "http://127.0.0.1:${hookPort}/hook-event" }], "PostToolUse": [{ "type": "http", "url": "http://127.0.0.1:${hookPort}/hook-event" }] }`);

// ── Connect to Claude Code over stdio ──
const transport = new StdioServerTransport();
await mcp.connect(transport);

// ── Connect to relay ──
console.error(`\n[aight] ⚡ Connecting to relay at ${RELAY_URL}`);

const relay = new RelayClient(
  RELAY_URL,
  {
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
      mcp
        .notification({
          method: "notifications/claude/channel",
          params: {
            content:
              "⚠️ Aight relay connection failed. Check that channels.aight.cool is reachable.",
            meta: { sender: "aight-plugin", device: "system" },
          },
        })
        .catch(() => {});
    }
  },
  onPairingCode: (code, relayUrl) => {
    process.stderr.write(
      `\n[aight] ════════════════════════════════════════\n`,
    );
    process.stderr.write(`[aight]   📱 Pairing Code: ${code}\n`);
    process.stderr.write(`[aight] ════════════════════════════════════════\n`);
    process.stderr.write(
      `[aight]   Enter this code in the Aight app to connect.\n`,
    );
    process.stderr.write(`[aight]   Code expires in 5 minutes.\n\n`);

    // Write code to file so it's always accessible
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      writeFileSync(CODE_FILE, `${code}\n`, { mode: 0o600 });
      process.stderr.write(`[aight]   Code also written to: ${CODE_FILE}\n\n`);
    } catch (err) {
      process.stderr.write(`[aight] ⚠️  Failed to write code file: ${err}\n`);
    }

    // Send pairing code via MCP notification so Claude can display it
    mcp
      .notification({
        method: "notifications/claude/channel",
        params: {
          content: `📱 Aight Pairing Code: ${code} — enter this in the Aight app to connect (expires in 5 min)`,
          meta: { sender: "aight-plugin", device: "system" },
        },
      })
      .catch(() => {});
  },
  },
);

await relay.start();
