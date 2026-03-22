/**
 * Relay Client — connects the plugin to the Cloudflare relay
 *
 * Flow:
 * 1. Try to load a saved session from disk and reconnect
 * 2. If no saved session (or reconnect fails), POST /pair → new session
 * 3. Connect to /ws/plugin?session=<token>&id=<sessionId>
 * 4. Display pairing code in terminal
 * 5. App enters code → connects, messages flow
 *
 * Session persistence ensures the app's saved token stays valid
 * across plugin restarts — no re-pairing needed.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { dirname } from "path";

const RECONNECT_DELAY_MS = 3000;
const PING_INTERVAL_MS = 25000;

export interface RelaySession {
  code: string;
  sessionToken: string;
  sessionId: string;
}

export interface RelayClientCallbacks {
  /** Called when a message arrives from the app (via relay) */
  onMessage: (data: {
    type: string;
    id?: string;
    content?: string;
    sender?: { name?: string; device?: string };
  }) => void;
  /** Called when connection state changes */
  onStateChange: (
    state: "connecting" | "connected" | "disconnected" | "error",
  ) => void;
  /** Called when a pairing code is available for display */
  onPairingCode: (code: string, relayUrl: string) => void;
}

export interface RelayClientOptions {
  /** Path to save/load session state for persistence across restarts */
  sessionFile?: string;
}

export class RelayClient {
  private relayUrl: string;
  private session: RelaySession | null = null;
  private ws: WebSocket | null = null;
  private callbacks: RelayClientCallbacks;
  private options: RelayClientOptions;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  constructor(
    relayUrl: string,
    callbacks: RelayClientCallbacks,
    options: RelayClientOptions = {},
  ) {
    this.relayUrl = relayUrl.replace(/\/+$/, "");
    this.callbacks = callbacks;
    this.options = options;
  }

  get sessionInfo(): RelaySession | null {
    return this.session;
  }

  get pairingCode(): string | null {
    return this.session?.code ?? null;
  }

  /** Save session to disk so we can reconnect after restart */
  private saveSession(): void {
    if (!this.options.sessionFile || !this.session) return;
    try {
      mkdirSync(dirname(this.options.sessionFile), { recursive: true });
      writeFileSync(
        this.options.sessionFile,
        JSON.stringify(this.session),
        "utf-8",
      );
      console.error(
        `[aight-relay] Session saved to ${this.options.sessionFile}`,
      );
    } catch (err) {
      console.error(`[aight-relay] Failed to save session: ${err}`);
    }
  }

  /** Load a previously saved session from disk */
  private loadSession(): RelaySession | null {
    if (!this.options.sessionFile) return null;
    try {
      const data = readFileSync(this.options.sessionFile, "utf-8");
      const session = JSON.parse(data) as RelaySession;
      if (session.sessionToken && session.sessionId) {
        console.error(
          `[aight-relay] Loaded saved session: ${session.sessionId}`,
        );
        return session;
      }
    } catch {
      // No saved session or invalid — that's fine
    }
    return null;
  }

  /** Delete saved session (e.g. when it's no longer valid) */
  private clearSavedSession(): void {
    if (!this.options.sessionFile) return;
    try {
      unlinkSync(this.options.sessionFile);
    } catch {
      // Already gone
    }
  }

  async start(): Promise<void> {
    this.intentionalClose = false;
    this.callbacks.onStateChange("connecting");

    // Try to resume a saved session first
    const saved = this.loadSession();
    if (saved) {
      this.session = saved;
      console.error(
        `[aight-relay] Attempting to reconnect to saved session ${saved.sessionId}...`,
      );
      this.connectWebSocket(true);
      return;
    }

    // No saved session — create a new one
    await this.createNewSession();
  }

