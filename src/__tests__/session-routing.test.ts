import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  tryClaimSession,
  cleanStaleClaims,
  findClaudeCliAncestor,
  getPidForLocalPort,
  findInstanceByClaudeCliPid,
  snapshotProcesses,
} from "../utils";

const DEAD_PID = 99_999_999;

describe("tryClaimSession", () => {
  const testDir = join(tmpdir(), `aight-claim-test-${process.pid}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("claims a fresh session", () => {
    const ok = tryClaimSession(testDir, "abc-123", process.pid);
    expect(ok).toBe(true);
    expect(readFileSync(join(testDir, "claim-abc-123.txt"), "utf-8")).toBe(String(process.pid));
  });

  it("returns true for the same caller re-claiming", () => {
    expect(tryClaimSession(testDir, "abc-123", process.pid)).toBe(true);
    expect(tryClaimSession(testDir, "abc-123", process.pid)).toBe(true);
  });

  it("loses to a live competing claim", () => {
    // Live competitor: use a real PID that's not ours — process.ppid is always alive.
    writeFileSync(join(testDir, "claim-abc-123.txt"), String(process.ppid));
    const ok = tryClaimSession(testDir, "abc-123", process.pid);
    expect(ok).toBe(false);
  });

  it("takes over a claim owned by a dead PID", () => {
    writeFileSync(join(testDir, "claim-abc-123.txt"), String(DEAD_PID));
    const ok = tryClaimSession(testDir, "abc-123", process.pid);
    expect(ok).toBe(true);
    expect(readFileSync(join(testDir, "claim-abc-123.txt"), "utf-8")).toBe(String(process.pid));
  });

  it("rejects session ids with path traversal characters", () => {
    expect(tryClaimSession(testDir, "../escape", process.pid)).toBe(false);
    expect(tryClaimSession(testDir, "with/slash", process.pid)).toBe(false);
    expect(existsSync(join(testDir, "claim-../escape.txt"))).toBe(false);
  });
});

describe("cleanStaleClaims", () => {
  const testDir = join(tmpdir(), `aight-claim-cleanup-test-${process.pid}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("removes claims for dead PIDs", () => {
    writeFileSync(join(testDir, "claim-aaa.txt"), String(DEAD_PID));
    writeFileSync(join(testDir, "claim-bbb.txt"), String(process.pid));
    cleanStaleClaims(testDir);
    const remaining = readdirSync(testDir);
    expect(remaining).not.toContain("claim-aaa.txt");
    expect(remaining).toContain("claim-bbb.txt");
  });

  it("ignores non-claim files", () => {
    writeFileSync(join(testDir, "session-1.txt"), "x");
    writeFileSync(join(testDir, "claim-other.txt"), String(DEAD_PID));
    cleanStaleClaims(testDir);
    const remaining = readdirSync(testDir);
    expect(remaining).toContain("session-1.txt");
    expect(remaining).not.toContain("claim-other.txt");
  });

  it("handles non-existent directory", () => {
    expect(() => cleanStaleClaims("/nonexistent/aight-test")).not.toThrow();
  });
});

describe("findClaudeCliAncestor", () => {
  it("walks ppid chain and returns the matching claude pid", () => {
    const procs = new Map([
      [100, { ppid: 50, comm: "bun" }],
      [50, { ppid: 10, comm: "bun" }],
      [10, { ppid: 1, comm: "claude" }],
    ]);
    expect(findClaudeCliAncestor(procs, 100)).toBe(10);
  });

  it("matches comm with full path suffix", () => {
    const procs = new Map([
      [100, { ppid: 10, comm: "bun" }],
      [10, { ppid: 1, comm: "/Users/x/.local/bin/claude" }],
    ]);
    expect(findClaudeCliAncestor(procs, 100)).toBe(10);
  });

  it("returns the start pid when it is itself the claude CLI", () => {
    const procs = new Map([[10, { ppid: 1, comm: "claude" }]]);
    expect(findClaudeCliAncestor(procs, 10)).toBe(10);
  });

  it("returns null when no ancestor matches", () => {
    const procs = new Map([
      [100, { ppid: 50, comm: "bun" }],
      [50, { ppid: 1, comm: "zsh" }],
    ]);
    expect(findClaudeCliAncestor(procs, 100)).toBe(null);
  });

  it("returns null for pid not in the snapshot", () => {
    expect(findClaudeCliAncestor(new Map(), 12345)).toBe(null);
  });

  it("respects maxLevels", () => {
    const procs = new Map([
      [100, { ppid: 50, comm: "bun" }],
      [50, { ppid: 10, comm: "bun" }],
      [10, { ppid: 1, comm: "claude" }],
    ]);
    expect(findClaudeCliAncestor(procs, 100, 2)).toBe(null);
  });
});

describe("snapshotProcesses", () => {
  it("returns a map that includes the current process", () => {
    const procs = snapshotProcesses();
    expect(procs.size).toBeGreaterThan(0);
    expect(procs.has(process.pid)).toBe(true);
  });
});

describe("getPidForLocalPort", () => {
  it("returns null for unbound port", () => {
    // 1 is well-known to be reserved and never bound by user processes.
    expect(getPidForLocalPort(1)).toBe(null);
  });

  it("rejects out-of-range ports without invoking lsof", () => {
    expect(getPidForLocalPort(0)).toBe(null);
    expect(getPidForLocalPort(-1)).toBe(null);
    expect(getPidForLocalPort(70_000)).toBe(null);
    expect(getPidForLocalPort(Number.NaN)).toBe(null);
  });
});

describe("findInstanceByClaudeCliPid", () => {
  const testDir = join(tmpdir(), `aight-find-instance-test-${process.pid}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns null when no live instances exist", () => {
    writeFileSync(join(testDir, `hook-port-${DEAD_PID}.txt`), "12345");
    expect(findInstanceByClaudeCliPid(testDir, process.pid, new Map())).toBe(null);
  });

  it("matches the live instance whose ancestor is the given CLI pid", () => {
    writeFileSync(join(testDir, `hook-port-${process.pid}.txt`), "54321");
    const procs = new Map([
      [process.pid, { ppid: 42, comm: "bun" }],
      [42, { ppid: 1, comm: "claude" }],
    ]);
    expect(findInstanceByClaudeCliPid(testDir, 42, procs)).toEqual({
      pid: process.pid,
      port: 54321,
    });
  });

  it("returns null when no live instance descends from the given CLI pid", () => {
    writeFileSync(join(testDir, `hook-port-${process.pid}.txt`), "54321");
    const procs = new Map([
      [process.pid, { ppid: 42, comm: "bun" }],
      [42, { ppid: 1, comm: "zsh" }],
    ]);
    expect(findInstanceByClaudeCliPid(testDir, DEAD_PID, procs)).toBe(null);
  });
});
