# Aight Channel Plugin

Claude Code channel plugin — chat with your session from your phone via cloud relay.

## Architecture

```
┌──────────────┐    stdio     ┌──────────────────┐
│  Claude Code │◄────────────►│ Aight Channel    │
│  (laptop)    │              │ Plugin (MCP)     │
└──────────────┘              └────────┬─────────┘
                                       │ WSS
                                       ▼
                              ┌──────────────────┐
                              │  Channel Relay   │
                              │  (Cloudflare)    │
                              └────────┬─────────┘
                                       │ WSS
                                       ▼
                              ┌──────────────────┐
                              │  Aight App       │
                              │  (iPhone)        │
                              └──────────────────┘
```

The plugin connects **outbound** to the relay at `channels.aight.cool`. No port forwarding,
no LAN requirement. A 6-digit pairing code links the phone to the session.

**Relay** is a separate project: [aight-channel-relay](https://github.com/aight-cool/aight-channel-relay)

## Source Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main entry point. MCP server, tool definitions (reply/react), hook server, relay integration |
| `src/relay-client.ts` | WebSocket client to Cloudflare relay. Handles pairing, reconnection (exponential backoff), auth |
| `src/protocol.ts` | Typed message protocol — discriminated unions for all inbound/outbound messages, validation, limits |
| `src/skills.ts` | Discovers Claude Code skills from SKILL.md files, sends to app for autocomplete |
| `src/utils.ts` | Shared utilities: rate limiter, file helpers, hook event mapping, PID file management |
| `.claude-plugin/plugin.json` | Plugin metadata for Claude marketplace |
| `.mcp.json` | MCP server config (uses `${CLAUDE_PLUGIN_ROOT}` for marketplace compatibility) |
| `setup` | Install script: deps, hooks config, shell alias |

## Key Concepts

### Channel Plugin
Loaded via `claude --dangerously-load-development-channels server:aight`. Declares
the `claude/channel` experimental capability so Claude Code routes channel messages through it.

### Pairing Flow
1. Plugin POSTs `/pair` to relay → gets `{ code, sessionToken, sessionId }`
2. Plugin connects WSS, sends auth token as first message (H3: no tokens in URLs)
3. Displays 6-digit code in terminal + writes to `~/.claude/channels/aight/pairing-code-<PID>.txt`
4. User enters code in Aight app → relay bridges the two WebSockets
5. Messages flow bidirectionally

### Hook Server (Tool Event Forwarding)
Forwards Claude Code tool events (PreToolUse, PostToolUse, SubagentStart/Stop) to the phone app.

**Architecture:** A fixed-port proxy (7891) + per-instance listeners with session-based routing.

- `setup` writes hooks config to `~/.claude/settings.json` pointing to `http://127.0.0.1:7891/aight-hook`
- Each plugin instance starts its own listener on an auto-assigned port
- The first instance to grab port 7891 acts as a fan-out proxy
- The proxy routes events by `session_id` (included in every Claude Code hook payload)
- Each instance claims its session on first receipt, writes `session-<PID>.txt`
- After first tool call, routing is precise — no cross-session leaking

### MCP Tools
- **reply** — Send a message to the Aight app (supports markdown, file attachments)
- **react** — Send an emoji reaction to a message

## Message Protocol

See `src/protocol.ts` for the full typed protocol. Summary:

**App → Plugin:** `message`, `ping`, `request_skills`
**Plugin → App:** `reply`, `reaction`, `ack`, `typing`, `connected`, `tool_event`, `skills_list`
**Relay control:** `paired`, `partner_connected`, `partner_disconnected`, `waiting_for_pair`, `auth_required`, `pong`

Full protocol documentation: `docs/PROTOCOL.md`

## Security Model

| Layer | Mechanism |
|-------|-----------|
| **Token auth** | HMAC-SHA256 token sent as first WS message (not in URL) |
| **Pairing codes** | 6 chars from unambiguous charset, crypto-random, 5-min TTL |
| **File permissions** | 0o600 on pairing codes, hook ports, session files, and attachments |
| **Input validation** | Max message size (1MB), content length (50KB), attachment size (10MB) |
| **Rate limiting** | Max 30 messages/minute from app |
| **Inbox management** | 24h cleanup + 500MB total cap with oldest-first eviction |
| **Session isolation** | Hook events routed by session_id — no cross-session tool event leaking |

### Accepted Trust Boundaries
- Hook server on localhost — display-only data, session-isolated
- `readFileAsBase64` reads any path Claude provides — intentional (Claude controls tool args)

## Development

```bash
bun install
claude --dangerously-load-development-channels server:aight
bunx tsc --noEmit   # type-check
bun test            # run tests
```

## Local State

All state lives in `~/.claude/channels/aight/`:
- `pairing-code-<PID>.txt` — current session's 6-digit code
- `hook-port-<PID>.txt` — instance hook listener port
- `session-<PID>.txt` — claimed session_id for hook routing
- `inbox/` — saved attachments from phone (auto-cleaned after 24h)

Stale PID files are automatically cleaned on startup.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AIGHT_RELAY_URL` | Relay server URL | `https://channels.aight.cool` |

## Runtime

- **Runtime:** Bun
- **Language:** TypeScript (strict mode)
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **No other production dependencies**
