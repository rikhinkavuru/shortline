# Demo video plan (under three minutes)

Judges are not required to watch past three minutes, so the cut is 2:40 with the live call in the first half.

## Setup before recording

1. `npm run demo` once so the database has eight simulated weeks; stop it.
2. Add your own phone as a **test line** so the live call rings on your desk at any hour and never enters the index:
   `shortline site add --id demo-me --name "Corner Pharmacy" --kind independent --phone +1XXXXXXXXXX --region US-CA-SF --tz America/Los_Angeles --test-line`
   Full commands, including a one-call smoke test: `docs/live-runbook.md`.
3. Export the four live variables and `SHORTLINE_AUTH_TOKEN`, start `npx shortline serve`, open the dashboard with `?token=`.
4. Record the screen with the phone in frame. Record only the call to your own test line.

## Script

**0:00–0:20 — the problem.** Chart on screen, SIMULATED HISTORY label visible.
"As of the latest quarterly count, two hundred and twenty-seven drugs are in shortage in the US. The national lists tell you *that*. They can't tell a pharmacist whether the store across the street can fill a prescription this afternoon. Pharmacies have no inventory API. The phone is the API. Shortline turns phone calls into a sensor network."

**0:20–0:45 — how it measures.** Hover the band, point at the strata table.
"Every week it draws a fresh random sample of pharmacies per region and per kind, calls them through CALL-E with one question, and estimates availability with a 95% interval. Courtesy is built into the sampling: no pharmacy is asked about the same product more than once a fortnight, calls happen in local business hours, and anyone who says 'don't call us' is out for good."

**0:45–1:45 — a real call.** In **Find it now** choose the region, sources needed 1, wave size 1, type `demo-me` under *Only these sites*, click **Plan**. Show the masked candidate. Click **Place 1 real call**.
"This is a live sourcing request." Phone rings. Answer as the pharmacy: "Pharmacy, this is …" (use a fictional first name). Let CALL-E disclose itself and ask. Answer: "Let me check… yes, we have that, but only a couple of bottles. Next delivery is Thursday."
Watch the feed: dialing → recipient completed → observation **limited**, evidence quote appears. Click **transcript**: the quote is highlighted in your own words.
"The structured result came back through the SDK, and Shortline checked the quote against the transcript before counting it."

**1:45–2:10 — evidence gates.** Scroll the feed from the simulated sweep.
"Not every answer counts. Here CALL-E returned a schema-valid 'in stock' but the quote isn't in the transcript — not counted. Here the assistant never named the product — not counted. Voicemail, menus that never reach a person, refusals: recorded, shown, never treated as a 'no'."

**2:10–2:30 — the loop.** Click **Plan** again for the same product: the pharmacy you just called appears under *Known sources (no call needed)*.
"Fresh sightings feed the next sourcing wave and the courtesy ledger, and the weekly index stays a random sample. Waves of three, stop the moment enough pharmacies have confirmed."

**2:30–2:40 — close.** README on screen.
"Official CALL-E SDK, batch call tasks, per-recipient schemas, idempotent dispatch, authenticated webhook reconciliation, MCP tools for agents. Dry-run by default, the whole test suite runs without a network. Shortline."

## Rules to respect while recording

- No third-party trademarks in the video: only the fictional fixture names and your test line appear on screen.
- No copyrighted music.
- Show the project functioning on the device it was built for (the dashboard in a browser plus the phone).
- Keep the phone number masked on screen; Shortline already masks it everywhere.
