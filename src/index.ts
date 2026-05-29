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
  cleanStaleClaims,
  cleanInbox,
  mapHookEvent,
  mapSubagentEvent,
  parseAskUserQuestionInput,
  summarizeToolInput,
  summarizeToolResult,
  extractLastAssistantText,
  getLiveInstancePorts,
  getPortForSession,
  getPidForLocalPort,
  findClaudeCliAncestor,
  findInstanceByClaudeCliPid,
  snapshotProcesses,
  tryClaimSession,
  claimFilePath,
} from "./utils";

import { writeFileSync, mkdirSync, readFileSync, unlinkSync, statSync, renameSync, readdirSync } from "fs";
import { join, extname, basename } from "path";
import { homedir } from "os";


const RELAY_URL = process.env.AIGHT_RELAY_URL || "https://channels.aight.cool";
const STATE_DIR = join(homedir(), ".claude", "channels", "aight");
const INBOX_DIR = join(STATE_DIR, "inbox");
const CODE_FILE = join(STATE_DIR, `pairing-code-${process.pid}.txt`);
const GLOBAL_SETTINGS_FILE = join(homedir(), ".claude", "settings.json");

const AIGHT_HOOK_PORT = 7891;
const AIGHT_HOOK_PATH = "/aight-hook";

mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 });

// Extended thinking causes "thinking blocks cannot be modified" API errors when
// Claude makes tool calls on Opus 4.8. Disable it for the lifetime of this plugin
// instance and restore on exit so other sessions aren't permanently affected.
//
// Crash safety: each instance writes a per-PID claim file recording the original
// value. On the next startup, stale claim files (dead PIDs) are read before
// deletion so we can recover the original value and take over restore responsibility.
// Atomic writes (write-to-temp → rename) prevent settings.json corruption on crash.
type ThinkingRestoreValue = boolean | "absent";
let thinkingRestoreValue: ThinkingRestoreValue | null = null;
let weHoldThinkingClaim = false;
const THINKING_CLAIM_FILE = join(STATE_DIR, `thinking-claim-${process.pid}.txt`);

function parseThinkingClaimContent(content: string): ThinkingRestoreValue | null {
  const s = content.trim();
  if (s === "absent") return "absent";
  if (s === "true") return true;
  if (s === "false") return false;
  return null; // corrupt or empty — don't restore to a wrong value
}

