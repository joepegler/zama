import { describe, expect, it, vi } from "vitest";
import {
  createApi,
  type ApiSource,
  type TokenMetadata
} from "../src/api/app.js";
import {
  indexConfidentialTransfer,
  indexUnwrapFinalized,
  indexUnwrapRequested,
  indexWrap,
  retryPendingForAddress,
  type Address,
  type Hex,
  type Store,
  type Transfer
} from "../src/indexer.js";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const CAROL = "0x3333333333333333333333333333333333333333";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TOKEN = {
  address: "0x7c5bf43b851c1dff1a4fee8db225b87f2c223639",
  decimals: 6
} satisfies TokenMetadata;

function hex(character: string): Hex {
  return `0x${character.repeat(64)}` as Hex;
}

class MemoryStore implements Store {
  rows = new Map<string, Transfer>();

  async find(id: string) {
    return this.rows.get(id) ?? null;
  }

  async findUnshieldBurn(txHash: Hex, encryptedValue: Hex) {
    return (
      [...this.rows.values()].find(
        (row) =>
          row.activityKind === "unshield" &&
          row.txHash === txHash &&
          row.encryptedValue === encryptedValue
      ) ?? null
    );
  }

  async findUnshieldRequest(requestId: Hex) {
    return (
      [...this.rows.values()].find((row) => row.unwrapRequestId === requestId) ?? null
    );
  }

  async save(transfer: Transfer) {
    this.rows.set(transfer.id, transfer);
  }

  async pending() {
    return [...this.rows.values()].filter(
      (row) => row.decryptionState === "pending_decryption"
    );
  }

  async pendingForAddress(address: Address) {
    return (await this.pending()).filter(
      (row) =>
        row.fromAddress === address ||
        (row.activityKind !== "unshield" && row.toAddress === address)
    );
  }
}

function confidentialTransfer(from: Address, to: Address, amount: Hex, block: bigint) {
  return {
    transaction: { hash: hex(block.toString(16).slice(-1)) },
    log: { logIndex: 0 },
    block: { number: block, timestamp: 1_800_000_000n },
    args: { from, to, amount }
  } as const;
}

function wrap(to: Address, amount: bigint, encryptedAmount: Hex, block: bigint) {
  return {
    transaction: { hash: hex(block.toString(16).slice(-1)) },
    log: { logIndex: 1 },
    block: { number: block, timestamp: 1_800_000_000n },
    args: { to, roundedAmount: amount, encryptedWrappedAmount: encryptedAmount }
  } as const;
}

function unwrapRequested(receiver: Address, requestId: Hex, amount: Hex, block: bigint) {
  return {
    transaction: { hash: hex(block.toString(16).slice(-1)) },
    log: { logIndex: 1 },
    block: { number: block, timestamp: 1_800_000_000n },
    args: { receiver, unwrapRequestId: requestId, amount }
  } as const;
}

function unwrapFinalized(
  receiver: Address,
  requestId: Hex,
  encryptedAmount: Hex,
  cleartextAmount: bigint,
  block: bigint
) {
  return {
    transaction: { hash: hex(block.toString(16).slice(-1)) },
    log: { logIndex: 0 },
    block: { number: block, timestamp: 1_800_000_000n },
    args: { receiver, unwrapRequestId: requestId, encryptedAmount, cleartextAmount }
  } as const;
}

function source(store: MemoryStore, block: bigint): ApiSource {
  return {
    async balance(address) {
      const rows = [...store.rows.values()].filter(
        (row) =>
          row.fromAddress === address ||
          (row.activityKind !== "unshield" && row.toAddress === address)
      );
      const decrypted = rows.filter(
        (row) => row.decryptionState === "decrypted" && row.cleartextAmount !== null
      );
      const credits = decrypted
        .filter(
          (row) => row.activityKind !== "unshield" && row.toAddress === address
        )
        .reduce((sum, row) => sum + row.cleartextAmount!, 0n);
      const debits = decrypted
        .filter((row) => row.fromAddress === address)
        .reduce((sum, row) => sum + row.cleartextAmount!, 0n);
      return {
        value: credits - debits,
        pendingCount: rows.filter((row) => row.decryptionState === "pending_decryption")
          .length
      };
    },
    async transfers(address) {
      return [...store.rows.values()]
        .filter((row) => row.fromAddress === address || row.toAddress === address)
        .sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : 1));
    },
    async health() {
      const pending = await store.pending();
      return {
        ready: true,
        indexedBlock: block,
        chainHeadBlock: block,
        pendingCount: pending.length,
        oldestPendingBlock: pending.reduce<bigint | null>(
          (oldest, row) =>
            oldest === null || row.blockNumber < oldest ? row.blockNumber : oldest,
          null
        )
      };
    }
  };
}

