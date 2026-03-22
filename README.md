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

Plugin connects outbound to the Cloudflare Workers relay at `channels.aight.cool`. No port forwarding, no Tailscale, no LAN requirement. A 6-digit pairing code links your phone.

## Setup

```bash
cd aight-channel-plugin
bun install
```

### Usage

```bash
# Load as a Claude Code channel plugin
claude --dangerously-load-development-channels server:aight
```

The plugin will:
1. Connect to the relay at `channels.aight.cool`
2. Display a **6-digit pairing code** in the terminal
3. Enter the code in the Aight app → connected!

### Custom relay URL

To use a self-hosted relay:

```bash
AIGHT_RELAY_URL=https://my-relay.example.com bun run src/index.ts
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `AIGHT_RELAY_URL` | Relay server URL | `https://channels.aight.cool` |

## WebSocket Protocol

### App → Plugin (via relay)
```json
{ "type": "message", "id": "msg_123", "content": "hello", "sender": { "name": "Bruno", "device": "iPhone" } }
```

### Plugin → App (via relay)
```json
{ "type": "connected", "channelName": "aight", "timestamp": "..." }
{ "type": "ack", "messageId": "msg_123", "timestamp": "..." }
{ "type": "typing", "timestamp": "..." }
{ "type": "reply", "id": "claude_1", "content": "Here's...", "replyTo": "msg_123", "timestamp": "..." }
{ "type": "reaction", "emoji": "👍", "messageId": "msg_123", "timestamp": "..." }
```

### Relay control messages
```json
{ "type": "paired", "sessionToken": "..." }
{ "type": "partner_connected", "timestamp": "..." }
{ "type": "partner_disconnected", "timestamp": "..." }
{ "type": "waiting_for_pair", "timestamp": "..." }
{ "type": "reconnected", "partnerConnected": true, "timestamp": "..." }
```

## Pairing Flow

1. Plugin calls `POST /pair` on the relay → gets `{ code, sessionToken, sessionId }`
2. Plugin connects to `wss://channels.aight.cool/ws/plugin?session=<token>&id=<sessionId>`
3. Plugin displays the 6-digit code in Claude Code terminal
4. User enters code in Aight app
5. App connects to `wss://channels.aight.cool/ws/app?code=<code>`
6. Relay pairs the two, sends `{ type: "paired" }` to both
7. Messages flow bidirectionally through the relay

## Related

- [aight-channel-relay](https://github.com/aight-cool/aight-channel-relay) — the Cloudflare Worker relay
- [Aight](https://aight.cool) — the iOS app
