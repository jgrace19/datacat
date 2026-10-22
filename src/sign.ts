import { createHmac } from "node:crypto";

/** HMAC-SHA256 of the exact request body, prefixed for header use. */
export function signBody(secret: string, body: string): string {
  const hex = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hex}`;
}