describe("confidential indexer", () => {
  it("indexes, decrypts, stores, and returns cleartext", async () => {
    const store = new MemoryStore();
    const decrypt = vi.fn(async () => 250n);

    await indexWrap(store, wrap(ALICE, 1_000n, hex("a"), 100n));
    const event = confidentialTransfer(ALICE, BOB, hex("b"), 101n);
    await indexConfidentialTransfer(store, event, decrypt);
    await indexConfidentialTransfer(store, event, decrypt);

    const app = createApi(source(store, 101n), TOKEN);
    const history = (await (await app.request(`/transfers/${ALICE}`)).json()) as {
      token: TokenMetadata;
      indexedThroughBlock: string;
      data: Array<{ type: string; amount: { state: string; value: string | null } }>;
    };
    const balance = (await (await app.request(`/balances/${ALICE}`)).json()) as {
      balance: { state: string; value: string | null };
    };
    const health = (await (await app.request("/api/health")).json()) as {
      status: string;
      behind: boolean;
      lagBlocks: string;
    };

    expect(decrypt).toHaveBeenCalledOnce();
    expect(store.rows.size).toBe(2);
    expect(history).toMatchObject({ token: TOKEN, indexedThroughBlock: "101" });
    expect(history.data).toMatchObject([
      {
        type: "confidential_transfer",
        amount: { state: "decrypted", value: "250" }
      },
      { type: "shield", amount: { state: "decrypted", value: "1000" } }
    ]);
    expect(balance.balance).toEqual({ state: "decrypted", value: "750" });
    expect(health).toMatchObject({ status: "ok", behind: false, lagBlocks: "0" });
  });

  it("keeps denied amounts pending, then backfills them after delegation", async () => {
    const store = new MemoryStore();
    let hasRights = false;
    const decrypt = async () => (hasRights ? 50n : null);

    await indexConfidentialTransfer(
      store,
      confidentialTransfer(ALICE, BOB, hex("c"), 200n),
      decrypt
    );

    const app = createApi(source(store, 200n), TOKEN);
    const pendingHistory = (await (await app.request(`/transfers/${BOB}`)).json()) as {
      data: Array<{ amount: { state: string; value: string | null } }>;
    };
    const pendingBalance = (await (await app.request(`/balances/${BOB}`)).json()) as {
      balance: { state: string; value: string | null };
    };
    const pendingHealth = (await (await app.request("/api/health")).json()) as {
      pendingDecryptionCount: number;
      oldestPendingBlock: string | null;
    };

    expect(pendingHistory.data[0]?.amount).toEqual({
      state: "pending_decryption",
      value: null
    });
    expect(pendingBalance.balance).toEqual({ state: "pending_decryption", value: null });
    expect(pendingHealth.pendingDecryptionCount).toBe(1);
    expect(pendingHealth.oldestPendingBlock).toBe("200");

    hasRights = true;
    await retryPendingForAddress(store, ALICE as Address, decrypt);

    const resolvedBalance = (await (await app.request(`/balances/${BOB}`)).json()) as {
      balance: { state: string; value: string | null };
    };
    const resolvedHealth = (await (await app.request("/api/health")).json()) as {
      pendingDecryptionCount: number;
    };
    expect(resolvedBalance.balance).toEqual({ state: "decrypted", value: "50" });
    expect(resolvedHealth.pendingDecryptionCount).toBe(0);
  });

  it("correlates an unshield burn to its receiver without crediting that receiver", async () => {
    const store = new MemoryStore();
    const decrypt = vi.fn(async () => 200n);
    const encryptedAmount = hex("d");
    const requestId = hex("e");

    await indexWrap(store, wrap(ALICE, 1_000n, hex("a"), 300n));
    await indexConfidentialTransfer(
      store,
      confidentialTransfer(ALICE, ZERO_ADDRESS, encryptedAmount, 301n),
      decrypt
    );
    const request = unwrapRequested(CAROL, requestId, encryptedAmount, 301n);
    await indexUnwrapRequested(store, request, decrypt);
    await indexUnwrapRequested(store, request, decrypt);
    const finalized = unwrapFinalized(CAROL, requestId, encryptedAmount, 200n, 302n);
    await indexUnwrapFinalized(store, finalized);
    await indexUnwrapFinalized(store, finalized);

    const unshields = [...store.rows.values()].filter(
      (row) => row.activityKind === "unshield"
    );
    expect(unshields).toHaveLength(1);
    expect(unshields[0]).toMatchObject({
      fromAddress: ALICE,
      toAddress: CAROL,
      unwrapRequestId: requestId,
      cleartextAmount: 200n
    });

    const app = createApi(source(store, 302n), TOKEN);
    const holderHistory = (await (await app.request(`/transfers/${ALICE}`)).json()) as {
      data: Array<{ type: string }>;
    };
    const receiverHistory = (await (await app.request(`/transfers/${CAROL}`)).json()) as {
      data: Array<{ type: string }>;
    };
    const holderBalance = (await (await app.request(`/balances/${ALICE}`)).json()) as {
      balance: { state: string; value: string | null };
    };
    const receiverBalance = (await (await app.request(`/balances/${CAROL}`)).json()) as {
      balance: { state: string; value: string | null };
    };

    expect(holderHistory.data.filter((row) => row.type === "unshield")).toHaveLength(1);
    expect(receiverHistory.data).toHaveLength(1);
    expect(holderBalance.balance).toEqual({ state: "decrypted", value: "800" });
    expect(receiverBalance.balance).toEqual({ state: "decrypted", value: "0" });
    expect(decrypt).toHaveBeenCalledOnce();
  });
});
