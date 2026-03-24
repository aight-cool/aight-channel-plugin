import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  utimesSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sanitizeFileName, MIME_MAP, cleanInbox } from "../utils";

describe("sanitizeFileName", () => {
  it("replaces path separators", () => {
    expect(sanitizeFileName("../../../etc/passwd")).toBe(".._.._.._etc_passwd");
    expect(sanitizeFileName("..\\..\\windows\\system32")).toBe(
      ".._.._windows_system32",
    );
  });

  it("preserves safe characters", () => {
    expect(sanitizeFileName("photo.jpg")).toBe("photo.jpg");
    expect(sanitizeFileName("my-file_v2.png")).toBe("my-file_v2.png");
    expect(sanitizeFileName("DOCUMENT.PDF")).toBe("DOCUMENT.PDF");
  });

  it("handles unicode and special characters", () => {
    expect(sanitizeFileName("caf\u00e9.txt")).toBe("caf_.txt");
    expect(sanitizeFileName("file (1).jpg")).toBe("file__1_.jpg");
    expect(sanitizeFileName("my file!@#$.txt")).toBe("my_file____.txt");
  });
});

describe("MIME_MAP", () => {
  it("maps common extensions correctly", () => {
    expect(MIME_MAP[".png"]).toBe("image/png");
    expect(MIME_MAP[".jpg"]).toBe("image/jpeg");
    expect(MIME_MAP[".jpeg"]).toBe("image/jpeg");
    expect(MIME_MAP[".pdf"]).toBe("application/pdf");
    expect(MIME_MAP[".md"]).toBe("text/markdown");
    expect(MIME_MAP[".json"]).toBe("application/json");
  });

  it("returns undefined for unknown extensions", () => {
    expect(MIME_MAP[".xyz"]).toBeUndefined();
  });
});

describe("cleanInbox", () => {
  const testInbox = join(tmpdir(), `aight-inbox-test-${process.pid}`);

  beforeEach(() => {
    mkdirSync(testInbox, { recursive: true });
  });

  afterEach(() => {
    rmSync(testInbox, { recursive: true, force: true });
  });

  it("removes files older than 24h", () => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    const oldFile = join(testInbox, "old-file.txt");
    writeFileSync(oldFile, "old");
    const oldTime = new Date(cutoff - 1000);
    utimesSync(oldFile, oldTime, oldTime);

    const newFile = join(testInbox, "new-file.txt");
    writeFileSync(newFile, "new");

    cleanInbox(testInbox, 1_000_000);

    const remaining = readdirSync(testInbox);
    expect(remaining).not.toContain("old-file.txt");
    expect(remaining).toContain("new-file.txt");
  });

  it("enforces total size cap with oldest-first eviction", () => {
    const now = Date.now();
    const files = [
      { name: "file1.txt", content: "a".repeat(100), age: 3000 },
      { name: "file2.txt", content: "b".repeat(200), age: 2000 },
      { name: "file3.txt", content: "c".repeat(300), age: 1000 },
    ];

    for (const f of files) {
      const path = join(testInbox, f.name);
      writeFileSync(path, f.content);
      const mtime = new Date(now - f.age);
      utimesSync(path, mtime, mtime);
    }

    cleanInbox(testInbox, 400);

    const remaining = readdirSync(testInbox);
    expect(remaining).not.toContain("file1.txt");
    expect(remaining).not.toContain("file2.txt");
    expect(remaining).toContain("file3.txt");
  });

  it("handles non-existent inbox directory", () => {
    expect(() => cleanInbox("/nonexistent/path", 1000)).not.toThrow();
  });
});

describe("base64 encoding/decoding", () => {
  it("round-trips binary data correctly", () => {
    const original = Buffer.from([0, 1, 2, 255, 254, 253]);
    const base64 = original.toString("base64");
    const decoded = Buffer.from(base64, "base64");
    expect(decoded).toEqual(original);
  });

  it("estimates base64 size correctly", () => {
    const binarySize = 1_000_000;
    const base64Length = Math.ceil((binarySize * 4) / 3);
    const estimatedBinarySize = (base64Length * 3) / 4;
    expect(estimatedBinarySize).toBeGreaterThanOrEqual(binarySize);
    expect(estimatedBinarySize).toBeLessThan(binarySize * 1.01);
  });
});
