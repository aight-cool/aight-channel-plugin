# aight

Chat with your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) session from your phone — works from anywhere.

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

No port forwarding, no Tailscale, no LAN requirement. A 6-digit pairing code links your phone.

## Install — 30 seconds

**Prerequisites:** [Bun](https://bun.sh) and the [Aight iOS app](https://aight.cool)

```bash
git clone https://github.com/aight-cool/aight-channel-plugin ~/.claude/channels/aight \
  && ~/.claude/channels/aight/setup
```

Then start Claude Code with the channel:

```bash
aight-claude
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
```

The `server:aight` channel flag requires an MCP server named `aight` in the project's `.mcp.json`. The plugin ships one, but it only applies when you run Claude from the plugin directory itself. To launch from **any** project directory, add this function to your `~/.zshrc` or `~/.bashrc`:

```bash
# aight — Claude Code mobile channel
aight-claude() {
  local mcp=".mcp.json" had_mcp=false orig=""
  [ -f "$mcp" ] && { had_mcp=true; orig=$(cat "$mcp"); }
  _aight_restore() {
    if $had_mcp; then printf '%s' "$orig" > "$mcp"; else rm -f "$mcp"; fi
  }
  trap '_aight_restore; trap - INT TERM; kill -INT $$' INT TERM
  bun -e "
    const fs = require('fs');
    let c = {}; try { c = JSON.parse(fs.readFileSync('.mcp.json','utf8')); } catch {}
    c.mcpServers = c.mcpServers || {};
    c.mcpServers.aight = { command: 'bun', args: ['run','--cwd','\$HOME/.claude/channels/aight','--shell=bun','--silent','start'] };
    fs.writeFileSync('.mcp.json', JSON.stringify(c,null,2)+'\n');
  "
  claude --dangerously-load-development-channels server:aight "$@"
  local rc=$?
  _aight_restore
  trap - INT TERM
  return $rc
}
```

Then reload your shell and run `aight-claude`.

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
AIGHT_RELAY_URL=https://my-relay.example.com aight-claude
```

## Protocol

Full WebSocket protocol documentation: [docs/PROTOCOL.md](docs/PROTOCOL.md)

## License

Apache-2.0 — see [LICENSE](LICENSE)

---

Built by [aight.cool](https://aight.cool)
