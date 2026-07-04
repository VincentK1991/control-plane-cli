import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { requireEnv } from "./env";

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function hashSessionToken(token: string) {
  return createHmac("sha256", requireEnv("SESSION_SECRET"))
    .update(token)
    .digest("hex");
}

export function hashApiKey(apiKey: string) {
  return createHash("sha256")
    .update(`${requireEnv("API_KEY_PEPPER")}:${apiKey}`)
    .digest("hex");
}

export function constantTimeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}
