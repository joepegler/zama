import { ponder } from "ponder:registry";
import schema from "ponder:schema";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";
import { decryptAmount } from "./decryption.js";
import {
  indexConfidentialTransfer,
  indexUnwrapFinalized,
  indexUnwrapRequested,
  indexWrap,
  retryPending,
  retryPendingForAddress,
  type ConfidentialTransferEvent,
  type Store,
  type Transfer,
  type Address,
  type UnwrapFinalizedEvent,
  type UnwrapRequestedEvent,
  type WrapEvent
} from "./indexer.js";

type Handler = Parameters<typeof ponder.on>[1];
type Context = Parameters<Handler>[0]["context"];
type DelegatedForUserDecryptionEvent = {
  args: { delegator: Address; delegate: Address; contractAddress: Address };
};

const indexerAddress = privateKeyToAccount(config.privateKey).address.toLowerCase() as Address;
const tokenAddress = config.tokenAddress.toLowerCase() as Address;
const PERIODIC_RETRY_BATCH_SIZE = 25;

function store(context: Context): Store {
  return {
    async find(id) {
      return (await context.db.find(schema.transferEvents, { id })) as Transfer | null;
    },
    async findUnshieldBurn(txHash, encryptedValue) {
      const row = await context.db.sql.query.transferEvents.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.activityKind, "unshield"),
            eq(table.txHash, txHash),
            eq(table.encryptedValue, encryptedValue)
          )
      });
      return (row as Transfer | undefined) ?? null;
    },
    async findUnshieldRequest(requestId) {
      const row = await context.db.sql.query.transferEvents.findFirst({
        where: (table, { eq }) => eq(table.unwrapRequestId, requestId)
      });
      return (row as Transfer | undefined) ?? null;
    },
    async save(transfer) {
      const { id: _, ...values } = transfer;
      await context.db
        .insert(schema.transferEvents)
        .values(transfer)
        .onConflictDoUpdate(values);
    },
    async pending() {
      return (await context.db.sql.query.transferEvents.findMany({
        where: (table, { eq }) => eq(table.decryptionState, "pending_decryption"),
        orderBy: (table, { asc }) => [asc(table.blockNumber), asc(table.logIndex)],
        limit: PERIODIC_RETRY_BATCH_SIZE
      })) as Transfer[];
    },
    async pendingForAddress(address) {
      return (await context.db.sql.query.transferEvents.findMany({
        where: (table, { and, eq, ne, or }) =>
          and(
            eq(table.decryptionState, "pending_decryption"),
            or(
              eq(table.fromAddress, address),
              and(
                ne(table.activityKind, "unshield"),
                eq(table.toAddress, address)
              )
            )
          )
      })) as Transfer[];
    }
  };
}

ponder.on("ConfidentialWrapper:ConfidentialTransfer", async ({ event, context }) => {
  await indexConfidentialTransfer(
    store(context),
    event as ConfidentialTransferEvent,
    decryptAmount
  );
});

ponder.on("ConfidentialWrapper:Wrap", async ({ event, context }) => {
  await indexWrap(store(context), event as WrapEvent);
});

ponder.on("ConfidentialWrapper:UnwrapRequested", async ({ event, context }) => {
  await indexUnwrapRequested(store(context), event as UnwrapRequestedEvent, decryptAmount);
});

ponder.on("ConfidentialWrapper:UnwrapFinalized", async ({ event, context }) => {
  await indexUnwrapFinalized(store(context), event as UnwrapFinalizedEvent);
});

ponder.on("Acl:DelegatedForUserDecryption", async ({ event, context }) => {
  const delegation = event as DelegatedForUserDecryptionEvent;
  if (delegation.args.contractAddress.toLowerCase() !== tokenAddress) return;
  if (delegation.args.delegate.toLowerCase() !== indexerAddress) return;
  await retryPendingForAddress(
    store(context),
    delegation.args.delegator.toLowerCase() as Address,
    decryptAmount
  );
});

ponder.on("RetryTick:block", async ({ event, context }) => {
  // Ponder replays block events during sync; only retry once it reaches the head.
  if (BigInt(Math.floor(Date.now() / 1_000)) - event.block.timestamp < 60n) {
    await retryPending(store(context), decryptAmount);
  }
});
