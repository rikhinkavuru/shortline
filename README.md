# Shortline

**Phone calls as a statistical sensor network for drug shortages.**

Shortline asks a rotating, stratified sample of pharmacies one question by phone — *can you dispense this product today?* — through [CALL-E](https://www.heycall-e.com/), turns every answer into an evidence-checked observation, and publishes a weekly **availability index with a 95% interval** per region. When someone needs the product *now*, the same engine runs **sourcing waves** that stop the moment enough pharmacies have confirmed stock, and every confirmation carries the pharmacy's own words.

Built for the CALL-E "Your Code Is Calling" hackathon. Dry-run by default; no call can be placed without three explicit settings.

```
┌───────────────────────── every week ─────────────────────────┐
│  frame (all pharmacies)  →  stratified random subsample       │
│        ↓ courtesy: ≤1 ask per site per cooldown, local hours  │
│  CALL-E batch call task, per-recipient result schema          │
│        ↓ evidence gates: quote must be in transcript, product │
│          must have been named, staff must have answered       │
│  observations → Wilson intervals per stratum → weighted index │
│        ↓                                                      │
│  signal: available / strained / shortage / insufficient data  │
└───────────────────────────────────────────────────────────────┘
        ↑ feeds                                    ↓ uses
┌──────────── find it now ────────────┐   fresh sightings rank first,
│ waves of 3 → stop at K confirmed    │   sites seen out are skipped,
│ each answer is also an observation  │   nobody is dialled twice
└─────────────────────────────────────┘
```

## Why

- Active US drug shortages rose for the third straight quarter to **227 in Q2 2026** (ASHP / University of Utah Drug Information Service). National lists are national and binary: they say *a* shortage exists, not whether the pharmacy across the street can fill a prescription this afternoon.
- Hospital pharmacy teams spend on the order of **20 staff-hours a week** managing shortages, rising to a full-time job at 300+ beds (ASHP shortage surveys). A large share of that time is phone work: calling wholesalers, sister hospitals, and retail pharmacies one by one.
- Pharmacies have no inventory API. The phone *is* the API. Until now the only way to measure availability at street level was for a person to dial, so nobody measured it.

Shortline treats each call as a **measurement** with known noise (voicemail, menus, refusals, wrong numbers, extraction errors) and designs around it: sampling instead of census, intervals instead of point claims, courtesy as a property of the design rather than a rate limiter bolted on.

## What the judges' criteria map to

| Criterion | Where to look |
| --- | --- |
| Real world impact | `README.md` → *Why*; `docs/statistics.md` for what the index can and cannot claim |
| Quality of the idea | rotating panel + evidence gates + sourcing waves that reuse surveillance data (`src/domain/`) |
| Technical implementation | official `@call-e/calle` SDK 0.7 batch calls with `recipient_result_schema`, task-level `result_schema` cross-check, idempotency keys, terminal webhooks with `CALL-E-Event-Id` and authenticated reconciliation, developer events (`src/calle/`, `src/app/`) |
| Product experience | dashboard with live SSE feed and transcript evidence, CLI, MCP server, portable skill (`src/server/`, `src/cli.ts`, `src/mcp/`, `skill/`) |

## Try it in two minutes (no account, no calls)

Requires Node.js 22.13 or newer (uses the built-in `node:sqlite`).

```bash
npm install
npm test           # 62 tests, no network, no credentials
npm run demo       # loads 36 fictional pharmacies, simulates 8 weeks, opens the dashboard
```

Open <http://127.0.0.1:8787/>. The chart shows a shortage building over eight simulated weeks. Click **Run sweep now** (tick *ignore calling hours* if it is evening where the fictional pharmacies live), then plan and run a **Find it now** request. Click **transcript** on any observation to see the evidence quote highlighted in the callee's own words — or the reason an observation was *not* counted.

Set `SHORTLINE_FAKE_PACE_MS=1500` before `npm run demo` to watch calls progress in real time instead of completing instantly.

Every number in the fixtures is in the NANP fiction block (`555-01XX`). Live mode refuses to dial them.

## How it works

### 1. The frame and the panel

Sites carry a region, a kind (chain, independent, hospital outpatient, wholesaler branch), an IANA timezone, and one E.164 number. Region × kind is the **stratum**. Each week `planSweep` draws a fresh random subsample per stratum from the sites that are eligible *today*:

- not opted out, and never called again after a "don't call us";
- not asked about this product within `cooldownDays` (default 14);
- not called by Shortline for any reason within `globalMinGapDays` (default 5);
- not refused in the last 90 days; not confirmed as a wrong number; not known to not carry the product.

The draw is seeded by watch and ISO week, so a crashed and restarted sweep plans the same sites.

### 2. One call task per batch

A dispatch is one CALL-E call task with up to `SHORTLINE_BATCH_SIZE` recipients. The task text is short: disclose that the caller is automated, navigate a phone menu if there is one, ask one question, two follow-ups, no orders, no patients, no prices. The `recipient_result_schema` is enums-first with `unknown` everywhere, plus `evidence_quote`, `answered_by`, `reached_pharmacy`, and `do_not_call_request`. See `docs/call-design.md`.

Dispatches follow the lifecycle from the CALL-E community's production guide: **reserved** (intent and idempotency key are durable) → **accepted** (call id bound) → **terminal_unverified** → **terminal_verified**, with `submission_unknown` and `needs_human` as the honest side exits. The idempotency key is derived from watch, week, and site set, never from an attempt, so a replay after a crash returns the original call instead of dialling twice.

### 3. Evidence gates

`classifyRecipient` decides whether an answer may enter the estimator. It is not enough for the structured result to be schema-valid:

| Check | Verdict if it fails |
| --- | --- |
| A person answered and worked in the pharmacy | `pharmacy_not_reached`, `ivr_only`, `voicemail` |
| The assistant actually named the product (bot turns contain it) | `product_never_asked` |
| `evidence_quote` is present | `no_evidence` |
| The quote's words appear in what the callee said | `evidence_unattributed` |
| The answer is one of in stock / limited / out of stock | `refused`, `no_clear_answer`, `not_in_frame` |

Unusable observations are kept and shown with their reason. They are never silently dropped and never counted as "no".

### 4. The index

Per stratum, availability (in stock or limited) gets a Wilson score interval. Strata combine with weights proportional to frame size and a finite-population correction. When any covered stratum has fewer than two usable observations the estimator falls back to a pooled Wilson interval and says so. The **signal** is:

- `shortage` when the *upper* bound is below the shortage line (default 50%);
- `strained` when the point estimate is below 70%;
- `insufficient_data` when fewer than `minUsable` observations survived the gates.

Coverage (share of the frame represented by strata with data) and response rate are reported next to every estimate. Details, assumptions, and limits: `docs/statistics.md`.

### 5. Find it now

A sourcing request names a product, a region, how many confirmed sources are needed, and a wave size. Planning never dials. Sites seen in stock within 24 hours are returned as **known sources** without a call; sites seen out of stock within 72 hours are skipped; the rest are ranked by freshness then distance. Each wave is its own call task with its own idempotency key. The loop stops at the first wave that meets the need. With `--ask-hold`, the assistant asks whether staff can hold one fill for pickup today; a "yes" is recorded as a **stated intention**, never as a reservation.

## Using it for real

Live mode needs all three of:

```bash
export SHORTLINE_MODE=live
export CALLE_API_KEY=iams_live_...          # dashboard.heycall-e.com/account/api-keys
export SHORTLINE_LIVE_ACK=I_UNDERSTAND_REAL_CALLS_COST_MONEY_AND_CANNOT_BE_RECALLED
```

Then:

```bash
shortline auth-check                                   # read-only: GET /v1/goals?limit=1
shortline site add --id my-pharmacy --name "Corner Pharmacy" --kind independent \
  --phone +1XXXXXXXXXX --region US-CA-SF --tz America/Los_Angeles
shortline watch add --id albuterol --name albuterol --strength "90 mcg" --form "inhaler" --regions US-CA-SF
shortline sweep --watch albuterol --wait                # only sites inside their local window are dialled
shortline find --watch albuterol --region US-CA-SF --need 2   # plan; add --yes to place the calls
shortline serve                                         # dashboard, webhook receiver, recovery poller
```

Set `SHORTLINE_PUBLIC_URL` to receive terminal webhooks at `/webhooks/calle`; otherwise results are collected by polling. `SHORTLINE_AUTH_TOKEN` is mandatory to serve in live mode. Real numbers come from your own site list (CSV, manual, or an NPPES export); the fixtures are fictional and refused in live mode.

Recurrence belongs to the host scheduler. Run `shortline sweep --watch <id>` a few times a day from cron; the sweep row and per-batch idempotency keys make every invocation safe to repeat, and only sites inside their local calling window are dialled.

## For agents: MCP and skill

```bash
shortline mcp        # stdio MCP server
```

Tools: `shortline_watch_status`, `shortline_list_sites`, `shortline_plan_find` (read-only, never dials), `shortline_run_find` (requires `confirm: true`; destructive annotation), `shortline_get_find`. The portable skill in `skill/shortline-find/` teaches an agent when to plan, what to show the user before confirming, and what it must never do.

## Side effects, cancellation, data

- **Calls.** Only in live mode, only from `sweep`, `find --yes`, `find-run`, the dashboard's confirm buttons, or `shortline_run_find` with `confirm: true`. Every call discloses that it is automated. Each call task costs CALL-E credit per recipient.
- **No cancellation of an in-flight call.** The Calls API cannot recall a call. Sweeps dispatch in batches of at most `SHORTLINE_BATCH_SIZE` (default 6) and sourcing dispatches one wave at a time so the exposure of any single decision is bounded. Stopping the process stops further dispatches; a batch already accepted completes and is reconciled on the next run.
- **No recurring jobs are created.** Recurrence is the host scheduler's job.
- **Opt-out is permanent.** A `do_not_call_request` on any call opts the site out for every watch; operators can also opt a site out from the dashboard or `shortline opt-out`.
- **Phone numbers** live only in the `sites` table. Every log line, API response, dashboard view, MCP result, and stored transcript is masked (`+1 415 ••• 0123`).
- **Transcripts** are stored masked for `SHORTLINE_KEEP_TRANSCRIPTS_DAYS` (default 14, `0` disables) so evidence can be inspected, then purged.
- **Credentials** are read from the environment and never written anywhere.
- **Boundaries.** Shortline asks pharmacies about stock. It gives no medical advice, never mentions a patient, never orders or pays, and is not an emergency service. See `docs/safety.md`.

## Limitations and honest caveats

- A phone answer is a report by a busy person; "in stock" means *they said so*. The evidence quote is the audit trail, not a guarantee.
- Small panels give wide intervals. That is the point of showing them. Increase `panelPerStratum` or the frame to narrow them.
- Refusals and controlled-substance policies vary. The `methylphenidate-er` fixture is paused for that reason; a refusal rests a site for 90 days.
- The frame is only as good as the site list. The fixtures are fictional. A real deployment should build the frame from a licensed pharmacy registry and verify numbers with a first sweep.
- CALL-E's `completion_confidence` is task-level, so it is recorded as context rather than used as a per-recipient gate; the transcript checks do the per-recipient work.

## Repository layout

```
src/domain/     pure: sampling, estimator, classification, task text and schemas, waves
src/calle/      provider interface, official SDK adapter, scripted fake, fake HTTP server
src/store/      node:sqlite ledger: sites, watches, sweeps, dispatches, observations, inbox, audit
src/app/        submit-once dispatch, authoritative reconcile, estimate, sweep, find, poller, webhook
src/server/     Hono dashboard + API + SSE + webhook receiver
src/mcp/        MCP server
src/cli.ts      CLI
skill/          portable Agent Skill (shortline-find)
fixtures/       36 fictional pharmacies (555-01XX), two watches
test/           62 tests, no network
docs/           statistics, safety, call design, demo script
```

MIT. Built with the official `@call-e/calle` server SDK. Not affiliated with any pharmacy or manufacturer.
