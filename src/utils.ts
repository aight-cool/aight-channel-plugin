/**
 * Shared utilities used by the plugin and testable in isolation.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { LIMITS } from "./protocol";

// ── MIME types ──

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

// ── Filename sanitization ──

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// ── Rate limiter ──

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

// ── Stale PID file cleanup ──

export function cleanStalePidFiles(stateDir: string, ownPid: number): void {
  try {
    const files = readdirSync(stateDir);
    for (const f of files) {
      const pidMatch = f.match(/^(?:pairing-code|hook-port|hook-url)-(\d+)\.txt$/);
      if (!pidMatch) continue;

      const pid = parseInt(pidMatch[1]!, 10);
      if (pid === ownPid) continue;

      try {
        process.kill(pid, 0);
      } catch {
        try {
          unlinkSync(join(stateDir, f));
          console.error(
            `[aight] Cleaned stale file: ${f} (PID ${pid} no longer running)`,
          );
        } catch (err) {
          console.error(`[aight] Failed to clean stale file ${f}: ${err}`);
        }
      }
    }
  } catch {
    // STATE_DIR doesn't exist yet
  }
}

// ── Inbox cleanup ──

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

// ── Hook event mapping ──

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

// ── Tool input summarization ──

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

// ── Project hooks auto-configuration ──

/**
 * Collect hook URLs from all live plugin instances, then write them
 * into the project's .claude/settings.local.json hooks config.
 *
 * Each instance writes its own hook-url-{pid}.txt on startup.
 * This function reads all such files, prunes dead PIDs, and writes
 * a hooks config that fans out to every live instance.
 */
export function configureProjectHooks(stateDir: string): void {
  const urls: string[] = [];

  try {
    for (const f of readdirSync(stateDir)) {
      const match = f.match(/^hook-url-(\d+)\.txt$/);
      if (!match) continue;
      const pid = parseInt(match[1]!, 10);

      // Check if process is alive
      try {
        process.kill(pid, 0);
      } catch {
        continue; // dead process, skip
      }

      try {
        const url = readFileSync(join(stateDir, f), "utf-8").trim();
        if (url) urls.push(url);
      } catch {
        continue;
      }
    }
  } catch {
    return; // state dir doesn't exist
  }

  if (urls.length === 0) return;

  // Build hooks entries — one per live instance
  const hookEntries = urls.map((url) => ({
    type: "http",
    url,
    timeout: 5,
  }));

  const hookConfig = {
    matcher: ".*",
    hooks: hookEntries,
  };

  // Write hooks to user-level settings (~/.claude/settings.local.json).
  // Project-level won't work because the plugin's cwd is the plugin dir,
  // not the user's project. User-level hooks apply to all sessions.
  const settingsDir = join(require("os").homedir(), ".claude");
  const settingsPath = join(settingsDir, "settings.local.json");

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    // doesn't exist or invalid — start fresh
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;

  // Replace aight hook entries, preserve non-aight hooks
  for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
    const existing = (hooks[event] ?? []) as Array<Record<string, unknown>>;
    // Remove old aight hook entries (identified by /hook-event/ in URL)
    const nonAight = existing.filter((entry) => {
      const entryHooks = (entry.hooks ?? []) as Array<Record<string, unknown>>;
      return !entryHooks.some(
        (h) => typeof h.url === "string" && h.url.includes("/hook-event/"),
      );
    });
    hooks[event] = [...nonAight, hookConfig];
  }

  settings.hooks = hooks;

  try {
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", {
      mode: 0o600,
    });
    console.error(`[aight] Configured hooks for ${urls.length} active session(s)`);
  } catch (err) {
    console.error(`[aight] Failed to write hooks config: ${err}`);
  }
}
