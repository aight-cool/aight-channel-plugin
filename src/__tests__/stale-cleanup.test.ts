import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { cleanStalePidFiles } from "../utils";

describe("cleanStalePidFiles", () => {
  const testDir = join(tmpdir(), `aight-stale-test-${process.pid}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("removes files for dead PIDs", () => {
    const ourFile = `pairing-code-${process.pid}.txt`;
    const deadFile = `pairing-code-99999999.txt`;

    writeFileSync(join(testDir, ourFile), "ABC123\n");
    writeFileSync(join(testDir, deadFile), "XYZ789\n");

    cleanStalePidFiles(testDir, process.pid);

    const remaining = readdirSync(testDir);
    expect(remaining).toContain(ourFile);
    expect(remaining).not.toContain(deadFile);
  });

  it("removes hook-port and hook-url files for dead PIDs", () => {
    const deadPort = `hook-port-99999999.txt`;
    const deadUrl = `hook-url-99999999.txt`;
    writeFileSync(join(testDir, deadPort), "12345");
    writeFileSync(join(testDir, deadUrl), "http://127.0.0.1:12345/hook-event/abc123");

    cleanStalePidFiles(testDir, process.pid);

    const remaining = readdirSync(testDir);
    expect(remaining).not.toContain(deadPort);
    expect(remaining).not.toContain(deadUrl);
  });

  it("ignores non-PID files", () => {
    writeFileSync(join(testDir, "some-other-file.txt"), "data");
    writeFileSync(join(testDir, "pairing-code.txt"), "no pid");

    cleanStalePidFiles(testDir, process.pid);

    const remaining = readdirSync(testDir);
    expect(remaining).toContain("some-other-file.txt");
    expect(remaining).toContain("pairing-code.txt");
  });

  it("handles empty state directory", () => {
    expect(() => cleanStalePidFiles(testDir, process.pid)).not.toThrow();
  });

  it("handles non-existent directory", () => {
    expect(() => cleanStalePidFiles("/nonexistent/path", process.pid)).not.toThrow();
  });

  it("keeps files for our own PID", () => {
    const ourFile = `pairing-code-${process.pid}.txt`;
    writeFileSync(join(testDir, ourFile), "ABC123\n");

    cleanStalePidFiles(testDir, process.pid);

    const remaining = readdirSync(testDir);
    expect(remaining).toContain(ourFile);
  });
});
