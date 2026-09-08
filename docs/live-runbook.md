# Live runbook: first real call, then the video

Everything below places real CALL-E calls and spends credit. Do it in this order.

## 0. One-time setup

```bash
cd ~/call-e
npm install
npm run demo -- --no-serve          # seeds fixtures and 8 simulated weeks (dry-run, no calls)

export SHORTLINE_MODE=live
export CALLE_API_KEY=iams_live_...  # dashboard.heycall-e.com/account/api-keys
export SHORTLINE_LIVE_ACK=I_UNDERSTAND_REAL_CALLS_COST_MONEY_AND_CANNOT_BE_RECALLED
export SHORTLINE_AUTH_TOKEN=$(openssl rand -hex 16)

npm run dev -- auth-check           # read-only; expects {"ok": true, "status": 200}
```

## 1. Register your own phone as a test line

A test line is exempt from calling windows and cooldowns, may be targeted by a sourcing request, and is never sampled by a sweep or counted in the index.

```bash
npm run dev -- site add --id demo-me --name "Corner Pharmacy" --kind independent \
  --phone +1XXXXXXXXXX --region US-CA-SF --tz America/Los_Angeles --test-line
```

## 2. Smoke test: exactly one real call, to you

```bash
npm run dev -- find --watch amoxicillin-susp --region US-CA-SF --only-site demo-me --need 1 --wave 1 --max-waves 1
```

That prints the plan and places nothing. Re-run with `--yes` to dial. Your phone rings within about a minute. Answer as pharmacy staff:

> "Pharmacy, this is …" → let the assistant disclose itself and ask → "Let me check… yes, we have that, but only a couple of bottles. Next delivery is Thursday."

Expected output: `status: met`, one confirmed source with `outcome: limited`, an `evidenceQuote` in your words, `restockExpectation` mentioning Thursday. If the quote is missing or `usable` is false, read `attempts[].usableReason` — that is the evidence gate doing its job; try once more speaking clearly.

Cost: one recipient. Twenty free calls cover the smoke test, a few retakes, and the recording.

## 3. Optional: one real chain pharmacy through its phone menu

Pick one store with a public phone menu. Add it without `--test-line` so the calling window applies (10:00–17:00 local, Monday–Saturday):

```bash
npm run dev -- site add --id chain-1 --name "A chain pharmacy" --kind chain \
  --phone +1XXXXXXXXXX --region US-CA-SF --tz America/Los_Angeles
npm run dev -- find --watch amoxicillin-susp --region US-CA-SF --only-site chain-1 --need 1 --wave 1 --max-waves 1 --yes
```

This is a normal customer question, disclosed as automated. Keep it to one call and refer to it only as "a chain pharmacy" on screen.

## 4. Record

```bash
SHORTLINE_FAKE_PACE_MS=0 npm run dev -- serve      # live mode; open http://127.0.0.1:8787/?token=$SHORTLINE_AUTH_TOKEN
```

Follow `docs/demo.md`. In the **Find it now** panel choose region `US-CA-SF`, need 1, wave 1, then **Plan** → the plan lists `demo-me` (and `chain-1` if added) → **Place real call**. Keep the phone in frame. Click **transcript** on the observation once it lands.

If you would rather drive it from the CLI while recording, run the step 2 command with `--yes` in a visible terminal next to the dashboard; the dashboard updates either way.

## 5. After recording

- `npm run dev -- reconcile` once, so any straggling dispatch is verified.
- Unset the three live variables before doing anything else.
- The database keeps the real observations under `demo-me`; they never enter the index because the site is a test line.
