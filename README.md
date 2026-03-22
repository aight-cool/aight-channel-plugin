# Aight Channel Plugin

Chat with your Claude Code session from your phone — works from anywhere.

## How it works

```
                        ┌─────────────────────────────┐
Phone (Aight App)  ──WSS──►  Cloudflare Relay (DO)  ◄──WSS──  Plugin (your Mac)
                        └─────────────────────────────┘
                                    │
                              Plugin ──MCP/stdio──► Claude Code
```

**Relay mode** (default): Plugin connects outbound to Cloudflare Workers relay. No port forwarding, no Tailscale, no LAN requirement. A 6-digit pairing code links your phone.

**Local mode** (`AIGHT_LOCAL=1`): Plugin runs a WebSocket server on your LAN. Direct connection, zero cloud.

## Setup

```bash
cd aight-channel-plugin
bun install
```

### Relay mode (recommended)
```bash
AIGHT_RELAY_URL=https://channels.aight.cool bun run src/index.ts
```

The plugin will:
1. Create a relay room
2. Display a **6-digit pairing code** in the terminal
3. You enter the code in the Aight app → connected!

### Local mode
```bash
AIGHT_LOCAL=1 bun run src/index.ts
```

Connect your phone to `ws://<your-mac-ip>:8792/ws` (or scan the QR code).

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `AIGHT_RELAY_URL` | Relay server URL | _(none — local mode)_ |
| `AIGHT_LOCAL` | Force local mode | `0` |
| `AIGHT_PORT` | Local WebSocket port | `8792` |

## WebSocket Protocol

### App → Plugin
```json
{ "type": "message", "id": "msg_123", "content": "hello", "sender": { "name": "Bruno", "device": "iPhone" } }
```

### Plugin → App
```json
{ "type": "connected", "channelName": "aight", "timestamp": "..." }
{ "type": "ack", "messageId": "msg_123", "timestamp": "..." }
{ "type": "typing", "timestamp": "..." }
{ "type": "reply", "id": "claude_1", "content": "Here's...", "replyTo": "msg_123", "timestamp": "..." }
{ "type": "reaction", "emoji": "👍", "messageId": "msg_123", "timestamp": "..." }
```

## Relay

The relay lives in `relay/` — a Cloudflare Worker + Durable Objects. See [relay/DEPLOY.md](relay/DEPLOY.md) for setup.

### Pairing flow
1. Plugin: `POST /rooms` → `{ roomId, pairingCode, pluginToken, pluginWsUrl }`
2. Plugin connects to `pluginWsUrl`
3. App: `POST /pair { code }` → `{ roomId, appToken, appWsUrl }`
4. App connects to `appWsUrl`
5. Durable Object bridges the two WebSockets
