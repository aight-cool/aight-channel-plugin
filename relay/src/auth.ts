/**
 * Auth — HMAC-based token generation and pairing code management
 *
 * Flow:
 * 1. Plugin calls POST /rooms → gets { roomId, pairingCode, pluginToken }
 * 2. Plugin connects to /ws/plugin/:roomId?token=pluginToken
 * 3. User enters pairingCode in app → POST /pair { code } → gets { roomId, appToken }
 * 4. App connects to /ws/app/:roomId?token=appToken
 *
 * Tokens are HMAC-SHA256(secret, "v1:<role>:<roomId>").
 * Pairing codes are 6 alphanumeric chars, stored in KV with 5-min TTL.
 */

const encoder = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function deriveToken(
  secret: string,
  role: "plugin" | "app",
  roomId: string,
): Promise<string> {
  return hmac(secret, `v1:${role}:${roomId}`);
}

export async function validateToken(
  secret: string,
  role: "plugin" | "app",
  roomId: string,
  token: string,
): Promise<boolean> {
  const expected = await deriveToken(secret, role, roomId);
  if (expected.length !== token.length) return false;
  const a = encoder.encode(expected);
  const b = encoder.encode(token);
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/** Generate a 6-char alphanumeric pairing code (uppercase, no ambiguous chars) */
export function generatePairingCode(): string {
  const chars = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const threshold = Math.floor(256 / chars.length) * chars.length;
  const code: string[] = [];
  const buf = new Uint8Array(12); // oversized to minimize getRandomValues calls
  let idx = buf.length; // force initial fill
  while (code.length < 6) {
    if (idx >= buf.length) {
      crypto.getRandomValues(buf);
      idx = 0;
    }
    const b = buf[idx++];
    if (b < threshold) {
      code.push(chars[b % chars.length]);
    }
  }
  return code.join("");
}
