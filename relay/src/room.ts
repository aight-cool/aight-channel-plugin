/**
 * ChannelRoom — Durable Object that bridges a plugin WebSocket and an app WebSocket
 *
 * Lifecycle:
 * 1. Plugin connects via /ws/plugin/:roomId → stored as this.pluginWs
 * 2. App connects via /ws/app/:roomId → stored as this.appWs
 * 3. Messages from app are forwarded to plugin, and vice versa
 * 4. If either side disconnects, the other is notified
 * 5. Room auto-cleans after 10 min of no connections (alarm)
 *
 * The DO is keyed by roomId, so each room is a separate isolate.
 */

export interface Env {
  RELAY_AUTH_SECRET: string;
  CHANNEL_ROOM: DurableObjectNamespace;
}

interface SessionInfo {
  ws: WebSocket;
  role: Role;
  connectedAt: number;
}

type Role = "plugin" | "app";

function otherRole(role: Role): Role {
  return role === "plugin" ? "app" : "plugin";
}

const ROOM_TTL_MS = 10 * 60 * 1000; // 10 minutes with no connections → self-destruct

export class ChannelRoom implements DurableObject {
  private sessions: Map<WebSocket, SessionInfo> = new Map();
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    // Restore sessions from hibernation — WebSocket objects survive but
    // in-memory Maps don't. Recover role metadata from attachments.
    for (const ws of this.state.getWebSockets()) {
      this.recoverSession(ws);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Status endpoint (for debugging)
    if (url.pathname === "/status") {
      const roles = [...this.sessions.values()].map((s) => s.role);
      return Response.json({
        sessions: this.sessions.size,
        hasPlugin: roles.includes("plugin"),
        hasApp: roles.includes("app"),
      });
    }

    // WebSocket upgrade
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const role = url.searchParams.get("role") as "plugin" | "app" | null;
    if (!role || (role !== "plugin" && role !== "app")) {
      return new Response("Missing or invalid role", { status: 400 });
    }

    // Check if this role already has a connection
    for (const session of this.sessions.values()) {
      if (session.role === role) {
        // Disconnect the old one — new connection takes over
        try {
          session.ws.close(4000, "Replaced by new connection");
        } catch {
          // already closed
        }
        this.sessions.delete(session.ws);
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.state.acceptWebSocket(server);

    const connectedAt = Date.now();
    const sessionInfo: SessionInfo = { ws: server, role, connectedAt };
    this.sessions.set(server, sessionInfo);

    // Persist role metadata so it survives DO hibernation
    server.serializeAttachment({ role, connectedAt });

    // Notify the other side about the connection
    this.notifyPeer(otherRole(role), {
      type: "peer_connected",
      role,
      timestamp: new Date().toISOString(),
    });

    // Cancel any pending alarm (room is alive)
    await this.state.storage.deleteAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const session = this.sessions.get(ws) ?? this.recoverSession(ws);
    if (!session) return;

    // Forward to the peer (plugin ↔ app)
    const peer = otherRole(session.role);
    for (const [peerWs, peerSession] of this.sessions) {
      if (peerSession.role === peer) {
        try {
          peerWs.send(message);
        } catch {
          // Peer disconnected
          this.sessions.delete(peerWs);
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    await this.handleDisconnect(ws, code, reason);
  }

  async webSocketError(ws: WebSocket, _error: unknown) {
    await this.handleDisconnect(ws, 1006, "WebSocket error");
  }

  /** Recover session metadata from a hibernated WebSocket's attachment. */
  private recoverSession(ws: WebSocket): SessionInfo | undefined {
    const attachment = ws.deserializeAttachment() as
      | { role: Role; connectedAt: number }
      | undefined;
    if (!attachment) return undefined;
    const info: SessionInfo = { ws, role: attachment.role, connectedAt: attachment.connectedAt };
    this.sessions.set(ws, info);
    return info;
  }

  private async handleDisconnect(ws: WebSocket, code: number, reason: string) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);

    if (session) {
      this.notifyPeer(otherRole(session.role), {
        type: "peer_disconnected",
        role: session.role,
        code,
        reason,
        timestamp: new Date().toISOString(),
      });
    }

    if (this.sessions.size === 0) {
      await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    }
  }

  async alarm() {
    // TTL expired with no connections — clean up
    // Durable Object will be evicted from memory
  }

  private notifyPeer(targetRole: Role, message: object) {
    const payload = JSON.stringify(message);
    for (const [ws, session] of this.sessions) {
      if (session.role === targetRole) {
        try {
          ws.send(payload);
        } catch {
          this.sessions.delete(ws);
        }
      }
    }
  }
}
