import { index, onchainEnum, onchainTable } from "ponder";

export const activityKind = onchainEnum("activity_kind", [
  "confidential_transfer",
  "shield",
  "unshield"
]);

export const decryptionState = onchainEnum("decryption_state", [
  "pending_decryption",
  "decrypted"
]);

export const transferEvents = onchainTable(
  "transfer_events",
  (p) => ({
    id: p.text().primaryKey(),
    txHash: p.hex().notNull(),
    logIndex: p.integer().notNull(),
    blockNumber: p.bigint().notNull(),
    activityKind: activityKind().notNull(),
    fromAddress: p.hex(),
    toAddress: p.hex(),
    encryptedValue: p.hex().notNull(),
    unwrapRequestId: p.hex(),
    cleartextAmount: p.bigint(),
    decryptionState: decryptionState().notNull()
  }),
  (table) => ({
    byFrom: index().on(table.fromAddress, table.blockNumber, table.logIndex),
    byTo: index().on(table.toAddress, table.blockNumber, table.logIndex),
    byState: index().on(table.decryptionState)
  })
);
