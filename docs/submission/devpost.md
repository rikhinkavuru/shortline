# Devpost submission text

## Project name

Shortline

## Tagline (one line)

Phone calls as a statistical sensor network for drug shortages: rotating pharmacy panels dialled through CALL-E, evidence-gated answers, a weekly availability index with confidence intervals, and sourcing waves that find stock today.

## Inspiration

Active US drug shortages rose for the third straight quarter to 227 in Q2 2026 (ASHP / University of Utah). The national lists say *that* a shortage exists; they cannot tell a pharmacist whether the store across the street can fill a prescription this afternoon. Hospital pharmacy teams spend about 20 staff-hours a week managing shortages, a full-time job at 300+ beds, and much of it is phone work: calling wholesalers, sister hospitals, and retail pharmacies one at a time. I work on manufacturing for shortage-critical injectables, and the recurring line from pharmacists is "we just phone around." Pharmacies have no inventory API. The phone is the API. Nobody had built the instrument.

## What it does

Shortline treats a phone call as a measurement.

**Surveillance.** Every week it draws a fresh random subsample of pharmacies per region and per kind (chain / independent), calls them through CALL-E with one disclosed question — can you dispense this product today? — and estimates availability per stratum with Wilson score intervals, combined into a regional index with finite-population correction. The signal is `available`, `strained`, `shortage` (declared only when the *upper* bound of the interval is below the line), or `insufficient_data`. Coverage and response rate are shown next to every estimate.

**Evidence gates.** A schema-valid structured result is not yet an observation. Shortline checks that a person in the pharmacy answered, that the assistant actually named the product, and that the evidence quote appears in the callee's own transcript turns. Voicemail, phone menus that never reach a person, refusals, wrong numbers, and unattributed quotes are recorded and shown with their reason, never counted as "no".

**Courtesy by design.** No pharmacy is asked about the same product more than once per cooldown, calls happen only inside the site's local calling window (IANA timezone per site, never inferred), a refusal rests a site for 90 days, two "not reached" outcomes drop a number from the frame, and "please don't call again" opts a site out of everything, permanently.

**Find it now.** A sourcing request names a product, region, and how many confirmed sources are needed. Planning never dials. Pharmacies seen in stock in the last 24 hours are returned without a call; pharmacies seen out of stock are skipped; the rest are dialled in waves of three, stopping the moment the need is met. Every sourcing call is also a surveillance observation, so the two halves feed each other.

**Surfaces.** A dashboard with a live event feed and transcript evidence, a CLI, an MCP server (read tools are read-only; running a request needs `confirm: true` and carries the destructive annotation), and a portable Agent Skill.

## How we built it

TypeScript on Node 22+ with the built-in `node:sqlite`; Hono for the dashboard and webhook receiver; the official `@call-e/calle` 0.7 server SDK.

CALL-E usage: batch call tasks with `recipients`, a strict `recipient_result_schema` (enums with `unknown`, `evidence_quote`, `answered_by`, `reached_pharmacy`, `do_not_call_request`), a task-level `result_schema` used as a cross-check, `metadata` binding every call back to its dispatch, `Idempotency-Key` derived from the business action (watch + week + site set, or find request + wave), terminal webhooks validated on `CALL-E-Event-Id` and then reconciled through an authenticated `GET /v1/calls/{id}`, and developer events streamed into the dashboard.

Dispatches follow the community production guide: reserved → accepted → terminal_unverified → terminal_verified, with `submission_unknown` replayed under the same key and `needs_human` for any binding or evidence failure.

Dry-run is the default. A scripted fake provider plays fifteen callee scenarios (including a schema-valid result whose quote is invented and a call where the product was never named), and a fake HTTP server lets the real SDK adapter be tested end to end, webhooks included. 63 tests run without a network or credentials.

## Challenges we ran into

- CALL-E's `completion_confidence` is task-level, so it cannot gate individual recipients in a batch. The transcript checks do that work instead, and the per-recipient limitation is documented.
- The Calls API has no client-side cancel, so exposure is bounded structurally: small batches and one wave at a time.
- Making the courtesy budget a property of the sampling design rather than a rate limiter took a few iterations; the payoff is that a crashed and restarted sweep plans the same sites and never dials twice.

## Accomplishments we're proud of

- The index reports what it does not know: intervals, coverage, response rate, method, and a dashed marker for weeks with insufficient data.
- Every observation in the dashboard links to a masked transcript with the evidence quote highlighted in the pharmacy's words, or the reason it was not counted.
- The whole system is honest about simulation: dry-run observations are marked `simulated` row by row and the chart says so.

## What we learned

Phone answers are noisy in specific, predictable ways, and almost all of the engineering is in refusing to count what should not be counted. CALL-E's structured results with evidence and its idempotency semantics made the "call as measurement" framing possible.

## What's next

A real frame from a licensed pharmacy registry with a verification sweep; Goal Runs for the repeated weekly question once the workflow is published as a Goal; state health department and hospital pharmacy pilots; watches for blood products, infant formula, and IV fluids, which the engine already supports.

## Built with

TypeScript, Node.js, node:sqlite, Hono, @call-e/calle (CALL-E server SDK), Model Context Protocol SDK, Vitest.

## Testing instructions for judges

```bash
git clone https://github.com/rikhinkavuru/shortline && cd shortline
npm install && npm test          # 63 tests, no credentials
SHORTLINE_FAKE_PACE_MS=1500 npm run demo
```

Open http://127.0.0.1:8787/. Tick "Ignore calling hours (dry-run only)", click **Run sweep now**, then plan and run a **Find it now** request. Click **transcript** on any observation. To verify the live SDK path without placing a call: `SHORTLINE_MODE=live CALLE_API_KEY=... SHORTLINE_LIVE_ACK=I_UNDERSTAND_REAL_CALLS_COST_MONEY_AND_CANNOT_BE_RECALLED npm run dev -- auth-check`.

Hosted dry-run demo (no calls possible): https://shortline-rikhinkavuru-9840s-projects.vercel.app/

## Links to fill in on the form

- Pull request URL: (from `gh pr create`, see docs/submission/pr-body.md)
- Demo video: YouTube link, under three minutes, public
- CALL-E account email: the address used to sign up at heycall-e.com
- Optional demo URL: https://shortline-rikhinkavuru-9840s-projects.vercel.app/
