# Notes for the CALL-E feedback survey

Concrete, reproducible items found while building Shortline against SDK 0.7.0 and the public docs, ordered by how much each one would help an integrator. Every item ends with the source it was re-checked against on 2026-09-08. Docs line numbers refer to the markdown served at `https://docs.heycall-e.com/<page>.md`; repo citations are `repo@commit path:line`.

## Bugs and inconsistencies

1. **The legacy API key prefix is undocumented.** The docs and the integrations README agree today: `authentication.md` line 8 says production keys use the `iams_live_` prefix, and the `call-e-integrations` README shows `export CALLE_API_KEY="iams_live_example"` at lines 199 and 261. The inconsistency is between the changelog and the community catalog. The August 11 changelog entry says Developer API authentication "now accepts the `iams_live_` API keys shown in the CALL-E dashboard" without naming the prefix it replaced, while merged entries in `awesome-phone-call-agents` still ship `calle_live_` keys: `apps/python/kept/.env.example:2`, `apps/python/kept/README.md:271`, `apps/python/kept/DEMO.md:163`, `apps/python/mobilize/.env.example:1`, `apps/typescript/ai-front-desk/.env.example:3`, `apps/typescript/connected/README.md:69`, `apps/typescript/linecanary/README.md:34`, `apps/typescript/openings/.env.example:18`, `apps/typescript/ringer/src/components/shell/SettingsModal.tsx:90`, `skills/ringer-consumer-tasks/SKILL.md:117` and `:121`, `plugins/zapier-calle/test/redact.test.js:77`, `plugins/zapier-calle/test/authentication.test.js:51-57`. One entry redacts both prefixes as secrets (`apps/python/metapelet-checkin/safety_text.py:26`) and another validates keys as `iams_live_` or `iams_test_` (`apps/python/redline/redline/doctor.py:259`; `apps/python/refcheck-ai/tests/conftest.py:9` uses the same test prefix), a prefix that appears nowhere in the docs even though `authentication.md` line 64 tells readers to keep test and production keys separate. Two questions: do `calle_live_` keys still authenticate, and if so until when? Please document the legacy prefix (and `iams_test_`, if it exists) on the Authentication page so catalog entries can be migrated deliberately.
   Verified against: changelog.md lines 67-71; authentication.md lines 8 and 64; call-e-integrations@7768c20 README.md:199,261 (`grep -rn calle_live_` finds nothing in that repo); awesome-phone-call-agents@eb0e526 (`grep -rn calle_live_` and `grep -rn iams_test`).

2. **Transcript `offset_seconds` can be `null`, but only the OpenAPI says so.** The generated type is `offset_seconds: number | null`, and the spec documents the case: "`null` when the source line did not include a parseable timestamp." The Calls guide (line 445) and the Webhooks guide (line 26) list the turn fields without mentioning `null`, and every example shows an integer. Integrators who build timelines from the guides will not handle it. One sentence in each guide would close the gap.
   Verified against: server-sdk-typescript@36ee6f1 src/generated/schema.ts:456-457 and openapi/calle.openapi.yaml:1261-1265 (integer examples at 140-143, 220-223, 694-697); calls.md line 445; webhooks.md line 26 (integer examples at lines 64 and 69).

3. **Unclear whether `recipients[].region` and `locale` are echoed or inferred.** Both are optional on the request and nullable "when available" on the response; the spec says `region` is used for routing and compliance checks and `locale` is a BCP 47 hint for the conversation. The Calls guide examples (lines 96-99 and 130-133) and the OpenAPI `batchLunch` request omit them, yet the Webhooks guide payload (lines 47-48 and 83-84) and the OpenAPI `201` example show `"region": "US", "locale": "en-US"` on every recipient. State whether omitted values come back `null` or are inferred from the E.164 number.
   Verified against: server-sdk-typescript@36ee6f1 src/generated/schema.ts:421-428 (request) and 491-499 (response); openapi/calle.openapi.yaml:28-36 (`batchLunch` request), 108-127 (`201` example), 1193-1202, 1355-1364; calls.md lines 96-99, 130-133; webhooks.md lines 47-48, 83-84.

4. **Two copies of the 0.7.0 OpenAPI contract have drifted.** Machine-readable docs are in good shape: every guide is reachable as `.md`, `/llms.txt` indexes them, and `/openapi/calle.openapi.yaml` is served at a stable URL and linked from the docs index. The copy in the SDK repo, which `pnpm generate` turns into `src/generated/schema.ts`, differs from the served one in five description strings while both carry `info.version: 0.7.0`. The served spec marks `failure_code` on attempts and on the task as "No published enum" with a link to the errors guide, and tells readers to match `provider_call_id` to Dashboard Call Records; the SDK copy and the resulting JSDoc still say "Machine-readable failure reason". The repo's `verify:openapi` script checks operations, schema refs, and status codes only, so it cannot catch this. Sync the repo copy so SDK users see the same warnings in their editor.
   Verified against: `curl -s https://docs.heycall-e.com/openapi/calle.openapi.yaml` (200, application/yaml, 64911 bytes) diffed against server-sdk-typescript@36ee6f1 openapi/calle.openapi.yaml (only repo lines 816, 1323, 1328, 1409, 1463 differ; line 4 is `version: 0.7.0` in both); schema.ts:487 and :550; package.json:34 and :40; scripts/verify-openapi-contract.mjs:32-45; https://docs.heycall-e.com/llms.txt; https://docs.heycall-e.com/ ("Download OpenAPI" link).