function writeSettingsAtomic(settings: Record<string, unknown>): void {
  const tmp = `${GLOBAL_SETTINGS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 4), { mode: 0o600 });
  renameSync(tmp, GLOBAL_SETTINGS_FILE);
}

function disableThinkingForCompatibility(): void {
  // Scan for stale claim files from crashed instances and recover their saved original value.
  let recoveredRestoreValue: ThinkingRestoreValue | null = null;
  try {
    for (const f of readdirSync(STATE_DIR)) {
      if (!f.startsWith("thinking-claim-") || !f.endsWith(".txt")) continue;
      const pid = parseInt(f.slice("thinking-claim-".length, -".txt".length), 10);
      if (pid === process.pid) continue;
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      if (!alive) {
        if (recoveredRestoreValue === null) {
          try {
            recoveredRestoreValue = parseThinkingClaimContent(readFileSync(join(STATE_DIR, f), "utf-8"));
          } catch {}
        }
        try { unlinkSync(join(STATE_DIR, f)); } catch {}
      }
    }
  } catch {}

  try {
    const raw = readFileSync(GLOBAL_SETTINGS_FILE, "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;

    if (settings.alwaysThinkingEnabled === false) {
      if (recoveredRestoreValue !== null) {
        // A previous instance crashed leaving thinking=false. Take over restore responsibility.
        thinkingRestoreValue = recoveredRestoreValue;
        console.error("[aight] Taking over thinking restore from crashed instance.");
      } else {
        // Either another live instance is managing this, or the user set it manually. Leave it.
        return;
      }
    } else {
      thinkingRestoreValue = "alwaysThinkingEnabled" in settings ? (settings.alwaysThinkingEnabled as boolean) : "absent";
      settings.alwaysThinkingEnabled = false;
      writeSettingsAtomic(settings);
      console.error("[aight] Set thinking=false in ~/.claude/settings.json for Opus 4.8 tool-call compatibility. Will restore on exit.");
    }

    // Write a claim file so the next startup can recover our original value if we crash.
    const claimContent = thinkingRestoreValue === "absent" ? "absent" : String(thinkingRestoreValue);
    writeFileSync(THINKING_CLAIM_FILE, claimContent, { mode: 0o600 });
    weHoldThinkingClaim = true;
  } catch (err) {
    console.error(`[aight] Could not patch thinking setting: ${err}`);
  }
}

function restoreThinkingSetting(): void {
  if (!weHoldThinkingClaim) return;
  try {
    const raw = readFileSync(GLOBAL_SETTINGS_FILE, "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    if (settings.alwaysThinkingEnabled === false) {
      if (thinkingRestoreValue === "absent") {
        delete settings.alwaysThinkingEnabled;
      } else {
        settings.alwaysThinkingEnabled = thinkingRestoreValue;
      }
      writeSettingsAtomic(settings);
      console.error("[aight] Restored thinking setting in ~/.claude/settings.json");
    }
  } catch (err) {
    console.error(`[aight] Could not restore thinking setting: ${err}`);
  } finally {
    try { unlinkSync(THINKING_CLAIM_FILE); } catch {}
  }
}

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
    instructions: `Messages from the Aight mobile app arrive as <channel source="aight" sender="..." device="..." message_id="...">. ONLY use the reply tool to respond to these channel messages — your transcript output never reaches the app. Keep replies concise and readable on a small screen. You can use markdown — the app renders it.\n\nMessages typed directly in the terminal are regular user input — respond normally in the terminal. Do NOT use the reply tool for terminal messages.`,
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
    const a = args as Record<string, unknown>;
    const text = (a.text ?? a.message ?? "") as string;
    const replyTo = (a.reply_to ?? a.message_id ?? null) as string | null;
    const files = (a.files ?? []) as string[];

    if (!text) {
      return { content: [{ type: "text", text: "error: reply text is empty" }] };
    }

    const msgId = `claude_${++messageCounter}`;

    const attachments: Array<{ fileName: string; mimeType: string; data: string }> = [];
    if (files.length) {
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
      replyTo: replyTo,
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
  // Cap before write so the documented MAX_INBOX_SIZE actually bounds a
  // long-running session, not just startup. Without this, a paired peer
  // could accumulate disk usage at the per-minute rate limit indefinitely.
  cleanInbox(INBOX_DIR, LIMITS.MAX_INBOX_SIZE);
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
const PID_FILES = [CODE_FILE, join(STATE_DIR, `hook-port-${process.pid}.txt`), SESSION_FILE, THINKING_CLAIM_FILE];

function cleanupOnExit() {
  restoreThinkingSetting();
  const files = [...PID_FILES];
  if (ownSessionId) files.push(claimFilePath(STATE_DIR, ownSessionId));
  for (const f of files) {
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
cleanStaleClaims(STATE_DIR);
cleanInbox(INBOX_DIR, LIMITS.MAX_INBOX_SIZE);
disableThinkingForCompatibility();

/**
 * A PreToolUse hook response that denies the tool call and feeds `reason` back
 * to the model. Used to short-circuit AskUserQuestion before its blocking
 * terminal picker renders. Claude Code reads the HTTP 200 body as the hook
 * output, so the instance server returns this verbatim.
 */
function denyDecision(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

const ASK_USER_QUESTION_DENY_REASON =
  "You're connected to the Aight mobile app — the interactive AskUserQuestion " +
  "picker can't be shown or answered there and would freeze this session. The " +
  "question and its options have already been displayed to the user in the app " +
  "as tappable choices. Do NOT call AskUserQuestion again. Stop and wait for " +
  "the user's reply, which will arrive as a normal channel message containing " +
  "their chosen option(s).";

let ownSessionId: string | null = null;

/**
 * Process a hook event. Returns a hook-response object to send back to Claude
 * Code (e.g. a PreToolUse deny decision), or undefined for the normal
 * fire-and-forget case.
 */
function handleHookEvent(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const hookEvent = event.hook_event_name as string | undefined;
  const sessionId = event.session_id as string | undefined;
  const toolName = event.tool_name as string | undefined;
  const toolInput = event.tool_input as Record<string, unknown> | undefined;
  const toolResult = event.tool_result as unknown;
  const transcriptPath = event.transcript_path as string | undefined;

  if (!hookEvent || !sessionId) return;

  if (!ownSessionId) {
    if (!tryClaimSession(STATE_DIR, sessionId)) return;
    ownSessionId = sessionId;
    try {
      writeFileSync(SESSION_FILE, sessionId, { mode: 0o600 });
    } catch (err) {
      console.error(`[aight] Failed to write session file: ${err}`);
    }
    console.error(`[aight] Claimed session: ${ownSessionId}`);
  }

  if (sessionId !== ownSessionId) return;

  if (hookEvent === "UserPromptSubmit") {
    broadcast({
      type: "turn_event",
      event: "started",
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // AskUserQuestion blocks the interactive CLI on a terminal picker the app
  // can't satisfy. Intercept it at PreToolUse: render the choices in the app
  // and deny the native tool so the agent doesn't freeze. The user's tap comes
  // back as an ordinary channel message.
  if (hookEvent === "PreToolUse" && toolName === "AskUserQuestion") {
    const questions = parseAskUserQuestionInput(toolInput);
    if (questions) {
      broadcast({
        type: "ask_user_question",
        questionId: (event.tool_use_id as string) || `q_${Date.now()}`,
        questions,
        timestamp: new Date().toISOString(),
      });
      return denyDecision(ASK_USER_QUESTION_DENY_REASON);
    }
    // Unparseable payload — fall through to the generic tool-event path so the
    // event is at least surfaced rather than silently dropped.
  }

  const mapped = mapHookEvent(hookEvent);
  if (mapped) {
    const payload: Record<string, unknown> = {
      type: "tool_event",
      event: mapped,
      tool: toolName || "unknown",
      input: summarizeToolInput(toolName, toolInput),
      timestamp: new Date().toISOString(),
    };
    if (mapped === "error" && toolResult) {
      payload.error = String(toolResult).slice(0, 200);
    }
    if (mapped === "end" && toolResult) {
      const summary = summarizeToolResult(toolName, toolResult);
      if (summary) payload.result = summary;
    }
    broadcast(payload);
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

  if (hookEvent === "Stop") {
    if (transcriptPath) {
      const text = extractLastAssistantText(transcriptPath);
      if (text) {
        broadcast({
          type: "assistant_message",
          content: text.slice(0, LIMITS.MAX_CONTENT_LENGTH),
          timestamp: new Date().toISOString(),
        });
      }
    }
    broadcast({
      type: "turn_event",
      event: "ended",
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
        const decision = handleHookEvent((await req.json()) as Record<string, unknown>);
        // A decision (e.g. PreToolUse deny) is returned as the hook output body;
        // Claude Code reads the 200 body to act on it. Otherwise ack normally.
        return Response.json(decision ?? { ok: true });
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
// Bounded to prevent unbounded growth across many sessions over time.
const SESSION_PORT_CACHE_MAX = 1024;
const sessionPortCache = new Map<string, number>();
function rememberSessionPort(sessionId: string, port: number): void {
  if (sessionPortCache.size >= SESSION_PORT_CACHE_MAX) {
    const oldest = sessionPortCache.keys().next().value;
    if (oldest !== undefined) sessionPortCache.delete(oldest);
  }
  sessionPortCache.set(sessionId, port);
}

/** Walk: request peer port → owning pid → Claude CLI ancestor → our matching MCP instance. */
function resolveInstancePortFromRequest(
  req: Request,
  server: { requestIP: (r: Request) => { port: number } | null },
): number | null {
  const peer = server.requestIP(req);
  if (!peer?.port) return null;
  const sourcePid = getPidForLocalPort(peer.port);
  if (!sourcePid) return null;
  const procs = snapshotProcesses();
  const cliPid = findClaudeCliAncestor(procs, sourcePid);
  if (!cliPid) return null;
  return findInstanceByClaudeCliPid(STATE_DIR, cliPid, procs)?.port ?? null;
}

/**
 * Pick target instance ports for a hook event.
 *
 * Routing order: in-memory cache → on-disk session→port map → source-process
 * lookup via the request's TCP peer → fan-out to every live instance.
 *
 * Fan-out is the unsafe path: if two unclaimed instances both receive the
 * same unknown session, they race to claim it. The instance-side
 * tryClaimSession lock prevents duplicate claims; source-process routing
 * skips fan-out entirely when lsof can identify the firing Claude CLI.
 */
function routeEvent(
  sessionId: string | undefined,
  req: Request,
  server: { requestIP: (r: Request) => { port: number } | null },
): number[] {
  if (!sessionId) return [instanceHookPort];

  const cached = sessionPortCache.get(sessionId);
  if (cached !== undefined) return [cached];

  const diskPort = getPortForSession(STATE_DIR, sessionId);
  if (diskPort) {
    rememberSessionPort(sessionId, diskPort);
    return [diskPort];
  }

  let resolved: number | null = null;
  try {
    resolved = resolveInstancePortFromRequest(req, server);
  } catch (err) {
    console.error(`[aight] Source-PID routing failed: ${err}`);
  }
  if (resolved !== null) {
    rememberSessionPort(sessionId, resolved);
    return [resolved];
  }

  const ports = getLiveInstancePorts(STATE_DIR, process.pid);
  ports.push(instanceHookPort);
  const targets = [...new Set(ports)];
  console.error(
    `[aight] Falling back to fan-out for unknown session ${sessionId.slice(0, 8)}… (${targets.length} instance(s))`,
  );
  return targets;
}

/**
 * From the proxied instance responses, return the first body that carries a
 * real hook decision (a `hookSpecificOutput`), or null if all are plain acks /
 * failures. Lets a single owning instance's PreToolUse deny propagate to Claude
 * Code even when the event was fanned out to several instances.
 */
async function firstHookDecision(
  results: PromiseSettledResult<Response>[],
): Promise<Record<string, unknown> | null> {
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    try {
      const body = (await r.value.json()) as Record<string, unknown>;
      if (body && typeof body === "object" && "hookSpecificOutput" in body) {
        return body;
      }
    } catch {
      // Non-JSON or empty body — ignore.
    }
  }
  return null;
}

try {
  Bun.serve({
    port: AIGHT_HOOK_PORT,
    hostname: "127.0.0.1",
    async fetch(req, server) {
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
        const targetPorts = routeEvent(eventSessionId, req, server);

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

        // Forward the owning instance's hook output back to Claude Code so
        // decisions (e.g. an AskUserQuestion PreToolUse deny) take effect.
        // Routing usually resolves to the single owning instance; on fan-out we
        // surface the first real decision and otherwise ack.
        const decision = await firstHookDecision(results);
        return Response.json(decision ?? { ok: true });
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
