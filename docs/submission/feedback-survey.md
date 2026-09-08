# Notes for the CALL-E feedback survey

Concrete, reproducible items found while building Shortline against SDK 0.7.0 and the public docs, ordered by how much each one would help an integrator.

## Bugs and inconsistencies

1. **Deadline text disagrees with itself.** The Devpost landing page says the submission deadline is 11:45 pm SGT on September 14, the Official Rules say the Submission Period ends 11:45 **am** SGT on September 14. Entrants planning around the later time could miss it.
2. **API key prefix differs between docs.** `call-e-integrations` README shows `export CALLE_API_KEY="calle_live_key"`; docs.heycall-e.com/authentication says production keys use the `iams_live_` prefix. One of them is stale.
3. **SDK transcript `offset_seconds` is typed nullable** (`number | null` in the generated schema) but the Calls guide describes it as a number. Integrators building timelines need to know when it can be null.
4. **`recipients[].region` / `locale` are absent from the terminal webhook example** in the SDK types (`region: null, locale: null` in practice?) while the webhook guide shows them populated. Clarify whether they echo the request.
5. **Docs site markdown pages are reachable directly** (`/quickstart.md`, `/goal-runs.md`) but `/api-reference.md` is not; `/api-reference/calls` is only rendered client-side. A machine-readable OpenAPI file at a stable URL would let integrators generate clients (the TypeScript SDK repo has one under `openapi/`, but it is not linked from the docs).

## Missing capabilities that shaped the design

6. **No per-recipient confidence in batch call tasks.** `completion_confidence` is task-level. With six recipients on one task it cannot gate an individual answer. Shortline had to build transcript-based evidence checks instead. A per-recipient confidence, or an `answered_by` disposition, would remove a whole layer of heuristics.
7. **Webhooks are unsigned.** The docs are admirably clear about it, and the recommended pattern (treat as wake-up, re-read via API) works, but it doubles the API reads for every terminal event. An HMAC signature header would let receivers trust the body.
8. **No client-side cancel for an in-flight call task.** Everything that bounds exposure has to be structural (small batches, one wave at a time). Even a "cancel recipients not yet dialled" would help batch integrators.
9. **No lookup by idempotency key.** Recovery after an ambiguous create requires replaying the POST with the identical body. A `GET /v1/calls?idempotency_key=` would make reconciliation a read instead of a write.
10. **No per-recipient variables on Calls API batch tasks.** A sweep that asks each pharmacy about a different product must be split into one task per product. Goal Runs have per-run variables but are one phone per run.
11. **Calls API `failure_code` has no published enum**, so "no answer" versus "declined" cannot be distinguished at the call-task level; the Goal Runs API has these codes. Aligning them would let batch integrators report nonresponse categories.

## Documentation suggestions

12. A worked batch example that shows one recipient failing and one succeeding, including the resulting `structured_result: null` on the task level, would save integrators from assuming a task-level result exists whenever the call completed.
13. The "reserved recipient response field names" list (`summary`, `status`, `transcript`, `call_id`, timing fields) is only in the Calls guide prose; putting it in the API reference next to `recipient_result_schema` would prevent silent nulls.
14. State plainly in the Calls guide that keypad IVR navigation is supported and how to instruct it in task text; today it is only in the August 15 changelog.

## What worked well

- Idempotency semantics (same key + same body → same task, 201 on replay) made crash-safe dispatch straightforward.
- `evidence` and `completion_confidence` alongside `structured_result` are the right primitives for treating a call as a measurement.
- Strict object schemas with enums and `unknown` produce clean, gateable results.