## Missing capabilities that shaped the design

5. **No per-recipient confidence in batch call tasks.** `task_completed`, `completion_confidence`, and `evidence` exist only on the task; the recipient object has `id`, `phones`, `locale`, `region`, `status`, `structured_result`, `summary`, and `attempts`, with no confidence or evidence field. With six recipients on one task the confidence cannot gate an individual answer, and the guide confirms there is no built-in `answered_by` disposition. Shortline had to build transcript-based evidence checks instead. A per-recipient confidence, or an `answered_by` disposition, would remove a whole layer of heuristics.
   Verified against: calls.md lines 204 and 420-432; server-sdk-typescript@36ee6f1 src/generated/schema.ts:491-514 (CallTaskRecipient) versus :540-544 (CallTask).

6. **Webhooks are unsigned.** The docs are admirably clear about it, and the recommended pattern (treat as wake-up, re-read via API) works, but it doubles the API reads for every terminal event. An HMAC signature header would let receivers trust the body.
   Verified against: webhooks.md lines 130-134 and 167-170; changelog.md lines 82-87 (July 29 entry).

7. **No client-side cancel for an in-flight call task.** Everything that bounds exposure has to be structural (small batches, one wave at a time). Even a "cancel recipients not yet dialled" would help batch integrators.
   Verified against: calls.md lines 401-405; changelog.md line 145 (June 8 entry lists cancel call task APIs as not included).

8. **No lookup by idempotency key.** Recovery after an ambiguous create requires replaying the POST with the identical body. A `GET /v1/calls?idempotency_key=` would make reconciliation a read instead of a write.
   Verified against: openapi/calle.openapi.yaml paths (only `POST /v1/calls`, `GET /v1/calls/{call_id}`, `GET /v1/calls/{call_id}/events`; lines 12, 178, 254); schema.ts:7-15 (`get?: never` on `/v1/calls`); openapi line 741.

9. **No per-recipient variables on Calls API batch tasks.** A recipient is `phones` plus optional `region` and `locale`, nothing else, so a sweep that asks each pharmacy about a different product must be split into one task per product. Goal Runs have per-run variables but are one phone per run.
   Verified against: schema.ts:421-428 (CallTaskRecipientRequest); goal-runs.md lines 7, 178, 192-193.

10. **Calls API `failure_code` has no published enum**, so "no answer" versus "declined" cannot be distinguished at the call-task level; the Goal Runs API has these codes. Aligning them would let batch integrators report nonresponse categories.
    Verified against: errors.md lines 55 and 62-68; calls.md lines 440-441; goal-runs.md line 294.

## Documentation suggestions

11. A worked batch example with one recipient failing and one succeeding. The Webhooks guide example shows a completed recipient with `structured_result: null` next to a populated task-level result, but no example in the guides or the OpenAPI shows a Calls recipient with `status: failed` and a `failure_code`, or a completed task whose task-level `structured_result` is `null`. Both cases are stated in prose only, and integrators tend to assume a task-level result exists whenever the call completed.
    Verified against: webhooks.md lines 80-103; calls.md line 443; `grep -n 'status: failed' openapi/calle.openapi.yaml` (the only hit, line 616, is a Goal Run).

12. The reserved recipient response field names (`summary`, `status`, `transcript`, `call_id`, timing fields) appear in the Calls guide and in the `recipient_result_schema` description in the API reference, but neither says what happens when a schema uses one: is the request rejected with `recipient_result_schema_invalid`, or is the recipient result returned as `null`? The next sentence in the spec (line 1170) says unsupported or invalid recipient results come back as `null`, but it does not say whether a reserved name makes the schema invalid at create time. Stating the behaviour would let integrators lint their schemas.
    Verified against: calls.md line 160; openapi/calle.openapi.yaml:1166 and :1170 (rendered at https://docs.heycall-e.com/api-reference/calls); errors.md line 92.

13. State plainly in the Calls guide that keypad IVR navigation is supported and how to instruct it in task text; today it is a one-line August 15 changelog entry, and the only IVR mention in the guide is an enum value in the `answered_by` example.
    Verified against: changelog.md line 43; calls.md lines 213-215.

## What worked well

- Idempotency semantics made crash-safe dispatch straightforward. For the Calls API the spec promises that "reusing the same key with the same request returns the original call instead of creating a duplicate" and the guide says the key "prevents duplicate call creation"; neither names a status code for the replay. `POST /v1/calls` lists a `409` response, and the Errors guide defines `idempotency_conflict` as the same key reused with a different body. Goal Runs go further and document `201 Created` for both first acceptance and an exact replay. Shortline reads the returned task id and never branches on the status code.
  Verified against: openapi/calle.openapi.yaml:741 and :170; calls.md lines 414-418; errors.md line 94; goal-runs.md lines 214 and 309; this repo src/calle/live.ts:98-118.
- `evidence` and `completion_confidence` alongside `structured_result` are the right primitives for treating a call as a measurement.
  Verified against: calls.md lines 420-432; schema.ts:540-544.
- Strict object schemas with enums and `unknown` produce clean, gateable results.
  Verified against: calls.md lines 18 and 164-177.
