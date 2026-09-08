# The availability index

Shortline estimates, for one product and one region, the share of pharmacies that could dispense it on the day they were asked. This note records the design so the number can be argued with.

## Population and frame

The **frame** is the list of sites in the watched regions that are not opted out, not confirmed wrong numbers, and not known to not carry the product. It is partitioned into **strata** by region × kind (chain, independent, hospital outpatient, wholesaler branch). Chains and independents behave differently under a shortage (central allocation versus wholesaler queue), so stratifying by kind reduces variance and lets the table show the split.

A site that answers "we don't carry that" leaves the frame for that product. That is a frame correction, not an out-of-stock observation.

## Sampling

Each week, within each stratum, a fresh simple random subsample of size `panelPerStratum` is drawn from the sites that are eligible that day. Eligibility encodes courtesy:

- not asked about this product within `cooldownDays` (14 by default);
- not called by Shortline for any purpose within `globalMinGapDays` (5);
- not refused within 90 days.

The draw is seeded by (watch, ISO week), so re-running a sweep reproduces the plan. Because the cooldown is longer than the sweep period, the panel **rotates**: with a frame of 6 per stratum and a panel of 3, every site is asked every other week. When the eligible pool is smaller than the panel, the stratum is marked **undersampled** and the interval widens accordingly.

## Observations

A call produces one observation per recipient. It enters the estimator only if the classification is *usable* (see `docs/call-design.md`): a person in the pharmacy answered, the product was actually named, an evidence quote exists and is attributable to the callee, and the answer is in stock / limited / out of stock.

Everything else is **nonresponse**: voicemail, menus that never reached a person, refusals, unclear answers, failed calls, and results whose evidence does not hold up. Nonresponse is reported as the response rate next to every estimate. It is *not* imputed. If nonresponse correlates with availability (a swamped pharmacy that does not pick up may also be the one that is out), the index is biased toward the reachable. That bias is stated here rather than modelled away.

Availability is coded as **in stock or limited**. The strata table also shows the split.

## Estimator

Per stratum *h* with *n_h* usable observations and *x_h* available:

- Point estimate p̂_h = x_h / n_h.
- Interval: Wilson score interval at 95%. Wilson is used instead of the Wald interval because n_h is small (2–6) and p̂_h is often 0 or 1, where Wald collapses to zero width.

Overall, with W_h = N_h / N over strata that produced at least one usable observation:

- p̂ = Σ W_h p̂_h
- SE² = Σ W_h² (1 − n_h/N_h) p̂_h(1 − p̂_h) / (n_h − 1)
- Interval p̂ ± 1.96·SE, clipped to [0, 1].

The finite-population correction matters here: with a frame of 6 and a panel of 3, half the stratum has been observed directly.

**Fallback.** When any covered stratum has fewer than two usable observations the per-stratum variance is undefined. The estimator then pools all usable observations into one Wilson interval and reports `method: pooled_wilson`. The method is always displayed.

**Coverage.** The share of the frame represented by covered strata. A coverage of 0.6 means 40% of the frame produced nothing usable this week; the estimate describes the covered part only.

## Signal

| Signal | Rule |
| --- | --- |
| `insufficient_data` | usable observations < `minUsable` (6), or no estimate |
| `shortage` | upper bound of the 95% interval < `shortageUpper` (0.5) |
| `strained` | point estimate < `strainedPoint` (0.7) |
| `available` | otherwise |

Shortage is declared on the **upper bound**, so a wide interval that merely dips below the line does not trip it. This trades sensitivity for precision on purpose: a false shortage alert sends people phoning.

## What the index is not

- It is not a measure of national supply. It is a street-level measure for the regions in the frame.
- It is not a forecast. Weekly points are independent samples; the chart is a time series of estimates, not a model.
- It is not a count of doses. "Limited" means staff said supply was short; `quantity_note` keeps their words.
- It is not free of reporting error. A clerk may be wrong. The evidence quote and the stored transcript make each observation auditable, which is the most an instrument of this kind can offer.

## Simulated history

`npm run demo` simulates eight weekly sweeps against the scripted fake provider with a scenario mix whose out-of-stock share rises week over week. Every observation from the fake is stored with `simulated = true`, every estimate built from them says `simulated: true`, and the dashboard prints SIMULATED HISTORY over the chart. Simulated and live observations are never mixed silently: they are distinguishable row by row.
