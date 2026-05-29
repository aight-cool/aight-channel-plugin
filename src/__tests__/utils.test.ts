import { describe, expect, it } from "bun:test";
import {
  mapHookEvent,
  mapSubagentEvent,
  parseAskUserQuestionInput,
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

describe("parseAskUserQuestionInput", () => {
  it("parses the documented questions/options shape", () => {
    const parsed = parseAskUserQuestionInput({
      questions: [
        {
          question: "Which approach?",
          header: "Approach",
          multiSelect: false,
          options: [
            { label: "Option A", description: "Does A" },
            { label: "Option B", description: "Does B" },
          ],
        },
      ],
    });
    expect(parsed).toEqual([
      {
        question: "Which approach?",
        header: "Approach",
        multiSelect: false,
        options: [
          { label: "Option A", description: "Does A" },
          { label: "Option B", description: "Does B" },
        ],
      },
    ]);
  });

  it("tolerates bare-string options and omits empty descriptions", () => {
    const parsed = parseAskUserQuestionInput({
      questions: [{ question: "Pick one", options: ["Yes", "No"] }],
    });
    expect(parsed).toEqual([
      {
        question: "Pick one",
        header: undefined,
        multiSelect: false,
        options: [{ label: "Yes" }, { label: "No" }],
      },
    ]);
  });

  it("defaults multiSelect to false and reads it when true", () => {
    const single = parseAskUserQuestionInput({
      questions: [{ question: "q", options: [{ label: "a" }] }],
    });
    expect(single?.[0]?.multiSelect).toBe(false);

    const multi = parseAskUserQuestionInput({
      questions: [{ question: "q", multiSelect: true, options: [{ label: "a" }] }],
    });
    expect(multi?.[0]?.multiSelect).toBe(true);
  });

  it("drops malformed options but keeps valid questions", () => {
    const parsed = parseAskUserQuestionInput({
      questions: [
        { question: "q", options: [{ description: "no label" }, { label: "ok" }] },
      ],
    });
    expect(parsed?.[0]?.options).toEqual([{ label: "ok" }]);
  });

  it("returns null for invalid or empty input", () => {
    expect(parseAskUserQuestionInput(undefined)).toBeNull();
    expect(parseAskUserQuestionInput({})).toBeNull();
    expect(parseAskUserQuestionInput({ questions: [] })).toBeNull();
    expect(parseAskUserQuestionInput({ questions: "nope" as unknown as [] })).toBeNull();
    // A question with neither text nor options is dropped → null overall.
    expect(parseAskUserQuestionInput({ questions: [{ options: [] }] })).toBeNull();
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
