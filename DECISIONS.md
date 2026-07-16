# Decisions

## Architecture

I chose Ponder because the brief asks for an indexer to be composed, not built from
scratch. It gives me ordered handlers, database writes, reorg rollback, and Hono hosting
in one process. Together with the Zama SDK and Ponder's local PGlite database, that keeps
the setup to Node and an RPC URL.

I considered a viem log poller with separate storage and HTTP processes, but most of the
extra work would have been cursor, replay, and coordination code. It would not have made
the event-to-API proof much stronger. What I wrote is limited to the lifecycle logic,
three read routes, and a thin Ponder adapter. `Store` and `ApiSource` are small testing
seams, not an attempt at pluggable architecture: they let the tests exercise real HTTP
handlers without booting a chain or mocking Ponder's virtual modules.

## Lifecycle and balances

Each wallet-visible activity gets one row, identified by
`transactionHash:logIndex`. I kept the lifecycle to two states:
`pending_decryption` and `decrypted`. The event is saved before decryption is attempted,
so missing rights or a temporary relayer failure cannot make it disappear. A successful
retry updates that same row.

Wrapper mints are represented by the cleartext `Wrap` event, so their paired
`ConfidentialTransfer` mint is ignored. Burns cannot be ignored: unwrap accepts distinct
`from` and `to` addresses, while `UnwrapRequested` exposes only the underlying receiver.
I keep the burn as the single unshield row, correlate the request by transaction hash
and encrypted handle, then attach its request ID and receiver. `UnwrapFinalized` finds
the row by request ID. This gives the wallet one history entry with the confidential
holder as `from` and the underlying receiver as `to`. If the burn is unavailable, I
retain the request with an unknown holder instead of guessing.

Unshield balance direction is activity-specific: the holder is debited, but the
underlying receiver is not credited with confidential tokens. This submission assumes
the configured Sepolia wrapper has six decimals and a 1:1 wrapper rate. Supporting an
arbitrary wrapper would require metadata discovery and unit conversion.

I considered storing balances, but deriving them from decrypted credits and debits is
simpler and avoids another piece of state that could drift during replay. The trade-off
is that if any row for an address is still pending, the API returns no balance. I think
that is preferable to showing a partial number that looks authoritative.

The indexer first tries direct SDK decryption, then delegated decryption using transfer
participants as candidate delegators. For unshields it tries only the confidential
holder. I checked these alpha calls against the installed package declarations and set
`waitForPropagation: false`; I would rather let the indexer retry than hold a Ponder
callback open.

Retries have two paths. As a safety net, `RetryTick` checks up to 25 of the oldest
pending rows every five blocks near chain head. An ACL
`DelegatedForUserDecryption` event for this indexer and token also retries that
delegator's rows immediately. This avoids a queue or second process, but it is deliberately
basic: a permanently denied oldest batch may be selected repeatedly. Backoff and fair
scheduling would be the first changes if that became a real load problem.

## Historical correctness

The example start block is `10162159`, verified as the first block with code for the
configured wrapper. I initially considered a recent start block to make first startup
faster, but that would silently produce incorrect derived balances. Token and ACL events
therefore replay from deployment. Only the periodic `RetryTick` source starts at recent
block `11280000`, and its handler runs near head, so historical token events are retained
without running pointless retries throughout the replay. Ponder owns checkpointing and
reorg rollback, including the updates that join burn and unwrap events.

## Partner API

- `GET /balances/:address`
- `GET /transfers/:address`
- `GET /api/health`

I kept the routes conventional; `/api/health` is the exception because Ponder reserves
`/health`. Health reports readiness, checkpoint lag, chain head, pending count, and the
age of the oldest pending row. Balance and history include token metadata and
`indexedThroughBlock`, which describes freshness rather than a snapshot shared across
requests. Amounts are base-unit strings.

Data routes return `503` while the initial index is behind, rather than presenting a
partial history as complete. History is capped at 50 rows for this exercise. The first
API feature I would add for production is a stable `(blockNumber, logIndex)` cursor.

The checkpoint comes from Ponder's internal metadata table because the public API does
not expose processed height. I accepted that visible coupling for this exercise, but
would replace it if Ponder exposes a supported progress API.

## Tests and negative case

The happy path follows an event through decryption and persistence to balance, history,
and health responses. For the negative path, the decryptor starts without rights. The
test proves that the pending event remains visible and the balance stays unavailable,
then grants rights and retries successfully. I chose this over malformed-input testing
because losing an event before a later ACL grant is the main product risk in the brief.

These tests use in-memory persistence, so they do not claim to prove Ponder or relayer
behaviour. A third test covers the easy-to-miss holder != receiver unshield case and
idempotent request/finalization replay. The Sepolia smoke script exercises the live SDK,
network, Ponder, and API path separately.

## Confidentiality boundary and revocation

This service is a privileged plaintext projection. A user who delegates decryption to
the indexer allows it to learn and persist matching amounts. In this demo, an
unauthenticated API can then return them. That is acceptable only within the take-home's
controlled setup. A production design needs an explicit trust model, authenticated
per-user reads, managed keys, encryption at rest, auditing, and a retention policy.

Revoking ACL rights prevents future successful decryptions; it cannot make the service
Changing them back to pending would misrepresent reality rather than restore
confidentiality.

## Load confidence and what was cut

I am least confident about synchronous SDK work inside the event and retry handlers.
Relayer latency, combined with many permanently pending rows, is where I expect Ponder
to lag first. I would test that with a fixed event corpus, injected relayer latency, and
different denied-rights rates, measuring checkpoint lag and time to drain after a
delegation.

I deliberately left out production retry scheduling, cursor pagination, authentication,
key custody, observability, encryption at rest, and live-network CI. Those are important,
but implementing shallow versions would have obscured the lifecycle this exercise is
meant to demonstrate. I also rely on Ponder for replay and reorg handling instead of
building a second system beside it.

With four more hours I would, in order:

1. Batch pending handles by delegator and persist their next retry time.
2. Add a Ponder-backed test for burn/request rollback and replay.
3. Measure the retry-load boundary and document an operational limit.

## SDK feedback

**Priority 1:** Add `timeout` and `signal` to `DelegatedDecryptOptions`, matching direct
`decryptValues`, and honour them across propagation waits, the initial batch, and
per-item fallback. An indexer could then enforce a deadline per job instead of relying
on a global relayer timeout or leaving an indexing callback open.

**Priority 2:** Make delegated batching aware of the protocol's 2,048 encrypted-bit
request budget: automatically chunk inputs, or expose the budget and a chunk planner.
Server workloads should not need to hardcode a safe handle count or fall back to slow
per-item calls when a batch is too large.

**Priority 3:** Let `delegatedBatchDecryptValues` accept an explicit delegator per input,
group compatible requests internally, and make its existing per-item result a strict
success/error union. The current single-delegator batch leaves a multi-user wallet
indexer to implement the grouping and error plumbing itself.

## AI assistance

I used AI to draft framework glue, compare data models, and challenge places where the
design was becoming speculative. I treated SDK calls as unverified drafts and checked
them against the installed alpha declarations. The smoke script is also compiled as part
of the normal TypeScript build so it cannot quietly drift.

One subtle AI-generated mistake was proposing “add delegated batch decryption” as SDK
feedback. The installed alpha already exposes `delegatedBatchDecryptValues`; the actual
gap for this integration is batching inputs owned by different delegators. I corrected
the proposal after inspecting the package declarations.
