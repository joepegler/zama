# AGENTS.md

Engineering guidance for this repository. Optimise for clarity, maintainability, and
correctness over breadth of features.

---

## Simplicity

Choose the simplest design that satisfies the requirement and keeps future changes easy.

- Prefer minimal code paths and minimal moving parts.
- If two options are equally correct, pick the one you can explain in one paragraph.
- Compose existing libraries rather than building infrastructure from scratch.
- Introduce abstractions only when they remove genuine duplication, clarify a lifecycle,
  improve testing, or are required by a dependency.
- Delete code that no longer earns its place. Speculative helpers, defensive layers, and
  future-proofing often cost more than they save.
- When in doubt, merge modules rather than split them.

Before adding code, ask: can a library do this? Is there a simpler design? Should this
be documented instead of implemented?

---

## Architecture

Keep the system easy to trace end to end.

```
Source events
  → ingestion
  → processing
  → persistence
  → API
```

- Make data lifecycles explicit: what enters the system, how it changes state, and when
  it is considered complete.
- Model state with discriminated unions rather than nullable fields and implicit flags.
- Assign clear ownership: each module should have one obvious responsibility.
- Prefer composition over inheritance.
- Keep modules small. A reader should understand the full pipeline without navigating
  deep hierarchies.
- Avoid unnecessary queues, services, and orchestration layers until load demands them.
- Use strong typing. Avoid `any` and implicit coercion.

---

## API Design

Optimise for developer experience. APIs should feel conventional and predictable.

- Use familiar resource shapes and HTTP semantics.
- Hide internal protocol complexity behind stable, partner-facing contracts.
- Expose uncertainty explicitly. Incomplete or pending data should be visible in
  responses, not omitted or implied.
- Return actionable error messages. Never swallow failures.
- Surface degraded operation through health endpoints.
- Keep validation proportional: enforce required configuration, identity formats, and
  obvious misuse. Avoid exhaustive sanitisation of internal state.

---

## Data Integrity

Correctness beats convenience.

- Never silently discard information.
- Persist recoverable state even when downstream processing cannot finish yet.
- Represent incomplete records explicitly so they can be backfilled when conditions change.
- Favour append-and-update patterns over destructive rewrites when auditability matters.
- Treat "unknown" and "pending" as first-class states, not error conditions to hide.

---

## Testing

Prove important behaviour, not implementation detail.

- Favour meaningful end-to-end flows over exhaustive unit test coverage.
- Test business-critical paths: ingest → process → store → serve.
- Add negative tests that reflect real product risks, not trivial edge cases.
- Keep tests readable: setup, action, assertion.
- Do not spend time testing framework glue, constants, or one-line helpers.

One convincing integration test is worth more than dozens of shallow unit tests.

---

## Documentation

Record decisions as the system evolves.

- Document architectural choices: what was chosen, what was rejected, and why.
- Explain trade-offs and assumptions, especially around external dependencies.
- Describe work that was intentionally deferred rather than half-implementing it.
- Keep documentation close to the code it describes.
- Prefer short decision records over long design documents that drift from reality.

---

## Code Style

Write code for the next maintainer.

- Prefer readability over cleverness.
- Use small files and pure functions where they clarify intent.
- Avoid deep inheritance, interface-per-class patterns, and heavy dependency injection.
- Avoid wrapper functions around single library calls.
- Avoid generic frameworks unless they remove substantial work.
- Minimise configuration surface area.

---

## Dependencies

Stand on established tools.

- Prefer mature, well-documented libraries over custom implementations.
- Do not reinvent indexing, HTTP serving, persistence, or RPC plumbing.
- Verify third-party APIs against source code, official documentation, and examples.
- Treat dependency upgrades as behaviour changes: read changelogs and re-run critical flows.
- Pin versions deliberately. Understand what you import.

---

## Performance

Optimise for correctness first.

- Measure before optimising. Guessing at bottlenecks wastes time.
- Document scalability ideas instead of building speculative complexity.
- Defer distributed systems concerns—locking, sharding, caching layers—until simple
  designs demonstrably fail.
- Prefer straightforward synchronous flows until latency or throughput requires otherwise.

---

## AI Usage

Treat AI as a collaborator, not an authority.

Encouraged:

- generating boilerplate
- exploring design alternatives
- summarising documentation
- drafting tests and decision records

Required:

- verify generated APIs against real source and documentation
- critically review generated implementations before merging
- treat all generated code as a draft subject to human judgement

Never assume an API exists because a model suggested it. Confirm behaviour in the
dependency you are integrating with.

---

## Before shipping

- Can any code be deleted without losing behaviour?
- Are lifecycle states explicit in types and storage?
- Is incomplete data visible to API consumers?
- Does a new teammate understand the pipeline in one reading?
- Would this be better as a paragraph in a decision record than as code?

When uncertain, simplify.
