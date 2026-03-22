# Deploy Channel Relay

## Prerequisites
```bash
cd relay
npm install
npx wrangler login
```

## First-time setup

### 1. Create KV namespace
```bash
npx wrangler kv namespace create PAIRING_CODES
```

Copy the `id` from the output and update `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "PAIRING_CODES"
id = "<paste-id-here>"
```

### 2. Set the auth secret
```bash
npx wrangler secret put RELAY_AUTH_SECRET
# Enter a strong random string (e.g. openssl rand -hex 32)
```

### 3. Deploy
```bash
npx wrangler deploy
```

### 4. Add custom domain (optional)
In Cloudflare dashboard: Workers & Pages → channel-relay → Settings → Triggers → Add Custom Domain → `channels.aight.cool`

## Testing

```bash
# Health check
curl https://channel-relay.<your-subdomain>.workers.dev/health

# Create a room
curl -X POST https://channel-relay.<your-subdomain>.workers.dev/rooms

# Pair (from app)
curl -X POST https://channel-relay.<your-subdomain>.workers.dev/pair \
  -H "Content-Type: application/json" \
  -d '{"code":"ABC123"}'
```

## Plugin usage

Set the relay URL when starting the plugin:
```bash
AIGHT_RELAY_URL=https://channels.aight.cool bun run src/index.ts
```
