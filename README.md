# aight

Chat with your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) session from your phone — works from anywhere.

```
Phone (Aight App)  ──WSS──►  Cloudflare Relay  ◄──WSS──  Plugin (your Mac)
                                    │
                              Plugin ──MCP/stdio──► Claude Code
```

No port forwarding, no Tailscale, no LAN requirement. A 6-digit pairing code links your phone.

## Install — 30 seconds

**Prerequisites:** [Bun](https://bun.sh) and the [Aight iOS app](https://aight.cool)

```bash
git clone https://github.com/aight-cool/aight-channel-plugin ~/.claude/channels/aight \
  && ~/.claude/channels/aight/setup
```

Then start Claude Code with the channel:

```bash
claude-aight
```

That's it. A 6-digit pairing code will appear — enter it in the Aight app.

<!-- Uncomment when accepted into the official plugin directory:
### Official plugin directory

```
/plugin install aight@claude-plugins-official
```
-->

<details>
<summary>Manual install (without setup script)</summary>

```bash
git clone https://github.com/aight-cool/aight-channel-plugin ~/.claude/channels/aight
cd ~/.claude/channels/aight
bun install
claude --dangerously-load-development-channels server:aight
```

</details>

## How it works

1. Plugin connects outbound to the relay at `channels.aight.cool`
2. A **6-digit pairing code** appears in your terminal
3. Enter the code in the Aight app — connected!
4. Messages flow bidirectionally through the relay

Claude gets your messages as channel notifications and responds using the `reply` tool. It can also send `react`ions and file attachments.

## Tools

| Tool | Description |
|------|-------------|
| `reply` | Send a message to the Aight app (supports markdown + file attachments) |
| `react` | Send an emoji reaction to a message |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AIGHT_RELAY_URL` | Custom relay server URL | `https://channels.aight.cool` |

## Self-hosted relay

Want to run your own relay? See [aight-channel-relay](https://github.com/aight-cool/aight-channel-relay).

```bash
AIGHT_RELAY_URL=https://my-relay.example.com claude-aight
```

## Protocol

Full WebSocket protocol documentation: [docs/PROTOCOL.md](docs/PROTOCOL.md)

## License

Apache-2.0 — see [LICENSE](LICENSE)

---

Built by [aight.cool](https://aight.cool)
