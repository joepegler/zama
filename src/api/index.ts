import { db, publicClients } from "ponder:api";
import schema from "ponder:schema";
import { and, count, eq, min, ne, or, sql, sum } from "ponder";
import { createApi, type ApiSource } from "./app.js";
import { config } from "../config.js";
import type { Transfer } from "../indexer.js";

function total(value: string | null | undefined) {
  return value ? BigInt(value) : 0n;
}

type ProgressRow = {
  latest_checkpoint: string;
  value: { is_ready: number };
};

function isProgressRow(value: unknown): value is ProgressRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.latest_checkpoint !== "string") return false;
  if (typeof row.value !== "object" || row.value === null) return false;
  const meta = row.value as Record<string, unknown>;
  return typeof meta.is_ready === "number";
}

function getProgressRows(result: unknown): ProgressRow[] {
  if (Array.isArray(result)) return result.filter(isProgressRow);
  if (typeof result !== "object" || result === null) return [];
  const maybeRows = (result as { rows?: unknown }).rows;
  return Array.isArray(maybeRows) ? maybeRows.filter(isProgressRow) : [];
}

async function progress() {
  const result = await db.execute(
    sql`select c.latest_checkpoint, m.value
        from _ponder_meta m
        join _ponder_checkpoint c on c.chain_name = 'sepolia'
        where m.key = 'app' limit 1`
  );
  const [row] = getProgressRows(result);
  return {
    ready: row?.value.is_ready === 1,
    indexedBlock: row ? BigInt(row.latest_checkpoint.slice(26, 42)) : 0n
  };
}

const source: ApiSource = {
  async balance(address) {
    const involved = or(
      eq(schema.transferEvents.fromAddress, address),
      and(
        ne(schema.transferEvents.activityKind, "unshield"),
        eq(schema.transferEvents.toAddress, address)
      )
    );
    const [credits, debits, pending] = await Promise.all([
      db
        .select({ amount: sum(schema.transferEvents.cleartextAmount) })
        .from(schema.transferEvents)
        .where(
          and(
            eq(schema.transferEvents.decryptionState, "decrypted"),
            ne(schema.transferEvents.activityKind, "unshield"),
            eq(schema.transferEvents.toAddress, address)
          )
        ),
      db
        .select({ amount: sum(schema.transferEvents.cleartextAmount) })
        .from(schema.transferEvents)
        .where(
          and(
            eq(schema.transferEvents.decryptionState, "decrypted"),
            eq(schema.transferEvents.fromAddress, address)
          )
        ),
      db
        .select({ value: count() })
        .from(schema.transferEvents)
        .where(
          and(
            eq(schema.transferEvents.decryptionState, "pending_decryption"),
            involved
          )
        )
    ]);
    return {
      value: total(credits[0]?.amount) - total(debits[0]?.amount),
      pendingCount: Number(pending[0]?.value ?? 0)
    };
  },

  async transfers(address) {
    return (await db.query.transferEvents.findMany({
      where: (table, { eq, or }) =>
        or(eq(table.fromAddress, address), eq(table.toAddress, address)),
      orderBy: (table, { desc }) => [desc(table.blockNumber), desc(table.logIndex)],
      limit: 50
    })) as Transfer[];
  },

  async health() {
    const [indexer, pending] = await Promise.all([
      progress(),
      db
        .select({
          value: count(),
          oldestBlock: min(schema.transferEvents.blockNumber)
        })
        .from(schema.transferEvents)
        .where(eq(schema.transferEvents.decryptionState, "pending_decryption"))
    ]);
    let chainHeadBlock: bigint | null = null;
    try {
      chainHeadBlock = await publicClients.sepolia.getBlockNumber();
    } catch {
      // A missing chain head is reported as degraded by the health route.
    }
    return {
      ...indexer,
      chainHeadBlock,
      pendingCount: Number(pending[0]?.value ?? 0),
      oldestPendingBlock: pending[0]?.oldestBlock ?? null
    };
  }
};

export default createApi(source, {
  address: config.tokenAddress.toLowerCase() as `0x${string}`,
  decimals: 6
});
