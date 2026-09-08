# Safety, side effects, and data handling

Phone calls are real-world side effects. This document is the contract.

## Modes

| | dry-run (default) | live |
| --- | --- | --- |
| Provider | scripted fake, in process | official `@call-e/calle` SDK |
| Network | none | api.heycall-e.com |
| Requirements | none | `SHORTLINE_MODE=live`, `CALLE_API_KEY`, `SHORTLINE_LIVE_ACK=<exact phrase>` |
| Fixture numbers (555-01XX) | dialled by the fake | refused before any request leaves the process |
| `--force` / ignore calling hours | allowed | refused |
| Dashboard | open | requires `SHORTLINE_AUTH_TOKEN` |

`loadConfig` throws if live mode is requested without both the key and the acknowledgement phrase. There is no flag that removes the acknowledgement.

## Explicit intent

Calls are placed only by: `shortline sweep`, `shortline find --yes`, `shortline find-run`, the dashboard buttons **Run sweep now** and **Place calls**, and the MCP tool `shortline_run_find` with `confirm: true`. Planning commands and read tools never dial. The MCP tools carry `readOnlyHint` / `destructiveHint` annotations so an agent host can gate them.

## Who is called

Businesses only, on their published business line, during their local calling window (`window`, default 10:00–17:00 Monday–Saturday in the site's own IANA timezone). Timezones are stored per site and never inferred from the phone number, region, or locale (design principle 4 of the community repository). Individuals are out of scope: nothing in Shortline supports a consent record for calling a person, so it cannot call one correctly.

## What is said

Every task text opens with a disclosure that the caller is an automated assistant, names the project, and promises the call will be short. The assistant may ask about stock, limits, and restock timing, and (only with `askHold`) whether staff can hold one fill for pickup. It is instructed not to order, not to discuss any patient, not to ask prices, to end the call on a refusal, and to apologise and stop on a "don't call again". See `docs/call-design.md` for the exact text.

## Courtesy budget

- One ask per site per product per `cooldownDays` (14).
- One Shortline call per site for any reason per `globalMinGapDays` (5).
- A refusal rests the site for 90 days for that product.
- Two consecutive "not reached" outcomes mark the number wrong and remove it from every frame.
- A `do_not_call_request` opts the site out of everything, permanently, and is recorded in the audit table with the call id that triggered it.
- Sourcing requests never dial a site twice in the same request and skip anything called in the last 24 hours.

## No cancellation

The CALL-E Calls API has no client-side cancel. Shortline bounds exposure instead: a sweep dispatches in batches of at most `SHORTLINE_BATCH_SIZE` recipients (default 6) and a sourcing request dispatches one wave at a time, waiting for the wave to finish before deciding on the next. Stopping the process stops further dispatches. Any accepted batch completes on CALL-E's side and is reconciled on the next `sweep`, `reconcile`, or `serve`.

## Durability and ambiguity

Following the community production guide:

1. The dispatch row (sites, task text, schema version, idempotency key) is committed **before** the request is sent.
2. The idempotency key is derived from the business action (watch + week + site set, or find request + wave), never from an attempt.
3. A transport failure on create is recorded as `submission_unknown`. Shortline never creates a new key or a new dispatch to "retry"; `reconcilePending` replays the same key and body, and CALL-E returns the original call task if one was accepted.
4. Webhooks are acknowledged only after the event id is committed to the inbox. Identical redelivery is ignored; a different body under the same id is quarantined, never overwritten.
5. The webhook body is never trusted for a result. The reconciler fetches the call with the API key, checks the metadata binding (`dispatch_id`), and binds each recipient to a reserved site by exact phone match. Any mismatch stops in `needs_human` with the reason written down.
6. The task-level `pharmacies_reached` cross-check is compared with the recipient results; disagreement is flagged, recipient results win.

Tests in `test/workflow.test.ts` exercise the ambiguous-create replay and the binding mismatch.

## Data

- **Phone numbers** exist only in `sites.phone`. `maskDeep` runs on every API response, SSE event, MCP result, log line, and stored transcript.
- **Transcripts** are stored masked for `SHORTLINE_KEEP_TRANSCRIPTS_DAYS` (default 14; `0` disables storage) so evidence can be inspected; the poller purges older rows.
- **Audit** rows record state transitions with timestamps and notes, no phone numbers, no transcript text.
- **Credentials** are read from the environment. They are never written to the database, logs, or responses. `SHORTLINE_AUTH_TOKEN` protects the dashboard when serving in live mode.
- The SQLite file lives at `SHORTLINE_DB` (default `./data/shortline.sqlite`). Delete it to erase everything.

## Boundaries

Shortline asks pharmacies about stock of a named product. It:

- gives no medical, legal, or financial advice and does not mention patients, prescriptions, or diagnoses;
- does not order, reserve, pay, or agree to prices; a "hold" answer is recorded as a stated intention;
- is not an emergency service and must not be used to locate emergency medication for an acute situation — call emergency services or a poison control line;
- is a monitoring instrument. A reading is what a person said on the phone, attributed and time-stamped, nothing more.

## Threat notes

- **Prompt injection from callees.** Nothing said on a call is treated as an instruction. Structured results are validated against enums; free-text fields are stored, never executed, and masked.
- **Poisoned observations.** One caller cannot move the index far: strata are weighted, intervals are wide at small n, and the shortage signal fires on the upper bound.
- **Public dashboard.** Serving in live mode without `SHORTLINE_AUTH_TOKEN` is refused. The webhook route is intentionally unauthenticated (CALL-E does not sign deliveries) and can only *wake* a reconciliation that then reads through the authenticated API.
