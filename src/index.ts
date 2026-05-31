// ── Public API ──────────────────────────────────────────────────
export { dynamodbAdapter } from "./adapter/factory";
export type { DynamoDBAdapterConfig, GsiDeclaration, KeySchemaOverride } from "./types";
export {
  DynamoAdapterError,
  UnsupportedOperatorError,
  UnsupportedOptionError,
  InvalidWhereError,
} from "./errors";
