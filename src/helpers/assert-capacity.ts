/**
 * Shared transaction capacity guard.
 *
 * Throws before the writeBuffer exceeds DDB's 100-action TransactWriteItems limit.
 * Used by all buffered tx method handlers to avoid repeating the same guard inline.
 */

import { DynamoAdapterError } from "../errors";

export function assertTransactionCapacity(
  writeBuffer: any[],
  extra: number,
  max = 100,
): void {
  if (writeBuffer.length + extra > max) {
    throw new DynamoAdapterError(
      "TRANSACTION_FAILED",
      "Cannot buffer more than 100 actions in a single transaction",
    );
  }
}