  /** Create a brand new pairing session */
  private async createNewSession(): Promise<void> {
    try {
      const res = await fetch(`${this.relayUrl}/pair`, { method: "POST" });
      if (!res.ok) {
        throw new Error(`Pairing request failed: ${res.status}`);
      }
      this.session = (await res.json()) as RelaySession;
      console.error(
        `[aight-relay] Session created: ${this.session.sessionId} | Code: ${this.session.code}`,
      );

      // Don't save yet — wait until the app actually pairs.
      // Saving now would persist an unpaired session that can't receive messages.

      // Notify about pairing code
      this.callbacks.onPairingCode(this.session.code, this.relayUrl);
    } catch (err) {
      console.error(`[aight-relay] Failed to create session: ${err}`);
      this.callbacks.onStateChange("error");
      this.scheduleReconnect();
      return;
    }

    this.connectWebSocket(false);
  }

  /**
   * Connect WebSocket to the relay using the current session.
   * @param isReconnect - true if resuming a saved session (will fall back to new session on failure)
   */
  private connectWebSocket(isReconnect: boolean): void {
    if (!this.session) return;

    console.error(
      `[aight-relay] ${isReconnect ? "Reconnecting" : "Connecting"} to relay...`,
    );
    this.callbacks.onStateChange("connecting");

    // Build the plugin WebSocket URL
    const wsBase = this.relayUrl.replace(/^http/, "ws");
    const wsUrl = `${wsBase}/ws/plugin?session=${encodeURIComponent(this.session.sessionToken)}&id=${encodeURIComponent(this.session.sessionId)}`;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error(`[aight-relay] WebSocket creation failed: ${err}`);
      if (isReconnect) {
        console.error(
          `[aight-relay] Saved session failed — creating new session`,
        );
        this.clearSavedSession();
        this.session = null;
        this.createNewSession();
        return;
      }
      this.callbacks.onStateChange("error");
      this.scheduleReconnect();
      return;
    }

    let didConnect = false;

    this.ws.addEventListener("open", () => {
      didConnect = true;
      console.error(`[aight-relay] Connected to relay`);
      this.callbacks.onStateChange("connected");
      this.startPing();
    });

    this.ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(
          typeof event.data === "string" ? event.data : "",
        );

        // Relay control messages
        if (data.type === "waiting_for_pair") {
          console.error(`[aight-relay] ⏳ Waiting for app to pair...`);
          return;
        }

        if (data.type === "paired") {
          console.error(`[aight-relay] 📱 App paired successfully!`);
          // NOW persist — the session is paired and worth reconnecting to
          this.saveSession();
          this.send({
            type: "connected",
            channelName: "aight",
            timestamp: new Date().toISOString(),
          });
          return;
        }

        if (data.type === "partner_connected") {
          console.error(`[aight-relay] 📱 App connected`);
          this.send({
            type: "connected",
            channelName: "aight",
            timestamp: new Date().toISOString(),
          });
          return;
        }

        if (data.type === "partner_disconnected") {
          console.error(`[aight-relay] 📱 App disconnected`);
          return;
        }

        if (data.type === "pong") return;

        // Forward app messages (message, ping) to the MCP handler
        this.callbacks.onMessage(data);
      } catch {
        // Ignore malformed
      }
    });

    this.ws.addEventListener("close", () => {
      this.stopPing();
      if (this.intentionalClose) return;

      // If we never connected and this was a reconnect attempt,
      // the saved session is dead — create a new one
      if (!didConnect && isReconnect) {
        console.error(
          `[aight-relay] Saved session rejected — creating new session`,
        );
        this.clearSavedSession();
        this.session = null;
        this.createNewSession();
        return;
      }

      console.error(`[aight-relay] Disconnected, reconnecting...`);
      this.callbacks.onStateChange("disconnected");
      this.scheduleReconnect();
    });

    this.ws.addEventListener("error", () => {
      // onclose fires after
    });
  }

  /** Send a message to the app via relay */
  send(data: object): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  stop(): void {
    this.intentionalClose = true;
    this.stopPing();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.callbacks.onStateChange("disconnected");
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    this.reconnectTimeout = setTimeout(() => {
      if (this.session) {
        // Reconnect to existing session (not a saved-session reconnect,
        // just a normal WS reconnect to the same session)
        this.connectWebSocket(false);
      } else {
        this.createNewSession();
      }
    }, RECONNECT_DELAY_MS);
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
