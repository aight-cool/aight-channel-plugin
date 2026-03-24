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
import { discoverSkills } from "./skills";
import { type InboundMessage, type InboundAttachment, LIMITS } from "./protocol";
import {
  MIME_MAP,
  sanitizeFileName,
  createRateLimiter,
  cleanStalePidFiles,
  cleanInbox,
  mapHookEvent,
  mapSubagentEvent,
  summarizeToolInput,
} from "./utils";

import { writeFileSync, mkdirSync, readFileSync, unlinkSync, statSync } from "fs";
import { join, extname, basename } from "path";
import { homedir } from "os";

const RELAY_URL = process.env.AIGHT_RELAY_URL || "https://channels.aight.cool";
const STATE_DIR = join(homedir(), ".claude", "channels", "aight");
const INBOX_DIR = join(STATE_DIR, "inbox");
const HOOK_PORT = parseInt(process.env.AIGHT_HOOK_PORT || "0", 10);
const CODE_FILE = join(STATE_DIR, `pairing-code-${process.pid}.txt`);

// Ensure state directories exist once at startup
mkdirSync(INBOX_DIR, { recursive: true });

const rateLimiter = createRateLimiter();

// ── Shared client tracking ──
type SendFn = (data: object) => void;
const senders: Map<string, SendFn> = new Map();
let messageCounter = 0;

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
  { name: "aight", version: "0.3.0" },
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
            description:
              "Optional: absolute file paths to attach (images render inline)",
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
      sender: { id: "claude", name: "Claude", emoji: "\u{1F916}", username: "claude" },
      timestamp: new Date().toISOString(),
    };
    if (attachments.length > 0) payload.attachments = attachments;

    const sent = broadcast(payload);
    return { content: [{ type: "text", text: sentResult(sent) }] };
  }

  if (name === "react") {
    const { emoji, message_id } = args as { emoji: string; message_id: string };
    const sent = broadcast({
      type: "reaction",
      emoji,
      messageId: message_id,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: "text", text: sentResult(sent, "reaction sent") }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ── Attachment helpers ──

function saveAttachment(att: InboundAttachment): string {
  const ts = Date.now();
  const safeName = sanitizeFileName(att.fileName);
  const filePath = join(INBOX_DIR, `${ts}-${safeName}`);
  const buffer = Buffer.from(att.content, "base64");
  writeFileSync(filePath, buffer, { mode: 0o600 });
  console.error(`[aight] Saved attachment: ${filePath} (${buffer.length} bytes)`);
  return filePath;
}

function readFileAsBase64(filePath: string): { data: string; mimeType: string } | null {
  try {
    const stat = statSync(filePath);
    if (stat.size > LIMITS.MAX_OUTBOUND_FILE_SIZE) {
      console.error(
        `[aight] File too large to attach: ${filePath} (${Math.round(stat.size / 1_048_576)}MB > ${LIMITS.MAX_OUTBOUND_FILE_SIZE / 1_048_576}MB)`,
      );
      return null;
    }
    const buffer = readFileSync(filePath);
    const ext = extname(filePath).toLowerCase();
    return {
      data: buffer.toString("base64"),
      mimeType: MIME_MAP[ext] ?? "application/octet-stream",
    };
  } catch (err) {
    console.error(`[aight] Failed to read file for attachment: ${filePath}: ${err}`);
    return null;
  }
}

// ── Forward a message from the app to Claude via MCP ──
async function forwardToMCP(data: InboundMessage): Promise<void> {
  if (data.type !== "message") return;

  if (!rateLimiter.allow()) {
    console.error("[aight] Rate limit exceeded, dropping message");
    return;
  }

  const meta: Record<string, string> = {
    sender: data.sender?.name || "phone",
    device: data.sender?.device || "iPhone",
  };
  if (data.id) meta.message_id = data.id;

  if (data.attachments?.length) {
    const paths: string[] = [];
    for (const att of data.attachments) {
      try {
        paths.push(saveAttachment(att));
      } catch (err) {
        console.error(`[aight] Failed to save attachment: ${err}`);
      }
    }
    if (paths.length > 0) {
      meta.file_path = paths[0]!;
      if (paths.length > 1) meta.file_paths = paths.join(",");
    }
  }

  console.error(
    `[aight] Message from app: "${data.content.slice(0, 100)}"${data.attachments?.length ? ` (${data.attachments.length} attachments)` : ""}`,
  );

  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: { content: data.content, meta },
    });
  } catch (err) {
    console.error(`[aight] MCP notification failed: ${err}`);
  }
}

// ── Cleanup PID-specific files on exit ──
const PID_FILES = [CODE_FILE, join(STATE_DIR, `hook-port-${process.pid}.txt`)];

