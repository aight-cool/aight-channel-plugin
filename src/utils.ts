/**
 * Shared utilities used by the plugin and testable in isolation.
 */

import { readdirSync, readFileSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { LIMITS } from "./protocol";

export const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
};

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export interface RateLimiter {
  allow(now?: number): boolean;
}

export function createRateLimiter(
  maxPerMinute = LIMITS.MAX_MESSAGES_PER_MINUTE,
): RateLimiter {
  let timestamps: number[] = [];
  return {
    allow(now?: number): boolean {
      const t = now ?? Date.now();
      const windowStart = t - 60_000;
      timestamps = timestamps.filter((ts) => ts > windowStart);
      if (timestamps.length >= maxPerMinute) return false;
      timestamps.push(t);
      return true;
    },
  };
}

/** Info about a live plugin instance discovered from PID-tagged files */
interface LivePidFile {
  pid: number;
  fileName: string;
  filePath: string;
}

/**
 * Iterate PID-tagged files in stateDir, yielding only those whose
 * process is still alive. Handles the common pattern of:
 * readdirSync → regex match → process.kill(pid, 0) → yield
 */
function forEachLivePidFile(
  stateDir: string,
  pattern: RegExp,
  ownPid?: number,
): LivePidFile[] {
  const results: LivePidFile[] = [];
  try {
    for (const f of readdirSync(stateDir)) {
      const match = f.match(pattern);
      if (!match) continue;
      const pid = parseInt(match[1]!, 10);
      if (ownPid !== undefined && pid === ownPid) continue;

      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {}

      if (alive) {
        results.push({ pid, fileName: f, filePath: join(stateDir, f) });
      }
    }
  } catch {
    // stateDir doesn't exist
  }
  return results;
}

const STALE_PID_PATTERN = /^(?:pairing-code|hook-port|session)-(\d+)\.txt$/;

export function cleanStalePidFiles(stateDir: string, ownPid: number): void {
  try {
    for (const f of readdirSync(stateDir)) {
      const match = f.match(STALE_PID_PATTERN);
      if (!match) continue;
      const pid = parseInt(match[1]!, 10);
      if (pid === ownPid) continue;

      try {
        process.kill(pid, 0);
      } catch {
        try {
          unlinkSync(join(stateDir, f));
          console.error(`[aight] Cleaned stale file: ${f} (PID ${pid} no longer running)`);
        } catch (err) {
          console.error(`[aight] Failed to clean stale file ${f}: ${err}`);
        }
      }
    }
  } catch {
    // stateDir doesn't exist
  }
}

export function cleanInbox(inboxDir: string, maxSize: number): void {
  try {
    const files = readdirSync(inboxDir);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const kept: Array<{ path: string; mtime: number; size: number }> = [];
    let totalSize = 0;

    for (const f of files) {
      const p = join(inboxDir, f);
      try {
        const st = statSync(p);
        if (st.mtimeMs < cutoff) {
          unlinkSync(p);
          continue;
        }
        kept.push({ path: p, mtime: st.mtimeMs, size: st.size });
        totalSize += st.size;
      } catch (err) {
        console.error(`[aight] Failed to stat/clean inbox file ${f}: ${err}`);
      }
    }

    if (totalSize > maxSize) {
      kept.sort((a, b) => a.mtime - b.mtime);
      for (const info of kept) {
        if (totalSize <= maxSize) break;
        try {
          unlinkSync(info.path);
          totalSize -= info.size;
          console.error(`[aight] Evicted inbox file (size cap): ${info.path}`);
        } catch (err) {
          console.error(`[aight] Failed to evict inbox file: ${err}`);
        }
      }
    }
  } catch {
    // inbox doesn't exist yet
  }
}

const HOOK_EVENT_MAP: Record<string, "start" | "end" | "error"> = {
  PreToolUse: "start",
  PostToolUse: "end",
  PostToolUseFailure: "error",
};

const SUBAGENT_EVENT_MAP: Record<string, "subagent_start" | "subagent_end"> = {
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_end",
};

export function mapHookEvent(hookEvent: string): "start" | "end" | "error" | undefined {
  return HOOK_EVENT_MAP[hookEvent];
}

export function mapSubagentEvent(hookEvent: string): "subagent_start" | "subagent_end" | undefined {
  return SUBAGENT_EVENT_MAP[hookEvent];
}

const FILE_PATH_TOOLS = new Set(["Read", "Edit", "Write"]);

export function summarizeToolInput(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
): string {
  if (!toolInput) return "";
  if (toolName === "Bash" && typeof toolInput.command === "string") {
    return toolInput.command.slice(0, 200);
  }
  if (toolName && FILE_PATH_TOOLS.has(toolName) && typeof toolInput.file_path === "string") {
    return toolInput.file_path;
  }
  return JSON.stringify(toolInput).slice(0, 200);
}

const HOOK_PORT_PATTERN = /^hook-port-(\d+)\.txt$/;

/** Read hook-port-{pid}.txt files for all live plugin instances */
export function getLiveInstancePorts(stateDir: string, ownPid: number): number[] {
  const ports: number[] = [];
  for (const { filePath } of forEachLivePidFile(stateDir, HOOK_PORT_PATTERN, ownPid)) {
    try {
      const port = parseInt(readFileSync(filePath, "utf-8").trim(), 10);
      if (port > 0) ports.push(port);
    } catch {
      continue;
    }
  }
  return ports;
}

const SESSION_PATTERN = /^session-(\d+)\.txt$/;

/** Find the instance port that owns a given session_id */
export function getPortForSession(stateDir: string, sessionId: string): number | null {
  for (const { pid, filePath } of forEachLivePidFile(stateDir, SESSION_PATTERN)) {
    try {
      const sid = readFileSync(filePath, "utf-8").trim();
      if (sid === sessionId) {
        try {
          return parseInt(readFileSync(join(stateDir, `hook-port-${pid}.txt`), "utf-8").trim(), 10);
        } catch {
          return null;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}
