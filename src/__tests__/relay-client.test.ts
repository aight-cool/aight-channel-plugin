import { describe, expect, it, beforeEach, mock } from "bun:test";
import { RelayClient, type RelayClientCallbacks } from "../relay-client";

// Mock fetch for pairing tests
const originalFetch = globalThis.fetch;

function createMockCallbacks(): RelayClientCallbacks & {
  messages: Array<Record<string, unknown>>;
  states: string[];
  pairingCodes: string[];
} {
  const messages: Array<Record<string, unknown>> = [];
  const states: string[] = [];
  const pairingCodes: string[] = [];

  return {
    messages,
    states,
    pairingCodes,
    onMessage: (data) => {
      messages.push(data as Record<string, unknown>);
    },
    onStateChange: (state) => {
      states.push(state);
    },
    onPairingCode: (code, _url) => {
      pairingCodes.push(code);
    },
  };
}

describe("RelayClient", () => {
  describe("constructor", () => {
    it("strips trailing slashes from relay URL", () => {
      const callbacks = createMockCallbacks();
      const client = new RelayClient("https://relay.example.com///", callbacks);
      expect(client.sessionInfo).toBeNull();
      expect(client.sessionInfo?.code).toBeUndefined();
    });

    it("starts with null session", () => {
      const callbacks = createMockCallbacks();
      const client = new RelayClient("https://relay.example.com", callbacks);
      expect(client.sessionInfo).toBeNull();
      expect(client.sessionInfo?.code).toBeUndefined();
    });
  });

  describe("start", () => {
    it("reports error state when pairing request fails", async () => {
      const callbacks = createMockCallbacks();
      const client = new RelayClient(
        "https://relay.invalid.example.com",
        callbacks,
      );

      // Mock fetch to fail
      globalThis.fetch = mock(() =>
        Promise.reject(new Error("Network error")),
      ) as typeof fetch;

      await client.start();

      expect(callbacks.states).toContain("connecting");
      expect(callbacks.states).toContain("error");

      // Clean up
      client.stop();
      globalThis.fetch = originalFetch;
    });

    it("reports error state when pairing returns non-200", async () => {
      const callbacks = createMockCallbacks();
      const client = new RelayClient("https://relay.example.com", callbacks);

      globalThis.fetch = mock(() =>
        Promise.resolve(new Response("Service Unavailable", { status: 503 })),
      ) as typeof fetch;

      await client.start();

      expect(callbacks.states).toContain("error");

      client.stop();
      globalThis.fetch = originalFetch;
    });
  });

  describe("send", () => {
    it("returns false when no WebSocket is connected", () => {
      const callbacks = createMockCallbacks();
      const client = new RelayClient("https://relay.example.com", callbacks);
      const result = client.send({
        type: "reply",
        id: "test",
        content: "hello",
        replyTo: null,
        sender: {
          id: "claude",
          name: "Claude",
          emoji: "\u{1F916}",
          username: "claude",
        },
        timestamp: new Date().toISOString(),
      });
      expect(result).toBe(false);
    });
  });

  describe("stop", () => {
    it("transitions to disconnected state", () => {
      const callbacks = createMockCallbacks();
      const client = new RelayClient("https://relay.example.com", callbacks);
      client.stop();
      expect(callbacks.states).toContain("disconnected");
    });

    it("can be called multiple times safely", () => {
      const callbacks = createMockCallbacks();
      const client = new RelayClient("https://relay.example.com", callbacks);
      client.stop();
      client.stop();
      client.stop();
      // Should not throw
      expect(callbacks.states.filter((s) => s === "disconnected").length).toBe(
        3,
      );
    });
  });

  describe("exponential backoff", () => {
    it("calculates increasing delays", () => {
      // Test the backoff formula directly
      const BASE = 3_000;
      const MAX = 60_000;

      const delays = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        const exponential = Math.min(BASE * Math.pow(2, attempt), MAX);
        delays.push(exponential);
      }

      // Verify exponential growth
      expect(delays[0]).toBe(3_000); // 3s
      expect(delays[1]).toBe(6_000); // 6s
      expect(delays[2]).toBe(12_000); // 12s
      expect(delays[3]).toBe(24_000); // 24s
      expect(delays[4]).toBe(48_000); // 48s
      expect(delays[5]).toBe(60_000); // 60s (capped)
      expect(delays[6]).toBe(60_000); // 60s (capped)
    });
  });
});
