## Summary

Adds **Shortline** under `apps/typescript/shortline/` and the companion skill `skills/shortline-find/`.

Shortline treats a CALL-E call as a measurement. Every week it draws a fresh random subsample of pharmacies per region and per kind, asks each one whether it can dispense a named product today, turns the structured result into an observation only after evidence checks, and publishes a street-level availability index with a 95% interval per stratum and region. When someone needs the product now, sourcing waves reuse the surveillance data, dial candidates three at a time, and stop the moment the need is met. Every confirmation carries the pharmacy's own words.

Motivation: active US drug shortages reached 227 in Q2 2026 (ASHP / University of Utah). National lists are binary and national; pharmacies have no inventory API; the phone is the API. Hospital pharmacy teams spend on the order of 20 staff-hours a week on shortages, much of it phoning around.

## What it uses from CALL-E

- Official `@call-e/calle` 0.7 server SDK: batch call tasks with `recipients`, strict `recipient_result_schema` (enums with `unknown`, `evidence_quote`, `answered_by`, `reached_pharmacy`, `do_not_call_request`), task-level `result_schema` as a cross-check, `metadata` binding, `Idempotency-Key` derived from the business action.
- Terminal webhooks validated on `CALL-E-Event-Id`, committed to an inbox before acknowledgement, then reconciled through an authenticated `GET /v1/calls/{id}`; developer events streamed to the dashboard.
- Dispatch lifecycle from `docs/production-workflows.md`: reserved → accepted → terminal_unverified → terminal_verified, `submission_unknown` replayed under the same key, `needs_human` on any binding or evidence failure.

## Evidence gates (why a schema-valid result is not yet an observation)

An answer enters the estimator only if a person in the pharmacy answered, the assistant actually named the product in its own turns, an evidence quote exists, and that quote is attributable to the callee's turns. Voicemail, menus, refusals, wrong numbers, null results, and unattributed quotes are stored and shown with their reason and reported as nonresponse, never as "no". The dry-run scenarios include the failure cases on purpose so the gates are visible in every demo run.

## Type

- [x] New skill
- [x] New runnable app
- [ ] New workflow plugin
- [ ] New provider adapter
- [ ] New scheduler recipe
- [x] README awesome-list entry
- [x] Safety or documentation update
- [ ] Validation or tooling update

## Side effects

Calls are placed only in live mode (`SHORTLINE_MODE=live` + `CALLE_API_KEY` + `SHORTLINE_LIVE_ACK` set to an exact phrase) and only by `sweep`, `find --yes`, `find-run`, the dashboard's confirm buttons, or the MCP tool `shortline_run_find` with `confirm: true`. Every call discloses that it is automated. The Calls API cannot recall an accepted call, so exposure is bounded: sweeps dispatch in batches of at most 6 recipients and sourcing dispatches one wave at a time. No recurring jobs are created; recurrence is the host scheduler's job and every invocation is safe to repeat.

## Courtesy

One ask per site per product per cooldown (14 days), one Shortline call per site per 5 days for any reason, local calling windows in the site's own IANA timezone (never inferred), refusals rest a site for 90 days, two "not reached" outcomes drop a number, and "don't call again" opts a site out permanently with an audit row.

## Cancellation

Stopping the process stops further dispatches. Accepted batches complete on CALL-E's side and are reconciled on the next `sweep`, `reconcile`, or `serve`. Sourcing requests stop at the first wave that meets the need or at the wave cap.

## Credentials and data

`CALLE_API_KEY` is read from the environment and never written anywhere. Phone numbers live only in the `sites` table; every log line, API response, SSE event, MCP result, and stored transcript is masked. Transcripts are kept masked for a bounded period (default 14 days) so evidence can be inspected, then purged. Fixture numbers are in the NANP fiction block and live mode refuses to dial them.

## Verification

```bash
cd apps/typescript/shortline
npm install
npm test        # 63 tests: estimator, sampling, classification, waves, ledger, fake provider, SDK adapter against a fake HTTP server with webhook delivery, sweep/find workflows, crash-safety replay, binding mismatch, live-mode guards, webhook receiver
npm run demo    # dashboard with eight simulated weeks
```

`python3 scripts/validate_repository.py` passes.

## Checklist

- [x] Repository-facing content is written in English.
- [x] Branch name, commit messages, and PR title follow `docs/git-naming-conventions.md`.
- [x] No secrets, tokens, private phone numbers, call recordings, or private transcripts are included.
- [x] Real-world side effects are clearly described.
- [x] Phone numbers are masked in documentation and test fixtures unless they are clearly fictional.
- [x] Recurring workflows include cancellation behavior.
- [x] Runnable code has a dry-run, fake-server, or no-call path by default.
- [x] `python3 scripts/validate_repository.py` passes.

Source of truth and hosted dry-run demo: https://github.com/rikhinkavuru/shortline
