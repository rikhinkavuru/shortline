# Live runbook: one real call to your own phone

Everything below places real CALL-E calls and spends credit. Run the commands from the project directory after `npm install`; `npx shortline` and `node bin/shortline.mjs` are equivalent.

## 0. One-time setup

```bash
npm install
npx shortline demo --no-serve       # seeds fixtures and 8 simulated weeks (dry-run, no calls)

export SHORTLINE_MODE=live
export CALLE_API_KEY=iams_live_...  # dashboard.heycall-e.com/account/api-keys
export SHORTLINE_LIVE_ACK=I_UNDERSTAND_REAL_CALLS_COST_MONEY_AND_CANNOT_BE_RECALLED
export SHORTLINE_CALLER_NAME="Shortline"
export SHORTLINE_AUTH_TOKEN=$(openssl rand -hex 16)

npx shortline auth-check            # read-only, through the SDK; expects {"ok": true, "status": 200, "sdk": "@call-e/calle"}
```

## 1. Register your own phone as a test line

A test line is exempt from calling windows and cooldowns, may be targeted by a sourcing request, and is never sampled by a sweep or counted in the index.

```bash
npx shortline site add --id demo-me --name "Corner Pharmacy" --kind independent \
  --phone +1XXXXXXXXXX --region US-CA-SF --tz America/Los_Angeles --test-line
```

## 2. Smoke test: exactly one real call, to you

```bash
npx shortline find --watch amoxicillin-susp --region US-CA-SF --only-site demo-me --need 1 --wave 1 --max-waves 1
```

That prints the plan and places nothing. Re-run with `--yes` to dial. Your phone rings within about a minute. Answer as pharmacy staff, with a fictional name:

> "Pharmacy, this is Dana." → let the assistant disclose itself and ask → "Let me check… yes, we have that, but only a couple of bottles. Next delivery is Thursday."

Expected output: `status: "met"`, one confirmed source with `outcome: "limited"`, an `evidenceQuote` in your words, `restockExpectation` mentioning Thursday. If `usable` is false, read `attempts[].usableReason`: that is the evidence gate doing its job (for example `evidence_unattributed` when the extracted quote is not a phrase you actually said); speak a clear full sentence and try once more.

Cost: one recipient per attempt.

Rehearsing more than once within 24 hours? After an in-stock answer the planner will list your test line under *known sources* and place no call. Add `--fresh` (dashboard: "Call even if seen in stock recently") to dial anyway; that flag only affects which sites are dialled, never the courtesy rules for real pharmacies' business lines beyond a re-verification call.

## 3. Export the evidence the same day

Transcripts are purged after 14 days, so export immediately. The dispatch id is printed by the find command (`dsp_...`) and shown in the dashboard feed.

```bash
npx shortline evidence --dispatch dsp_...
```

This writes `docs/evidence/<date>-<dispatch>/{call.json,events.json,observations.json,README.md}`: the terminal `GET /v1/calls/{id}` snapshot in API shape with your number replaced by a fiction-block number, the developer events, and the derived observation. Commit the folder and add one line to the README's Technical implementation row: `Verified against CALL-E on <date>: call_<id>, artifacts in docs/evidence/`. Do three to five calls so one shows a gate firing on purpose (say "we can't give out stock information over the phone" for `refused`, or hang up before the product is named for `product_never_asked`).

## 4. Record

```bash
npx shortline serve      # live mode; open http://127.0.0.1:8787/?token=$SHORTLINE_AUTH_TOKEN
```

Follow `docs/demo.md`. In **Find it now** choose region `US-CA-SF`, sources needed 1, wave size 1, type `demo-me` under *Only these sites*, then **Plan** → the plan lists `demo-me` → **Place 1 real call**. Keep the phone in frame. Click **transcript** on the observation once it lands. The feed labels each CALL-E developer event and shows the real call id.

If you would rather drive it from the CLI while recording, run the step 2 command with `--yes` in a visible terminal next to the dashboard; the dashboard updates either way.

## 5. After recording

- `npx shortline reconcile` once, so any straggling dispatch is verified.
- Unset the live variables before doing anything else.
- The database keeps the real observations under `demo-me`; they never enter the index because the site is a test line.
