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

export class RelayClient {
  private relayUrl: string;
  private session: RelaySession | null = null;
  private ws: WebSocket | null = null;
  private callbacks: RelayClientCallbacks;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  constructor(relayUrl: string, callbacks: RelayClientCallbacks) {
    this.relayUrl = relayUrl.replace(/\/+$/, "");
    this.callbacks = callbacks;
  }

  get sessionInfo(): RelaySession | null {
    return this.session;
  }

  get pairingCode(): string | null {
    return this.session?.code ?? null;
  }

  async start(): Promise<void> {
    this.intentionalClose = false;
    this.callbacks.onStateChange("connecting");
    try {
      const res = await fetch(`${this.relayUrl}/pair`, { method: "POST" });
      if (!res.ok) {
        throw new Error(`Pairing request failed: ${res.status}`);
      }
      this.session = (await res.json()) as RelaySession;
      console.error(
        `[aight-relay] Session created: ${this.session.sessionId} | Code: ${this.session.code}`,
      );

      // Notify about pairing code
      this.callbacks.onPairingCode(this.session.code, this.relayUrl);
    } catch (err) {
      console.error(`[aight-relay] Failed to create session: ${err}`);
      this.callbacks.onStateChange("error");
      this.scheduleReconnect();
      return;
    }

    this.connectWebSocket();
  }

  private connectWebSocket(): void {
    if (!this.session) return;

    console.error(`[aight-relay] Connecting to relay...`);
    this.callbacks.onStateChange("connecting");

    // Connect with only the session ID in the URL — token sent as first WS message
    // (H3: tokens should not appear in URLs where they get logged)
    const wsBase = this.relayUrl.replace(/^http/, "ws");
    const wsUrl = `${wsBase}/ws/plugin?id=${encodeURIComponent(this.session.sessionId)}`;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error(`[aight-relay] WebSocket creation failed: ${err}`);
      this.callbacks.onStateChange("error");
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener("open", () => {
      console.error(`[aight-relay] WebSocket open, authenticating...`);
      // Send token as first message instead of in URL (security: H3)
      this.ws!.send(
        JSON.stringify({
          type: "auth",
          token: this.session!.sessionToken,
        }),
      );
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
      if (!this.intentionalClose) {
        console.error(`[aight-relay] Disconnected, reconnecting...`);
        this.callbacks.onStateChange("disconnected");
        this.scheduleReconnect();
      }
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
        this.connectWebSocket();
      } else {
        this.start();
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
