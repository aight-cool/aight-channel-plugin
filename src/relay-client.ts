/**
 * Relay Client — connects the plugin to the Cloudflare relay
 *
 * Flow:
 * 1. POST /rooms → get { roomId, pairingCode, pluginToken, pluginWsUrl }
 * 2. Connect to pluginWsUrl as "plugin" role
 * 3. Display pairing code in terminal (+ QR code)
 * 4. App enters code → POST /pair → gets appWsUrl → connects
 * 5. Durable Object bridges the two WebSockets
 */

const RECONNECT_DELAY_MS = 3000;
const PING_INTERVAL_MS = 25000;

export interface RelayRoom {
  roomId: string;
  pairingCode: string;
  pluginToken: string;
  pluginWsUrl: string;
}

export interface RelayClientCallbacks {
  /** Called when a message arrives from the app (via relay) */
  onMessage: (data: {
    type: string;
    id?: string;
    content?: string;
    sender?: { name?: string; device?: string };
  }) => void;
  /** Called when relay sends a reply back to the app */
  onSend: (data: object) => void;
  /** Called when connection state changes */
  onStateChange: (
    state: "connecting" | "connected" | "disconnected" | "error",
  ) => void;
  /** Called when a pairing code is available for display */
  onPairingCode: (code: string, relayUrl: string) => void;
}

export class RelayClient {
  private relayUrl: string;
  private room: RelayRoom | null = null;
  private ws: WebSocket | null = null;
  private callbacks: RelayClientCallbacks;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  constructor(relayUrl: string, callbacks: RelayClientCallbacks) {
    this.relayUrl = relayUrl.replace(/\/+$/, "");
    this.callbacks = callbacks;
  }

  get roomInfo(): RelayRoom | null {
    return this.room;
  }

  get pairingCode(): string | null {
    return this.room?.pairingCode ?? null;
  }

  async start(): Promise<void> {
    this.intentionalClose = false;
    this.callbacks.onStateChange("connecting");

    // Create a room
    try {
      const res = await fetch(`${this.relayUrl}/rooms`, { method: "POST" });
      if (!res.ok) {
        throw new Error(`Room creation failed: ${res.status}`);
      }
      this.room = (await res.json()) as RelayRoom;
      console.error(
        `[aight-relay] Room created: ${this.room.roomId} | Code: ${this.room.pairingCode}`,
      );

      // Notify about pairing code
      this.callbacks.onPairingCode(this.room.pairingCode, this.relayUrl);
    } catch (err) {
      console.error(`[aight-relay] Failed to create room: ${err}`);
      this.callbacks.onStateChange("error");
      this.scheduleReconnect();
      return;
    }

    this.connectWebSocket();
  }

  private connectWebSocket(): void {
    if (!this.room) return;

    console.error(`[aight-relay] Connecting to relay...`);
    this.callbacks.onStateChange("connecting");

    try {
      this.ws = new WebSocket(this.room.pluginWsUrl);
    } catch (err) {
      console.error(`[aight-relay] WebSocket creation failed: ${err}`);
      this.callbacks.onStateChange("error");
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener("open", () => {
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
        if (data.type === "peer_connected" && data.role === "app") {
          console.error(`[aight-relay] 📱 App connected via relay`);
          // Send connection confirmation to app
          this.send({
            type: "connected",
            channelName: "aight",
            timestamp: new Date().toISOString(),
          });
          return;
        }

        if (data.type === "peer_disconnected" && data.role === "app") {
          console.error(`[aight-relay] 📱 App disconnected from relay`);
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
      if (this.room) {
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
