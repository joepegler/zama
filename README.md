# Confidential token indexer

A small Sepolia service that gives wallets an ERC-20-style view of one ERC-7984
wrapper. It indexes confidential transfers and shield/unshield activity, decrypts with
`@zama-fhe/sdk`, retains unresolved amounts, and exposes balance, history, and health
endpoints.

```text
Sepolia -> Ponder -> Zama SDK -> Ponder database -> Hono API
```

Ponder supplies event ordering, persistence, reorg rollback, and API hosting. The code
adds only the confidential lifecycle: save an event as pending, attempt direct or
delegated decryption, update the same row, and retry pending rows near chain head.

## Setup

Requires Node.js 22+, npm 10+, and an archive-capable Sepolia RPC.

```bash
npm ci
cp .env.example .env
npm run build
npm test
npm run dev
```

Ponder serves at `http://localhost:42069`.

Service configuration:

- `INDEXER_PRIVATE_KEY`: toy EOA used to sign direct/delegated decrypt requests.
- `SEPOLIA_RPC_URL`: archive-capable Sepolia endpoint.
- `TOKEN_ADDRESS`: the single ERC-7984 wrapper.
- `TOKEN_START_BLOCK`: wrapper deployment block; balances are incomplete if this is
  wrong.
- `RELAYER_API_KEY`: optional Zama relayer key.

Use toy testnet keys only; never commit a funded or production key.

## API

```bash
export ADDRESS=0x1111111111111111111111111111111111111111

curl "http://localhost:42069/balances/$ADDRESS"
curl "http://localhost:42069/transfers/$ADDRESS"
curl "http://localhost:42069/api/health"
```

Amounts are explicit about uncertainty:

```json
{ "state": "decrypted", "value": "250" }
```

```json
{ "state": "pending_decryption", "value": null }
```

If any activity affecting an address is pending, its balance is also pending rather
than a misleading partial total. History returns the latest 50 activities. Ponder owns
its built-in `/health`, so `/api/health` is the partner endpoint containing service
status, indexed block, chain head, lag, and pending count.

## Proof

```bash
npm test
```

Two focused tests prove:

1. shield + confidential event -> decryption -> stored cleartext -> balance/history API;
2. denied event -> visible pending amount -> later retry -> backfilled cleartext.

They run the lifecycle and HTTP contract in memory. For the live SDK/Ponder path, start
the service with funded toy Sepolia keys and run:

```bash
npm run smoke:sepolia
```

The smoke script mints test USDCMock, shields it, grants the indexer delegation, sends a
confidential transfer, and checks exact sender and recipient API balances.

## Deliberate limits

Decryption runs inside Ponder, retries are a small block-triggered pass, and delegated
rights are probed from transfer participants. There is no authentication, queue,
multi-tenancy, production key management, or observability stack. These are design
notes in `DECISIONS.md`, not partial infrastructure in this exercise.
