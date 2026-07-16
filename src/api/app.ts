import { Hono } from "hono";
import { isAddress } from "viem";
import type { Address, Transfer } from "../indexer.js";

type Health = {
  ready: boolean;
  indexedBlock: bigint;
  chainHeadBlock: bigint | null;
  pendingCount: number;
  oldestPendingBlock: bigint | null;
};

export type TokenMetadata = { address: Address; decimals: number };

export type ApiSource = {
  balance(address: Address): Promise<{ value: bigint; pendingCount: number }>;
  transfers(address: Address): Promise<Transfer[]>;
  health(): Promise<Health>;
};

function address(value: string): Address | null {
  return isAddress(value) ? (value.toLowerCase() as Address) : null;
}

function status(health: Health) {
  const lag =
    health.chainHeadBlock === null
      ? null
      : health.chainHeadBlock > health.indexedBlock
        ? health.chainHeadBlock - health.indexedBlock
        : 0n;
  return {
    lag,
    behind: !health.ready || lag === null || lag > 12n
  };
}

function amount(transfer: Transfer) {
  return transfer.decryptionState === "decrypted"
    ? { state: "decrypted" as const, value: transfer.cleartextAmount!.toString() }
    : { state: "pending_decryption" as const, value: null };
}

export function createApi(source: ApiSource, token: TokenMetadata) {
  const app = new Hono();

  app.get("/balances/:address", async (c) => {
    const account = address(c.req.param("address"));
    if (!account) return c.json({ error: "Invalid address" }, 400);
    const health = await source.health();
    if (status(health).behind) {
      return c.json({ error: "Indexer is still catching up" }, 503);
    }

    const balance = await source.balance(account);
    return c.json({
      address: account,
      token,
      indexedThroughBlock: health.indexedBlock.toString(),
      balance:
        balance.pendingCount > 0
          ? { state: "pending_decryption", value: null }
          : { state: "decrypted", value: balance.value.toString() },
      pendingTransfers: balance.pendingCount
    });
  });

  app.get("/transfers/:address", async (c) => {
    const account = address(c.req.param("address"));
    if (!account) return c.json({ error: "Invalid address" }, 400);
    const health = await source.health();
    if (status(health).behind) {
      return c.json({ error: "Indexer is still catching up" }, 503);
    }

    return c.json({
      token,
      indexedThroughBlock: health.indexedBlock.toString(),
      data: (await source.transfers(account)).map((transfer) => ({
        id: transfer.id,
        transactionHash: transfer.txHash,
        blockNumber: transfer.blockNumber.toString(),
        type: transfer.activityKind,
        from: transfer.fromAddress,
        to: transfer.toAddress,
        amount: amount(transfer)
      }))
    });
  });

  app.get("/api/health", async (c) => {
    const health = await source.health();
    const { lag, behind } = status(health);
    const oldestPendingAge =
      health.oldestPendingBlock === null
        ? null
        : health.indexedBlock > health.oldestPendingBlock
          ? health.indexedBlock - health.oldestPendingBlock
          : 0n;
    return c.json(
      {
        status: behind ? "degraded" : "ok",
        behind,
        indexedBlock: health.indexedBlock.toString(),
        chainHeadBlock: health.chainHeadBlock?.toString() ?? null,
        lagBlocks: lag?.toString() ?? null,
        pendingDecryptionCount: health.pendingCount,
        oldestPendingBlock: health.oldestPendingBlock?.toString() ?? null,
        oldestPendingAgeBlocks: oldestPendingAge?.toString() ?? null
      },
      behind ? 503 : 200
    );
  });

  return app;
}
