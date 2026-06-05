/**
 * UUID generation for DynamoDB ClientRequestToken (idempotency).
 *
 * Uses Node crypto.randomUUID when available (Node ≥ 19),
 * falls back to an inline UUID v4 implementation for older runtimes.
 */

let _crypto: any;
export function generateToken(): string {
  if (!_crypto) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _crypto = require("crypto");
    } catch {
      _crypto = {
        randomUUID() {
          return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
            /[xy]/g,
            (c: string) => {
              const r = (Math.random() * 16) | 0;
              const v = c === "x" ? r : (r & 0x3) | 0x8;
              return v.toString(16);
            },
          );
        },
      };
    }
  }
  return _crypto.randomUUID();
}
