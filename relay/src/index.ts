/**
 * Channel Relay — Cloudflare Worker entry point
 *
 * Routes:
 *   GET   /health                      → health check
 *   POST  /rooms                       → create room + pairing code
 *   POST  /pair                        → exchange pairing code for app token
 *   GET   /ws/plugin/:roomId?token=    → WebSocket for plugin side
 *   GET   /ws/app/:roomId?token=       → WebSocket for app side
 *   GET   /rooms/:roomId/status        → room debug info
 */

import { deriveToken, validateToken, generatePairingCode } from "./auth";
export { ChannelRoom } from "./room";

export interface Env {
  RELAY_AUTH_SECRET: string;
  CHANNEL_ROOM: DurableObjectNamespace;
  /** KV namespace for pairing codes (code → roomId, 5-min TTL) */
  PAIRING_CODES: KVNamespace;
}

function cors(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data: object, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors() },
  });
}

function wsBaseUrl(url: URL): string {
  const proto = url.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${url.host}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    if (!env.RELAY_AUTH_SECRET) {
      return json({ error: "Server misconfigured: missing RELAY_AUTH_SECRET" }, 500);
    }

    // ── Health ──
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "channel-relay", version: "0.1.0" });
    }

    // ── Create room (plugin calls this) ──
    if (url.pathname === "/rooms" && request.method === "POST") {
      const roomId = crypto.randomUUID();
      const pairingCode = generatePairingCode();
      const pluginToken = await deriveToken(env.RELAY_AUTH_SECRET, "plugin", roomId);

      // Store pairing code → roomId with 5 minute TTL
      await env.PAIRING_CODES.put(pairingCode, roomId, {
        expirationTtl: 300,
      });

      const wsBase = wsBaseUrl(url);

      return json({
        roomId,
        pairingCode,
        pluginToken,
        pluginWsUrl: `${wsBase}/ws/plugin/${roomId}?token=${pluginToken}`,
      });
    }

    // ── Pair (app calls this with the 6-digit code) ──
    if (url.pathname === "/pair" && request.method === "POST") {
      let body: { code?: string };
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }

      const code = body.code?.trim().toUpperCase();
      if (!code || code.length !== 6) {
        return json({ error: "Invalid pairing code" }, 400);
      }

      // Look up room, then delete code immediately to minimize the
      // TOCTOU window (KV has no atomic get-and-delete)
      const roomId = await env.PAIRING_CODES.get(code);
      if (!roomId) {
        return json({ error: "Invalid or expired pairing code" }, 404);
      }
      await env.PAIRING_CODES.delete(code);

      // Generate app token
      const appToken = await deriveToken(env.RELAY_AUTH_SECRET, "app", roomId);

      const wsBase = wsBaseUrl(url);

      return json({
        roomId,
        appToken,
        appWsUrl: `${wsBase}/ws/app/${roomId}?token=${appToken}`,
      });
    }

    // ── WebSocket connections ──
    const wsMatch = url.pathname.match(/^\/ws\/(plugin|app)\/([a-f0-9-]+)$/);
    if (wsMatch) {
      const role = wsMatch[1] as "plugin" | "app";
      const roomId = wsMatch[2];
      const token = url.searchParams.get("token");

      if (!token) {
        return json({ error: "Missing token" }, 401);
      }

      const valid = await validateToken(env.RELAY_AUTH_SECRET, role, roomId, token);
      if (!valid) {
        return json({ error: "Invalid token" }, 403);
      }

      // Route to Durable Object
      const doId = env.CHANNEL_ROOM.idFromName(roomId);
      const stub = env.CHANNEL_ROOM.get(doId);

      const doUrl = new URL(request.url);
      doUrl.searchParams.set("role", role);
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // ── Room status (debug) ──
    const statusMatch = url.pathname.match(/^\/rooms\/([a-f0-9-]+)\/status$/);
    if (statusMatch && request.method === "GET") {
      const roomId = statusMatch[1];
      const doId = env.CHANNEL_ROOM.idFromName(roomId);
      const stub = env.CHANNEL_ROOM.get(doId);
      return stub.fetch(new Request(`${url.origin}/status`));
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
