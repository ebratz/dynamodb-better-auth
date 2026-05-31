/**
 * DynamoDB adapter factory — per DESIGN.md §8.
 *
 * Wires all methods, client, transaction, and email-uniqueness
 * into a Better Auth adapter via createAdapterFactory.
 */

import { createAdapterFactory } from "better-auth/adapters";
import type { DynamoDBAdapterConfig } from "../types";
import { resolveDocClient, getTableName } from "./client";
import { createMethod } from "./methods/create";
import { findOneMethod } from "./methods/find-one";
import { findManyMethod } from "./methods/find-many";
import { countMethod } from "./methods/count";
import { updateMethod } from "./methods/update";
import { updateManyMethod } from "./methods/update-many";
import { deleteMethod } from "./methods/delete";
import { deleteManyMethod } from "./methods/delete-many";
import { consumeOneMethod } from "./methods/consume-one";
import { createTransactionWrapper } from "./transaction";

// Re-exports
export { resolveDocClient, getTableName };
export { createMethod } from "./methods/create";
export { findOneMethod } from "./methods/find-one";
export { findManyMethod } from "./methods/find-many";
export { countMethod } from "./methods/count";
export { updateMethod } from "./methods/update";
export { updateManyMethod } from "./methods/update-many";
export { deleteMethod } from "./methods/delete";
export { deleteManyMethod } from "./methods/delete-many";
export { consumeOneMethod } from "./methods/consume-one";

export function dynamodbAdapter(config: DynamoDBAdapterConfig) {
  const docClient = resolveDocClient(config.client);

  // ── Forgiving tables: unknown models use model name as table name ──
  // This allows test suites and plugin models to work without explicit
  // table config entries — the model name itself becomes the DynamoDB table.
  const tables = new Proxy(config.tables, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target];
      // Fallback: use model name as table name (integration tests + plugins)
      return prop;
    },
  }) as DynamoDBAdapterConfig["tables"];

  const forgivingConfig: DynamoDBAdapterConfig = { ...config, tables };

  // ── Build native adapter (non-transactional) ────────────────
  const nativeMethods = {
    create:      createMethod(docClient, forgivingConfig),
    findOne:     findOneMethod(docClient, forgivingConfig),
    findMany:    findManyMethod(docClient, forgivingConfig),
    count:       countMethod(docClient, forgivingConfig),
    update:      updateMethod(docClient, forgivingConfig),
    updateMany:  updateManyMethod(docClient, forgivingConfig),
    delete:      deleteMethod(docClient, forgivingConfig),
    deleteMany:  deleteManyMethod(docClient, forgivingConfig),
    consumeOne:  consumeOneMethod(docClient, forgivingConfig),
  };

  return createAdapterFactory({
    config: {
      adapterId: "dynamodb-adapter",
      adapterName: "DynamoDB Adapter",
      usePlural: forgivingConfig.usePlural ?? false,
      debugLogs: forgivingConfig.debugLogs ?? false,

      // Data type support
      supportsJSON: true,
      supportsDates: true,
      supportsBooleans: true,
      supportsArrays: true,
      supportsNumericIds: false,

      // DocumentClient's Date marshalling is version-dependent.
      // Explicitly convert Date → ISO string on input.
      customTransformInput: ({ data, fieldAttributes }: any) => {
        if (fieldAttributes.type === "date" && data instanceof Date) {
          return data.toISOString();
        }
        return data;
      },
      // On read, we get a string back. Reconstitute to Date in output.
      customTransformOutput: ({ data, fieldAttributes }: any) => {
        if (fieldAttributes.type === "date" && data !== null && data !== undefined) {
          return new Date(data);
        }
        return data;
      },

      // Transaction support (hybrid buffer pattern per DESIGN.md §6)
      transaction: (forgivingConfig.client
        ? createTransactionWrapper(nativeMethods, forgivingConfig, (model: string) =>
            getTableName(model, forgivingConfig)
          )
        : false) as any,
    },

    adapter: () => nativeMethods as any,
  });
}
