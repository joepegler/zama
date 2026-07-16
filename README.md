# Confidential token indexer

Sepolia service that gives wallets an ERC-20-style view of one ERC-7984 wrapper. It
indexes confidential transfers and shield/unshield activity, decrypts with
`@zama-fhe/sdk`, and exposes balance, history, and health endpoints.

For architecture decisions, trade-offs, and production notes, see
[`DECISIONS.md`](DECISIONS.md).

```text
Sepolia events
  -> Ponder handler: persist row as pending_decryption
  -> Zama SDK: direct or delegated decrypt attempt
  -> Ponder database: update same row to decrypted (or leave pending)
  -> Hono API: cleartext balance, history, health
        ^
        ACL delegation + near-head block retries
```

## Setup

Requirements: Node.js 22+, npm 10+, and (to run the indexer) an archive-capable Sepolia
RPC URL.

### Environment

Copy the example file, then set `SEPOLIA_RPC_URL`. Everything else has working defaults
for the bundled Sepolia `cUSDCMock` contract.

```bash
cp .env.example .env
```

| Variable | Required for | Default | Purpose |
| --- | --- | --- | --- |
| `SEPOLIA_RPC_URL` | `dev`, smoke | — | Archive-capable Sepolia HTTPS RPC |
| `INDEXER_PRIVATE_KEY` | `dev`, smoke | toy `0x…01` | EOA the Zama SDK uses for decryption |
| `TOKEN_ADDRESS` | `dev`, smoke | `0x7c5B…3639` | ERC-7984 wrapper to index |
| `TOKEN_START_BLOCK` | `dev` | `10162159` | First block with wrapper code |
| `RELAYER_API_KEY` | — | empty | Zama relayer API-key auth, if needed |
| `ALICE_PK` | smoke only | toy `0x…02` | Funded Sepolia account for live demo |

`npm test` does not read `.env` (in-memory tests only). `npm run build` runs codegen and
does not start the indexer. `npm run dev` loads `.env` and needs at least
`SEPOLIA_RPC_URL` plus `INDEXER_PRIVATE_KEY`.

Use toy testnet keys only. Never commit a real `.env`.

### Run (copy-paste)

**Verify without chain access** — clone, install, run unit/integration tests:

```bash
npm ci
npm test
```

**Run the indexer** — after setting `SEPOLIA_RPC_URL` in `.env`:

```bash
npm ci
cp .env.example .env   # skip if you already have .env
# Edit .env: set SEPOLIA_RPC_URL=https://your-archive-sepolia-endpoint
npm run build
npm run dev
```

Ponder serves at `http://localhost:42069`.

First run may replay from `TOKEN_START_BLOCK` for several minutes. While catching up,
`/balances` and `/transfers` return `503`.

```bash
curl -s "http://localhost:42069/api/health" | jq .
```

Proceed when `behind` is `false` and `status` is `ok`.

## API

```bash
export ADDRESS=0x1111111111111111111111111111111111111111

curl "http://localhost:42069/balances/$ADDRESS"
curl "http://localhost:42069/transfers/$ADDRESS"
curl "http://localhost:42069/api/health"
```

Pending semantics: if any activity affecting an address is still pending decryption, the
balance is returned as pending (`{ "state": "pending_decryption", "value": null }`)
rather than a partial number.

### `GET /balances/:address` (`200`)

```json
{
  "address": "0x1111111111111111111111111111111111111111",
  "token": {
    "address": "0x7c5bf43b851c1dff1a4fee8db225b87f2c223639",
    "decimals": 6
  },
  "indexedThroughBlock": "9876543",
  "balance": { "state": "decrypted", "value": "4000000" },
  "pendingTransfers": 0
}
```

### `GET /transfers/:address` (`200`)

```json
{
  "token": {
    "address": "0x7c5bf43b851c1dff1a4fee8db225b87f2c223639",
    "decimals": 6
  },
  "indexedThroughBlock": "9876543",
  "data": [
    {
      "id": "0xabc...:12",
      "transactionHash": "0xabc...",
      "blockNumber": "9876540",
      "type": "confidential",
      "from": "0x1111...",
      "to": "0x2222...",
      "amount": { "state": "decrypted", "value": "1000000" }
    },
    {
      "id": "0xdef...:4",
      "transactionHash": "0xdef...",
      "blockNumber": "9876500",
      "type": "shield",
      "from": "0x0000...",
      "to": "0x1111...",
      "amount": { "state": "pending_decryption", "value": null }
    }
  ]
}
```

### `GET /api/health`

Ponder owns `/health`; this partner-facing endpoint is `/api/health`.

```json
{
  "status": "ok",
  "behind": false,
  "indexedBlock": "9876543",
  "chainHeadBlock": "9876545",
  "lagBlocks": "2",
  "pendingDecryptionCount": 0,
  "oldestPendingBlock": null,
  "oldestPendingAgeBlocks": null
}
```

Returns `200` when ready, `503` when degraded.

## Verify

```bash
npm test
```

### Optional live smoke (Sepolia)

Needs the indexer running plus funded toy `INDEXER_PRIVATE_KEY` and `ALICE_PK` in
`.env`.

Terminal 1:

```bash
npm run dev
# Wait until /api/health reports behind: false
```

Terminal 2:

```bash
npm run smoke:sepolia
```

On success, the script prints `Sepolia smoke demo passed.`.
