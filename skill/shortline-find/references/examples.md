# Examples

Every example below runs in dry-run mode unless the operator has set the three live variables. Numbers shown are masked; the fixtures are fictional.

## 1. "Is amoxicillin suspension in shortage in San Francisco this week?"

Agent calls `shortline_watch_status` with `watch_id: "amoxicillin-susp"` and answers from the latest estimate:

> Shortline's index for amoxicillin 400 mg/5 mL oral suspension across SF, East Bay, and South Bay is **50% (27–73%)** for week 2026-W36, signal **strained**, from 14 usable observations out of 18 pharmacies asked (78% response). Chains look better than independents this week: SF chains 100% (34–100%, n=2), SF independents 33% (6–79%, n=3). Method: pooled Wilson because one stratum had a single usable observation. These are simulated observations; no call was placed.

No call is placed. The agent reports the interval, not just the point, and says which numbers are simulated.

## 2. "Find me two pharmacies that have it today, near the Mission."

Agent calls `shortline_plan_find`:

```json
{ "watch_id": "amoxicillin-susp", "region": "US-CA-SF", "need": 2, "wave_size": 3, "near": { "lat": 37.759, "lng": -122.414 } }
```

Response (abridged):

```json
{
  "find_request_id": "fnd_1a2b3c",
  "mode": "dry-run",
  "known_sources_no_call_needed": [
    { "name": "Mission Family Pharmacy", "phone": "+1 415 ••• 0107", "outcome": "in_stock", "observedAt": "2026-09-07T18:04:11Z", "evidenceQuote": "yes, we have that in stock" }
  ],
  "candidates": [
    { "siteId": "sf-ind-4", "name": "Noe Valley Pharmacy", "phoneMasked": "+1 415 ••• 0110", "basis": "unknown", "distanceKm": 1.4, "kind": "independent" },
    { "siteId": "sf-chn-2", "name": "Bayline Pharmacy #102", "phoneMasked": "+1 415 ••• 0102", "basis": "unknown", "distanceKm": 2.9, "kind": "chain" },
    { "siteId": "sf-ind-2", "name": "Golden Gate Apothecary", "phoneMasked": "+1 415 ••• 0108", "basis": "unknown", "distanceKm": 3.3, "kind": "independent" }
  ],
  "skipped": [ { "siteId": "sf-ind-3", "name": "Sunset Neighborhood Rx", "reason": "observed_out_of_stock_recently" } ],
  "first_wave_calls": 2,
  "max_calls": 3
}
```

The agent shows this to the user:

> One pharmacy was seen in stock three hours ago, so no call is needed for it. To confirm a second, Shortline would call 2 nearby pharmacies now and at most 3 in total (masked numbers above), in dry-run mode. Place the calls?

Only after "yes" does the agent call `shortline_run_find` with `{ "find_request_id": "fnd_1a2b3c", "confirm": true }`.

## 3. Reporting the result

From `shortline_get_find`:

> Two sources confirmed. **Mission Family Pharmacy** (+1 415 ••• 0107): in stock, "yes, we have that in stock", observed 3h ago by the weekly monitoring sweep. **Bayline Pharmacy #102** (+1 415 ••• 0102): limited, "we only have a couple of bottles left", next delivery Thursday, confirmed just now. Not counted: Noe Valley Pharmacy reached voicemail; Golden Gate Apothecary's phone menu never reached a person.

Unusable attempts are listed with their reason and are not presented as "no".

## 4. What the agent says when a wave stops in `needs_human`

> Shortline stopped this request: the call CALL-E returned was not bound to the dispatch Shortline reserved (binding mismatch, from the halt note). Nothing was recorded from it. A person should look at dispatch `dsp_…` before anything is re-run. I will not retry on my own.

## 5. Refusing out-of-scope requests

- "Order it for me" → "Shortline can confirm stock and, if you ask, whether a pharmacy will hold one fill for pickup today. It cannot order or pay. Want me to include the hold question?"
- "Someone is having trouble breathing and needs albuterol now" → "Please call emergency services right now. Shortline is a monitoring tool and not for emergencies."
- "Call my neighbour and ask if she has some left over" → "Shortline calls pharmacies on their business lines only; it has no way to record consent for calling a person."
