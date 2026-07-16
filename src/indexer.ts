export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export type Transfer = {
  id: string;
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  activityKind: "confidential_transfer" | "shield" | "unshield";
  fromAddress: Address | null;
  toAddress: Address | null;
  encryptedValue: Hex;
  unwrapRequestId: Hex | null;
  cleartextAmount: bigint | null;
  decryptionState: "pending_decryption" | "decrypted";
};

export type Store = {
  find(id: string): Promise<Transfer | null>;
  findUnshieldBurn(txHash: Hex, encryptedValue: Hex): Promise<Transfer | null>;
  findUnshieldRequest(requestId: Hex): Promise<Transfer | null>;
  save(transfer: Transfer): Promise<void>;
  pending(): Promise<Transfer[]>;
  pendingForAddress(address: Address): Promise<Transfer[]>;
};

export type Decrypt = (transfer: Transfer) => Promise<bigint | null>;

type Event = {
  transaction: { hash: Hex };
  log: { logIndex: number };
  block: { number: bigint; timestamp: bigint };
};

export type ConfidentialTransferEvent = Event & {
  args: { from: Address; to: Address; amount: Hex };
};

export type WrapEvent = Event & {
  args: { to: Address; roundedAmount: bigint; encryptedWrappedAmount: Hex };
};

export type UnwrapRequestedEvent = Event & {
  args: { receiver: Address; unwrapRequestId: Hex; amount: Hex };
};

export type UnwrapFinalizedEvent = Event & {
  args: {
    receiver: Address;
    unwrapRequestId: Hex;
    encryptedAmount: Hex;
    cleartextAmount: bigint;
  };
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function transfer(
  event: Event,
  fields: Pick<
    Transfer,
    "activityKind" | "fromAddress" | "toAddress" | "encryptedValue"
  >,
  id = `${event.transaction.hash}:${event.log.logIndex}`
): Transfer {
  return {
    id,
    txHash: event.transaction.hash,
    logIndex: event.log.logIndex,
    blockNumber: event.block.number,
    ...fields,
    unwrapRequestId: null,
    cleartextAmount: null,
    decryptionState: "pending_decryption"
  };
}

async function attempt(store: Store, row: Transfer, decrypt: Decrypt) {
  const amount = await decrypt(row);
  if (amount !== null) {
    await store.save({
      ...row,
      cleartextAmount: amount,
      decryptionState: "decrypted"
    });
  }
}

async function insertAndDecrypt(store: Store, row: Transfer, decrypt: Decrypt) {
  if (await store.find(row.id)) return;
  await store.save(row);
  await attempt(store, row, decrypt);
}

export async function indexConfidentialTransfer(
  store: Store,
  event: ConfidentialTransferEvent,
  decrypt: Decrypt
) {
  if (event.args.from === ZERO_ADDRESS) return;

  const isUnshieldBurn = event.args.to === ZERO_ADDRESS;

  await insertAndDecrypt(
    store,
    transfer(event, {
      activityKind: isUnshieldBurn ? "unshield" : "confidential_transfer",
      fromAddress: event.args.from.toLowerCase() as Address,
      toAddress: isUnshieldBurn ? null : (event.args.to.toLowerCase() as Address),
      encryptedValue: event.args.amount
    }),
    decrypt
  );
}

export async function indexWrap(store: Store, event: WrapEvent) {
  const row = transfer(event, {
    activityKind: "shield",
    fromAddress: null,
    toAddress: event.args.to.toLowerCase() as Address,
    encryptedValue: event.args.encryptedWrappedAmount
  });
  if (await store.find(row.id)) return;
  await store.save({
    ...row,
    cleartextAmount: event.args.roundedAmount,
    decryptionState: "decrypted"
  });
}

export async function indexUnwrapRequested(
  store: Store,
  event: UnwrapRequestedEvent,
  decrypt: Decrypt
) {
  if (await store.findUnshieldRequest(event.args.unwrapRequestId)) return;

  const burn = await store.findUnshieldBurn(event.transaction.hash, event.args.amount);
  if (burn) {
    await store.save({
      ...burn,
      toAddress: event.args.receiver.toLowerCase() as Address,
      unwrapRequestId: event.args.unwrapRequestId
    });
    return;
  }

  await insertAndDecrypt(
    store,
    {
      ...transfer(
        event,
        {
          activityKind: "unshield",
          fromAddress: null,
          toAddress: event.args.receiver.toLowerCase() as Address,
          encryptedValue: event.args.amount
        },
        event.args.unwrapRequestId
      ),
      unwrapRequestId: event.args.unwrapRequestId
    },
    decrypt
  );
}

export async function indexUnwrapFinalized(
  store: Store,
  event: UnwrapFinalizedEvent
) {
  const existing = await store.findUnshieldRequest(event.args.unwrapRequestId);
  const row =
    existing ??
    {
      ...transfer(
        event,
        {
          activityKind: "unshield",
          fromAddress: null,
          toAddress: event.args.receiver.toLowerCase() as Address,
          encryptedValue: event.args.encryptedAmount
        },
        event.args.unwrapRequestId
      ),
      unwrapRequestId: event.args.unwrapRequestId
    };
  await store.save({
    ...row,
    cleartextAmount: event.args.cleartextAmount,
    decryptionState: "decrypted"
  });
}

export async function retryPending(
  store: Store,
  decrypt: Decrypt
) {
  for (const row of await store.pending()) await attempt(store, row, decrypt);
}

export async function retryPendingForAddress(
  store: Store,
  address: Address,
  decrypt: Decrypt
) {
  for (const row of await store.pendingForAddress(address)) await attempt(store, row, decrypt);
}
