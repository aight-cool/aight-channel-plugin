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
  getLiveInstancePorts,
  getPortForSession,
} from "./utils";

import { writeFileSync, mkdirSync, readFileSync, unlinkSync, statSync } from "fs";
import { join, extname, basename } from "path";
import { homedir } from "os";


const RELAY_URL = process.env.AIGHT_RELAY_URL || "https://channels.aight.cool";
const STATE_DIR = join(homedir(), ".claude", "channels", "aight");
const INBOX_DIR = join(STATE_DIR, "inbox");
const CODE_FILE = join(STATE_DIR, `pairing-code-${process.pid}.txt`);

const AIGHT_HOOK_PORT = 7891;
const AIGHT_HOOK_PATH = "/aight-hook";

mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 });

const rateLimiter = createRateLimiter();

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

  const savedPaths: string[] = [];
  if (data.attachments?.length) {
    for (const att of data.attachments) {
      try {
        savedPaths.push(saveAttachment(att));
      } catch (err) {
        console.error(`[aight] Failed to save attachment: ${err}`);
      }
    }
    if (savedPaths.length > 0) {
      meta.file_path = savedPaths[0]!;
      if (savedPaths.length > 1) meta.file_paths = savedPaths.join(",");
    }
  }

  console.error(
    `[aight] Message from app: "${data.content.slice(0, 100)}"${data.attachments?.length ? ` (${data.attachments.length} attachments)` : ""}`,
  );

  let content = data.content;
  if (savedPaths.length > 0) {
    const fileList = savedPaths.map((p) => `- ${p}`).join("\n");
    content += `\n\n[Attached files — use the Read tool to view]\n${fileList}`;
  }

  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: { content, meta },
    });
  } catch (err) {
    console.error(`[aight] MCP notification failed: ${err}`);
  }
}

const SESSION_FILE = join(STATE_DIR, `session-${process.pid}.txt`);
const PID_FILES = [CODE_FILE, join(STATE_DIR, `hook-port-${process.pid}.txt`), SESSION_FILE];

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

cleanStalePidFiles(STATE_DIR, process.pid);
cleanInbox(INBOX_DIR, LIMITS.MAX_INBOX_SIZE);

let ownSessionId: string | null = null;
function handleHookEvent(event: Record<string, unknown>): void {
  const hookEvent = event.hook_event_name as string | undefined;
  const sessionId = event.session_id as string | undefined;
  const toolName = event.tool_name as string | undefined;
  const toolInput = event.tool_input as Record<string, unknown> | undefined;
  const toolResult = event.tool_result as unknown;

  if (!hookEvent || !sessionId) return;

  // Claim our session_id: first event we process, we own that session.
  // The fan-out proxy routes known sessions directly to the right instance
  // and only fans out unknown sessions. So the first unknown-session event
  // we receive is ours.
  if (!ownSessionId) {
    ownSessionId = sessionId;
    try {
      writeFileSync(SESSION_FILE, sessionId, { mode: 0o600 });
    } catch (err) {
      console.error(`[aight] Failed to write session file: ${err}`);
    }
    console.error(`[aight] Claimed session: ${ownSessionId}`);
  }

  // Ignore events from other sessions
  if (sessionId !== ownSessionId) return;

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
      input: sessionId,
      timestamp: new Date().toISOString(),
    });
  }
}

// Instance-local hook listener (auto-assigned port)
const instanceHookServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    if (req.method === "POST" && new URL(req.url).pathname === AIGHT_HOOK_PATH) {
      try {
        handleHookEvent((await req.json()) as Record<string, unknown>);
        return Response.json({ ok: true });
      } catch (err) {
        console.error(`[aight] Hook event parse error: ${err}`);
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }
    }
    return new Response("Not found", { status: 404 });
  },
});

const instanceHookPort = instanceHookServer.port!;
writeFileSync(join(STATE_DIR, `hook-port-${process.pid}.txt`), String(instanceHookPort), {
  mode: 0o600,
});

// The first instance to grab port 7891 acts as fan-out proxy.
// It caches session→port mappings to avoid disk I/O on every hook event.
const sessionPortCache = new Map<string, number>();

try {
  Bun.serve({
    port: AIGHT_HOOK_PORT,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method === "POST" && new URL(req.url).pathname === AIGHT_HOOK_PATH) {
        let body: string;
        try {
          body = await req.text();
        } catch {
          return Response.json({ error: "Invalid body" }, { status: 400 });
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body);
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }

        const eventSessionId = parsed.session_id as string | undefined;

        // Route: check cache first, then disk, then fan-out
        let targetPorts: number[];
        const cached = eventSessionId ? sessionPortCache.get(eventSessionId) : undefined;

        if (cached) {
          targetPorts = [cached];
        } else if (eventSessionId) {
          const diskPort = getPortForSession(STATE_DIR, eventSessionId);
          if (diskPort) {
            sessionPortCache.set(eventSessionId, diskPort);
            targetPorts = [diskPort];
          } else {
            const ports = getLiveInstancePorts(STATE_DIR, process.pid);
            ports.push(instanceHookPort);
            targetPorts = [...new Set(ports)];
          }
        } else {
          targetPorts = [instanceHookPort];
        }

        const results = await Promise.allSettled(
          targetPorts.map((port) =>
            fetch(`http://127.0.0.1:${port}${AIGHT_HOOK_PATH}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
            }),
          ),
        );

        // Self-healing: remove dead ports from cache and disk
        for (let i = 0; i < results.length; i++) {
          if (results[i]!.status === "rejected") {
            const deadPort = targetPorts[i]!;
            // Invalidate cache entries pointing to this port
            for (const [sid, port] of sessionPortCache) {
              if (port === deadPort) sessionPortCache.delete(sid);
            }
          }
        }

        return Response.json({ ok: true });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  console.error(`[aight] Hook proxy on port ${AIGHT_HOOK_PORT}`);
} catch {
  console.error(`[aight] Hook proxy skipped (port ${AIGHT_HOOK_PORT} owned by another instance)`);
}

console.error(`[aight] Instance hook listener on port ${instanceHookPort}`);

const transport = new StdioServerTransport();
await mcp.connect(transport);

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
