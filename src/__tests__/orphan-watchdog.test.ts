import { describe, it, expect } from "bun:test";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "index.ts");

/**
 * The plugin is a stdio MCP server spawned per Claude Code session. Before the watchdog, a child
 * whose parent died (crash / SIGKILL / un-reaped) lingered forever as an orphan, leaking the process
 * and its claim file. These tests prove the two shutdown signals actually terminate the process.
 */
describe("parent-death watchdog", () => {
  it("exits when its stdin is closed (parent closed the pipe)", async () => {
    const proc = Bun.spawn(["bun", ENTRY], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      // Give it an isolated state dir so it doesn't touch the real channel state.
      env: { ...process.env, AIGHT_STATE_DIR: join("/tmp", `aight-wd-${Date.now()}-${Math.random().toString(36).slice(2)}`) },
    });

    // Let it boot and connect the transport, then close stdin — the "parent gone" signal.
    await Bun.sleep(1500);
    proc.stdin.end();

    // It must exit on its own well within the 5s watchdog interval (stdin close is immediate).
    const exited = await Promise.race([
      proc.exited,
      Bun.sleep(8000).then(() => "timeout" as const),
    ]);

    if (exited === "timeout") {
      proc.kill();
      throw new Error("plugin did not exit after stdin closed — watchdog failed");
    }
    expect(typeof exited).toBe("number");
  }, 15000);

  it("exits when orphaned (parent killed) via the live-ppid watchdog", async () => {
    // Bun caches process.ppid, so the watchdog must read the parent pid LIVE. Spawn the plugin under
    // an intermediate shell WITH stdin held open (so only the ppid path can trigger), kill the shell
    // to orphan it (ppid -> 1), and confirm it self-exits within the 5s poll + margin.
    const stateDir = join("/tmp", `aight-wd-ppid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const pidFile = join("/tmp", `aight-wd-pid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const parent = Bun.spawn(
      [
        "bash",
        "-c",
        `bun ${JSON.stringify(ENTRY)} < <(sleep 60) >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}; sleep 60`,
      ],
      { stdout: "ignore", stderr: "ignore", env: { ...process.env, AIGHT_STATE_DIR: stateDir, AIGHT_RELAY_URL: "https://127.0.0.1:1" } },
    );
    await Bun.sleep(2500);
    const pluginPid = Number.parseInt((await Bun.file(pidFile).text()).trim(), 10);
    expect(Number.isFinite(pluginPid)).toBe(true);
    // Orphan the plugin by killing its parent shell.
    parent.kill(9);

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let exited = false;
    for (let i = 0; i < 12; i++) {
      if (!alive(pluginPid)) {
        exited = true;
        break;
      }
      await Bun.sleep(1000);
    }
    if (!exited) {
      try {
        process.kill(pluginPid, 9);
      } catch {}
      throw new Error("orphaned plugin did not self-exit — live-ppid watchdog failed");
    }
    expect(exited).toBe(true);
  }, 20000);
});
