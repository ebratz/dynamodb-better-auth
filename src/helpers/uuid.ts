import { randomUUID } from "node:crypto";

/** Cryptographically random idempotency token on supported Node runtimes. */
export function generateToken(): string {
  return randomUUID();
}
