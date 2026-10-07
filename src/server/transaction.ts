import type { Payload } from 'payload'
import { commitTransaction, initTransaction, killTransaction } from 'payload'

/** A Payload transaction id, shared by the Local API calls that must commit together. */
export type TransactionID = string | number

// Runs `work` inside one database transaction and commits it, or rolls everything back when
// `work` throws. The id is handed to each Local API call (`req: { transactionID }`), which
// is how Payload joins an operation to a transaction. Adapters without transaction support
// (SQLite without `transactionOptions`, MongoDB without a replica set) give no id: the calls
// then run one by one and nothing is rolled back.
export const inTransaction = async <T>(
  payload: Payload,
  work: (transactionID: TransactionID | undefined) => Promise<T>,
): Promise<T> => {
  const req = { payload }
  const started = await initTransaction(req)
  const transactionID = started
    ? (req as { transactionID?: TransactionID }).transactionID
    : undefined
  try {
    const result = await work(transactionID)
    if (started) await commitTransaction(req)
    return result
  } catch (error) {
    await killTransaction(req)
    throw error
  }
}