function cleanupOnExit() {
  for (const f of PID_FILES) {
    try {
      unlinkSync(f);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[aight] Failed to clean ${f} on exit: ${err}`);
      }
    }
  }
}
process.on("exit", cleanupOnExit);
process.on("SIGINT", () => { cleanupOnExit(); process.exit(0); });
process.on("SIGTERM", () => { cleanupOnExit(); process.exit(0); });

// ── Startup cleanup ──
cleanStalePidFiles(STATE_DIR, process.pid);
cleanInbox(INBOX_DIR, LIMITS.MAX_INBOX_SIZE);

// ── Hook event HTTP server ──
function startHookServer(port: number): ReturnType<typeof Bun.serve> {
  try {
    return Bun.serve({
      port,
      hostname: "127.0.0.1",
  async fetch(req) {
    if (req.method === "POST" && new URL(req.url).pathname === "/hook-event") {
      try {
        const event = (await req.json()) as Record<string, unknown>;
        const hookEvent = event.hook_event_name as string | undefined;
        const toolName = event.tool_name as string | undefined;
        const toolInput = event.tool_input as Record<string, unknown> | undefined;
        const toolResult = event.tool_result as unknown;

        if (hookEvent) {
          const mapped = mapHookEvent(hookEvent);
          if (mapped) {
            broadcast({
              type: "tool_event",
              event: mapped,
              tool: toolName || "unknown",
              input: summarizeToolInput(toolName, toolInput),
              ...(mapped === "error" && toolResult
                ? { error: String(toolResult).slice(0, 200) }
                : {}),
              timestamp: new Date().toISOString(),
            });
          }

          const subagentMapped = mapSubagentEvent(hookEvent);
          if (subagentMapped) {
            broadcast({
              type: "tool_event",
              event: subagentMapped,
              tool: "SubAgent",
              input: (event.session_id as string) || "",
              timestamp: new Date().toISOString(),
            });
          }
        }

        return Response.json({ ok: true });
      } catch (err) {
        console.error(`[aight] Hook event parse error: ${err}`);
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
    }
    return new Response("Not found", { status: 404 });
  },
    });
  } catch (err) {
    if (port !== 0 && (err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(`[aight] Port ${port} in use, falling back to auto-assign`);
      return startHookServer(0);
    }
    throw err;
  }
}

const hookServer = startHookServer(HOOK_PORT);
const hookPort = hookServer.port;
writeFileSync(join(STATE_DIR, `hook-port-${process.pid}.txt`), String(hookPort), {
  mode: 0o600,
});
console.error(`[aight] Hook server listening on http://127.0.0.1:${hookPort}/hook-event`);
console.error(`[aight] Configure hooks in .claude/settings.json:`);
console.error(
  `[aight]   "hooks": { "PreToolUse": [{ "type": "http", "url": "http://127.0.0.1:${hookPort}/hook-event" }], "PostToolUse": [{ "type": "http", "url": "http://127.0.0.1:${hookPort}/hook-event" }] }`,
);

// ── Connect to Claude Code over stdio ──
const transport = new StdioServerTransport();
await mcp.connect(transport);

// ── Connect to relay ──
console.error(`\n[aight] Connecting to relay at ${RELAY_URL}`);

function sendSkillsList() {
  relay.send({
    type: "skills_list",
    skills: discoverSkills(),
    timestamp: new Date().toISOString(),
  });
}

const relay = new RelayClient(RELAY_URL, {
  onMessage: async (data: InboundMessage) => {
    if (data.type === "paired" || data.type === "partner_connected" || data.type === "request_skills") {
      sendSkillsList();
      if (data.type === "request_skills") return;
    }

    await forwardToMCP(data);

    if (data.type === "message" && data.id) {
      relay.send({ type: "ack", messageId: data.id, timestamp: new Date().toISOString() });
      relay.send({ type: "typing", timestamp: new Date().toISOString() });
    }

    if (data.type === "ping") {
      relay.send({ type: "pong", timestamp: new Date().toISOString() });
    }
  },
  onStateChange: (state) => {
    console.error(`[aight-relay] State: ${state}`);
    if (state === "connected") {
      senders.set("relay", (data) => relay.send(data as Parameters<typeof relay.send>[0]));
    } else {
      senders.delete("relay");
    }

    if (state === "error") {
      mcp
        .notification({
          method: "notifications/claude/channel",
          params: {
            content: "Aight relay connection failed. Check that channels.aight.cool is reachable.",
            meta: { sender: "aight-plugin", device: "system" },
          },
        })
        .catch((err: unknown) => {
          console.error(`[aight] Failed to notify Claude of relay error: ${err}`);
        });
    }
  },
  onPairingCode: (code) => {
    process.stderr.write(`\n[aight] ════════════════════════════════════════\n`);
    process.stderr.write(`[aight]   Pairing Code: ${code}\n`);
    process.stderr.write(`[aight] ════════════════════════════════════════\n`);
    process.stderr.write(`[aight]   Enter this code in the Aight app to connect.\n`);
    process.stderr.write(`[aight]   Code expires in 5 minutes.\n\n`);

    try {
      writeFileSync(CODE_FILE, `${code}\n`, { mode: 0o600 });
      process.stderr.write(`[aight]   Code also written to: ${CODE_FILE}\n\n`);
    } catch (err) {
      process.stderr.write(`[aight] Failed to write code file: ${err}\n`);
    }

    mcp
      .notification({
        method: "notifications/claude/channel",
        params: {
          content: `Aight Pairing Code: ${code} — enter this in the Aight app to connect (expires in 5 min)`,
          meta: { sender: "aight-plugin", device: "system" },
        },
      })
      .catch((err: unknown) => {
        console.error(`[aight] Failed to send pairing code notification: ${err}`);
      });
  },
});

await relay.start();
