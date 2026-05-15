/**
 * Shared utilities used by the plugin and testable in isolation.
 */

import { readdirSync, readFileSync, writeFileSync, unlinkSync, statSync, openSync, closeSync, writeSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
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

const CLAIM_FILE_PREFIX = "claim-";
const CLAIM_FILE_SUFFIX = ".txt";

/** Filesystem path of the atomic claim lock for a session_id */
export function claimFilePath(stateDir: string, sessionId: string): string {
  return join(stateDir, `${CLAIM_FILE_PREFIX}${sessionId}${CLAIM_FILE_SUFFIX}`);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readIntFile(path: string): number | null {
  try {
    const n = parseInt(readFileSync(path, "utf-8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
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
      if (isPidAlive(pid)) {
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

const CLAIM_PATTERN = new RegExp(`^${CLAIM_FILE_PREFIX}.+\\${CLAIM_FILE_SUFFIX}$`);

/**
 * Remove claim-<sid>.txt files whose owner PID is no longer running.
 * Run on startup to recover from crashed instances.
 */
export function cleanStaleClaims(stateDir: string): void {
  try {
    for (const f of readdirSync(stateDir)) {
      if (!CLAIM_PATTERN.test(f)) continue;
      const p = join(stateDir, f);
      const pid = readIntFile(p);
      if (pid === null || isPidAlive(pid)) continue;
      try {
        unlinkSync(p);
        console.error(`[aight] Cleaned stale claim: ${f} (PID ${pid} no longer running)`);
      } catch (err) {
        console.error(`[aight] Failed to clean stale claim ${f}: ${err}`);
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
    const port = readIntFile(filePath);
    if (port !== null && port > 0) ports.push(port);
  }
  return ports;
}

const SESSION_PATTERN = /^session-(\d+)\.txt$/;

/** Find the instance port that owns a given session_id */
export function getPortForSession(stateDir: string, sessionId: string): number | null {
  for (const { pid, filePath } of forEachLivePidFile(stateDir, SESSION_PATTERN)) {
    try {
      if (readFileSync(filePath, "utf-8").trim() === sessionId) {
        return readIntFile(join(stateDir, `hook-port-${pid}.txt`));
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Look up the PID owning the local end of an outbound TCP connection on `port`.
 * Used by the hook proxy to identify which Claude CLI fired a hook event.
 *
 * Implementation: shells out to `lsof -nP -iTCP:<port>`. macOS/BSD only.
 * Returns null on any failure (lsof missing, no match, parse error).
 */
export function getPidForLocalPort(port: number): number | null {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  let out: string;
  try {
    out = execFileSync("lsof", ["-nP", "-iTCP:" + port], {
      encoding: "utf-8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  // Find the row whose NAME column shows ":<port>->" — the outbound end of the connection.
  const portStr = `:${port}->`;
  for (const line of out.split("\n").slice(1)) {
    if (!line.includes(portStr)) continue;
    const cols = line.split(/\s+/);
    const pid = parseInt(cols[1] || "", 10);
    if (Number.isFinite(pid)) return pid;
  }
  return null;
}

interface ProcInfo {
  ppid: number;
  comm: string;
}

/**
 * Snapshot every process on the system in a single `ps -A` call.
 * Used by the proxy hot path to walk multiple process trees without
 * paying a fork per ancestor lookup. Caller is responsible for caching
 * the result if it's reused across multiple lookups in the same instant.
 */
export function snapshotProcesses(): Map<number, ProcInfo> {
  const result = new Map<number, ProcInfo>();
  let out: string;
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], {
      encoding: "utf-8",
      timeout: 1000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return result;
  }
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    result.set(parseInt(m[1]!, 10), { ppid: parseInt(m[2]!, 10), comm: m[3]! });
  }
  return result;
}

function isClaudeComm(comm: string): boolean {
  return comm === "claude" || comm.endsWith("/claude");
}

/**
 * Walk up the process tree from `startPid` in `procs` looking for the Claude
 * CLI. Returns the matching pid or null. `procs` is the snapshot from
 * snapshotProcesses().
 */
export function findClaudeCliAncestor(
  procs: Map<number, ProcInfo>,
  startPid: number,
  maxLevels = 6,
): number | null {
  let pid = startPid;
  for (let i = 0; i < maxLevels; i++) {
    const info = procs.get(pid);
    if (!info) return null;
    if (isClaudeComm(info.comm)) return pid;
    if (info.ppid <= 1) return null;
    pid = info.ppid;
  }
  return null;
}

/**
 * Atomically claim ownership of a session_id by creating claim-<sid>.txt
 * with O_EXCL. Returns true if this process now owns the claim, false if
 * another live process owns it. Stale claims (dead PID) are taken over.
 */
export function tryClaimSession(
  stateDir: string,
  sessionId: string,
  pid: number = process.pid,
): boolean {
  if (!/^[a-zA-Z0-9._-]+$/.test(sessionId)) return false; // refuse path-injecting ids
  const claimFile = claimFilePath(stateDir, sessionId);
  try {
    const fd = openSync(claimFile, "wx", 0o600);
    try {
      writeSync(fd, String(pid));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
  }
  const existingPid = readIntFile(claimFile);
  if (existingPid === null) return false;
  if (existingPid === pid) return true;
  if (isPidAlive(existingPid)) return false;
  // Owner dead — take over (last write wins for the rare double-takeover case).
  try {
    writeFileSync(claimFile, String(pid), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the aight MCP instance whose process tree descends from the given
 * Claude CLI pid. `procs` is a snapshot from snapshotProcesses(). Returns
 * null if no live instance matches.
 */
export function findInstanceByClaudeCliPid(
  stateDir: string,
  claudeCliPid: number,
  procs: Map<number, ProcInfo>,
): { pid: number; port: number } | null {
  for (const { pid, filePath } of forEachLivePidFile(stateDir, HOOK_PORT_PATTERN)) {
    if (findClaudeCliAncestor(procs, pid) !== claudeCliPid) continue;
    const port = readIntFile(filePath);
    if (port !== null && port > 0) return { pid, port };
  }
  return null;
}
