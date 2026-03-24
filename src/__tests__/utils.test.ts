import { describe, expect, it } from "bun:test";
import {
  mapHookEvent,
  mapSubagentEvent,
  summarizeToolInput,
} from "../utils";

describe("mapHookEvent", () => {
  it("maps known hook events", () => {
    expect(mapHookEvent("PreToolUse")).toBe("start");
    expect(mapHookEvent("PostToolUse")).toBe("end");
    expect(mapHookEvent("PostToolUseFailure")).toBe("error");
  });

  it("returns undefined for unknown events", () => {
    expect(mapHookEvent("Unknown")).toBeUndefined();
    expect(mapHookEvent("SubagentStart")).toBeUndefined();
  });
});

describe("mapSubagentEvent", () => {
  it("maps known subagent events", () => {
    expect(mapSubagentEvent("SubagentStart")).toBe("subagent_start");
    expect(mapSubagentEvent("SubagentStop")).toBe("subagent_end");
  });

  it("returns undefined for non-subagent events", () => {
    expect(mapSubagentEvent("PreToolUse")).toBeUndefined();
    expect(mapSubagentEvent("Unknown")).toBeUndefined();
  });
});

describe("summarizeToolInput", () => {
  it("summarizes Bash commands", () => {
    expect(summarizeToolInput("Bash", { command: "npm test" })).toBe("npm test");
  });

  it("truncates long Bash commands", () => {
    const longCmd = "x".repeat(300);
    expect(summarizeToolInput("Bash", { command: longCmd })).toHaveLength(200);
  });

  it("extracts file_path for Read/Edit/Write", () => {
    expect(summarizeToolInput("Read", { file_path: "/foo/bar.ts" })).toBe("/foo/bar.ts");
    expect(summarizeToolInput("Edit", { file_path: "/foo/bar.ts" })).toBe("/foo/bar.ts");
    expect(summarizeToolInput("Write", { file_path: "/foo/bar.ts" })).toBe("/foo/bar.ts");
  });

  it("falls back to truncated JSON for other tools", () => {
    const result = summarizeToolInput("Grep", { pattern: "foo", path: "/bar" });
    expect(result).toContain("foo");
    expect(result).toContain("/bar");
  });

  it("returns empty string for missing input", () => {
    expect(summarizeToolInput("Bash", undefined)).toBe("");
  });
});
