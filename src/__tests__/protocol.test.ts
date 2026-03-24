import { describe, expect, it } from "bun:test";
import { parseInboundMessage, LIMITS } from "../protocol";

describe("parseInboundMessage", () => {
  describe("valid messages", () => {
    it("parses a valid message", () => {
      const msg = parseInboundMessage({
        type: "message",
        id: "msg_1",
        content: "hello",
        sender: { name: "Bruno", device: "iPhone" },
      });
      expect(msg).not.toBeNull();
      expect(msg!.type).toBe("message");
      if (msg!.type === "message") {
        expect(msg!.content).toBe("hello");
        expect(msg!.id).toBe("msg_1");
        expect(msg!.sender.name).toBe("Bruno");
      }
    });

    it("parses a message with attachments", () => {
      const msg = parseInboundMessage({
        type: "message",
        id: "msg_2",
        content: "check this",
        sender: { name: "Bruno" },
        attachments: [
          {
            fileName: "photo.jpg",
            mimeType: "image/jpeg",
            content: "aGVsbG8=", // "hello" in base64
          },
        ],
      });
      expect(msg).not.toBeNull();
      if (msg!.type === "message") {
        expect(msg!.attachments).toHaveLength(1);
        expect(msg!.attachments![0].fileName).toBe("photo.jpg");
      }
    });

    it("parses ping", () => {
      const msg = parseInboundMessage({ type: "ping" });
      expect(msg).toEqual({ type: "ping" });
    });

    it("parses request_skills", () => {
      const msg = parseInboundMessage({ type: "request_skills" });
      expect(msg).toEqual({ type: "request_skills" });
    });

    it("parses paired", () => {
      const msg = parseInboundMessage({ type: "paired" });
      expect(msg).toEqual({ type: "paired" });
    });

    it("parses partner_connected", () => {
      const msg = parseInboundMessage({
        type: "partner_connected",
        timestamp: "2025-01-01T00:00:00Z",
      });
      expect(msg).not.toBeNull();
      expect(msg!.type).toBe("partner_connected");
    });

    it("parses partner_disconnected", () => {
      const msg = parseInboundMessage({ type: "partner_disconnected" });
      expect(msg).not.toBeNull();
      expect(msg!.type).toBe("partner_disconnected");
    });

    it("parses waiting_for_pair", () => {
      const msg = parseInboundMessage({ type: "waiting_for_pair" });
      expect(msg).toEqual({ type: "waiting_for_pair" });
    });

    it("parses pong", () => {
      const msg = parseInboundMessage({ type: "pong" });
      expect(msg).toEqual({ type: "pong" });
    });

    it("parses reconnected", () => {
      const msg = parseInboundMessage({
        type: "reconnected",
        partnerConnected: true,
      });
      expect(msg).not.toBeNull();
      expect(msg!.type).toBe("reconnected");
    });
  });

  describe("invalid messages", () => {
    it("rejects null", () => {
      expect(parseInboundMessage(null)).toBeNull();
    });

    it("rejects non-object", () => {
      expect(parseInboundMessage("hello")).toBeNull();
      expect(parseInboundMessage(42)).toBeNull();
      expect(parseInboundMessage(true)).toBeNull();
    });

    it("rejects object without type", () => {
      expect(parseInboundMessage({ content: "hello" })).toBeNull();
    });

    it("rejects unknown type", () => {
      expect(parseInboundMessage({ type: "unknown_type" })).toBeNull();
    });

    it("rejects message without content", () => {
      const msg = parseInboundMessage({
        type: "message",
        id: "msg_1",
        sender: { name: "Bruno" },
      });
      expect(msg).toBeNull();
    });

    it("rejects message without id", () => {
      const msg = parseInboundMessage({
        type: "message",
        content: "hello",
        sender: { name: "Bruno" },
      });
      expect(msg).toBeNull();
    });

    it("rejects message with non-string content", () => {
      const msg = parseInboundMessage({
        type: "message",
        id: "msg_1",
        content: 42,
        sender: { name: "Bruno" },
      });
      expect(msg).toBeNull();
    });
  });

  describe("size limits", () => {
    it("rejects content exceeding max length", () => {
      const msg = parseInboundMessage({
        type: "message",
        id: "msg_1",
        content: "x".repeat(LIMITS.MAX_CONTENT_LENGTH + 1),
        sender: { name: "Bruno" },
      });
      expect(msg).toBeNull();
    });

    it("accepts content at max length", () => {
      const msg = parseInboundMessage({
        type: "message",
        id: "msg_1",
        content: "x".repeat(LIMITS.MAX_CONTENT_LENGTH),
        sender: { name: "Bruno" },
      });
      expect(msg).not.toBeNull();
    });

    it("rejects sender name exceeding max length", () => {
      const msg = parseInboundMessage({
        type: "message",
        id: "msg_1",
        content: "hello",
        sender: { name: "x".repeat(LIMITS.MAX_SENDER_FIELD_LENGTH + 1) },
      });
      expect(msg).toBeNull();
    });

    it("rejects sender device exceeding max length", () => {
      const msg = parseInboundMessage({
        type: "message",
        id: "msg_1",
        content: "hello",
        sender: {
          name: "Bruno",
          device: "x".repeat(LIMITS.MAX_SENDER_FIELD_LENGTH + 1),
        },
      });
      expect(msg).toBeNull();
    });

    it("rejects too many attachments", () => {
      const attachments = Array.from(
        { length: LIMITS.MAX_ATTACHMENTS_PER_MESSAGE + 1 },
        (_, i) => ({
          fileName: `file${i}.txt`,
          mimeType: "text/plain",
          content: "aGVsbG8=",
        }),
      );
      const msg = parseInboundMessage({
        type: "message",
        id: "msg_1",
        content: "hello",
        sender: { name: "Bruno" },
        attachments,
      });
      expect(msg).toBeNull();
    });

    it("rejects oversized attachment", () => {
      // Create a base64 string that decodes to > MAX_ATTACHMENT_SIZE
      const oversizedBase64 = "A".repeat(
        Math.ceil((LIMITS.MAX_ATTACHMENT_SIZE * 4) / 3) + 100,
      );
      const msg = parseInboundMessage({
        type: "message",
        id: "msg_1",
        content: "hello",
        sender: { name: "Bruno" },
        attachments: [
          {
            fileName: "huge.bin",
            mimeType: "application/octet-stream",
            content: oversizedBase64,
          },
        ],
      });
      expect(msg).toBeNull();
    });

    it("rejects attachments with missing fileName", () => {
      const msg = parseInboundMessage({
        type: "message",
        id: "msg_1",
        content: "hello",
        sender: { name: "Bruno" },
        attachments: [{ mimeType: "text/plain", content: "aGVsbG8=" }],
      });
      expect(msg).toBeNull();
    });

    it("rejects non-array attachments", () => {
      const msg = parseInboundMessage({
        type: "message",
        id: "msg_1",
        content: "hello",
        sender: { name: "Bruno" },
        attachments: "not-an-array",
      });
      expect(msg).toBeNull();
    });
  });
});

describe("LIMITS", () => {
  it("has sensible values", () => {
    expect(LIMITS.MAX_MESSAGE_SIZE).toBe(1_048_576); // 1MB
    expect(LIMITS.MAX_CONTENT_LENGTH).toBe(51_200); // 50KB
    expect(LIMITS.MAX_ATTACHMENT_SIZE).toBe(10_485_760); // 10MB
    expect(LIMITS.MAX_OUTBOUND_FILE_SIZE).toBe(26_214_400); // 25MB
    expect(LIMITS.MAX_ATTACHMENTS_PER_MESSAGE).toBe(10);
    expect(LIMITS.MAX_SENDER_FIELD_LENGTH).toBe(200);
    expect(LIMITS.MAX_MESSAGES_PER_MINUTE).toBe(30);
    expect(LIMITS.MAX_INBOX_SIZE).toBe(524_288_000); // 500MB
  });
});
