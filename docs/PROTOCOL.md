# WebSocket Protocol

Full specification of messages exchanged between the Aight app, relay, and plugin.

## App → Plugin (via relay)

### message
User sends a message from the app.
```json
{
  "type": "message",
  "id": "msg_123",
  "content": "hello",
  "sender": { "name": "Bruno", "device": "iPhone" },
  "attachments": [
    {
      "fileName": "photo.jpg",
      "mimeType": "image/jpeg",
      "content": "<base64>"
    }
  ]
}
```

### ping
App heartbeat. Plugin responds with `pong`.
```json
{ "type": "ping" }
```

### request_skills
App requests the list of available Claude Code skills for autocomplete.
```json
{ "type": "request_skills" }
```

## Plugin → App (via relay)

### reply
Claude's response to a user message.
```json
{
  "type": "reply",
  "id": "claude_1",
  "replyTo": "msg_123",
  "content": "Here's what I found...",
  "sender": { "id": "claude", "name": "Claude", "emoji": "🤖", "username": "claude" },
  "attachments": [
    { "fileName": "result.png", "mimeType": "image/png", "data": "<base64>" }
  ],
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

### reaction
Emoji reaction to a message.
```json
{
  "type": "reaction",
  "emoji": "👍",
  "messageId": "msg_123",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

### ack
Acknowledgement that a message was received.
```json
{
  "type": "ack",
  "messageId": "msg_123",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

### typing
Indicates Claude is processing.
```json
{
  "type": "typing",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

### connected
Sent after pairing or reconnection.
```json
{
  "type": "connected",
  "channelName": "aight",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

### tool_event
Forwarded Claude Code tool usage events.
```json
{
  "type": "tool_event",
  "event": "start",
  "tool": "Bash",
  "input": "npm test",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

Event values: `start`, `end`, `error`, `subagent_start`, `subagent_end`

### skills_list
Available Claude Code skills for app autocomplete.
```json
{
  "type": "skills_list",
  "skills": [
    { "name": "commit", "description": "Create a git commit", "source": "global" }
  ],
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

### pong
Response to app's `ping`.
```json
{
  "type": "pong",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

## Relay Control Messages

These are sent by the relay infrastructure, not the app.

### paired
Both plugin and app are connected and linked.
```json
{ "type": "paired" }
```

### partner_connected / partner_disconnected
Notifies when the other side connects or disconnects.
```json
{ "type": "partner_connected", "timestamp": "..." }
{ "type": "partner_disconnected", "timestamp": "..." }
```

### waiting_for_pair
Plugin is connected but no app has entered the pairing code yet.
```json
{ "type": "waiting_for_pair" }
```

### reconnected
Plugin reconnected to an existing session.
```json
{ "type": "reconnected", "partnerConnected": true }
```

## Pairing Flow

1. Plugin calls `POST /pair` on the relay → gets `{ code, sessionToken, sessionId }`
2. Plugin connects to `wss://channels.aight.cool/ws/plugin?id=<sessionId>`
3. Plugin sends `{ type: "auth", token: "<sessionToken>" }` as first message
4. Plugin displays the 6-digit code in the Claude Code terminal
5. User enters code in Aight app
6. App calls `POST /pair` with `{ code }` → gets its own session token
7. App connects to `wss://channels.aight.cool/ws/app?id=<sessionId>`
8. Relay sends `{ type: "paired" }` to both sides
9. Messages flow bidirectionally through the relay

## Limits

| Limit | Value |
|-------|-------|
| Max message size (WebSocket) | 1 MB |
| Max message content length | 50 KB |
| Max attachment size | 10 MB |
| Max outbound file size | 25 MB |
| Max attachments per message | 10 |
| Rate limit (inbound) | 30 msg/min |
| Pairing code TTL | 5 minutes |
| Inbox file retention | 24 hours |
| Inbox total size cap | 500 MB |
