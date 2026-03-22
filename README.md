# Aight Channel Plugin — Phase 0 MVP

Chat with your Claude Code session from your phone over LAN.

## Setup

```bash
# Install dependencies
cd aight-channel-plugin
bun install

# Add to your .mcp.json (project or ~/.claude.json)
# {
#   "mcpServers": {
#     "aight": { "command": "bun", "args": ["run", "/path/to/aight-channel-plugin/src/index.ts"] }
#   }
# }

# Start Claude Code with the channel
claude --dangerously-load-development-channels server:aight
```

## How it works

```
Phone (Aight App)  ──WebSocket──>  Plugin (your Mac)  ──MCP/stdio──>  Claude Code
     <──WebSocket──                   <──MCP/stdio──
```

1. Plugin starts a WebSocket server on port 8790 (configurable via `AIGHT_PORT`)
2. Plugin listens on all interfaces (0.0.0.0) so your phone can connect over LAN
3. Phone sends JSON messages → plugin forwards to Claude Code via MCP channel notification
4. Claude replies via the `reply` tool → plugin sends JSON back over WebSocket

## WebSocket Protocol

### App → Plugin

```json
{
  "type": "message",
  "id": "msg_123",
  "content": "what files are in my project?",
  "sender": { "name": "Bruno", "device": "iPhone" }
}
```

### Plugin → App

```json
// Connection established
{ "type": "connected", "channelName": "aight", "timestamp": "..." }

// Message acknowledged
{ "type": "ack", "messageId": "msg_123", "timestamp": "..." }

// Claude is thinking
{ "type": "typing", "timestamp": "..." }

// Claude's reply
{ "type": "reply", "id": "claude_1", "content": "Here are the files...", "replyTo": "msg_123", "timestamp": "..." }

// Reaction
{ "type": "reaction", "emoji": "👍", "messageId": "msg_123", "timestamp": "..." }

// Ping/pong (keepalive)
{ "type": "ping" } → { "type": "pong", "timestamp": "..." }
```

## Endpoints

- `ws://<ip>:8790/ws` — WebSocket connection for the app
- `GET /status` — JSON health check (clients count, uptime)

## Environment Variables

- `AIGHT_PORT` — WebSocket server port (default: 8790)
