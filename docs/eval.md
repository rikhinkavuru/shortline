# Evaluation harness

`npm run eval` runs a deterministic Monte Carlo over the pure domain layer. No network, no sqlite, no CALL-E. It exists so the claims in `docs/statistics.md` can be checked against a population whose truth is known.

```bash
node --disable-warning=ExperimentalWarning --import tsx src/eval.ts
```

Seed `20260907` (mulberry32 via `hashString`), 10,000 simulated weeks per configuration, about one second on a laptop. Re-running reproduces every number below; only the `elapsed` line varies.

## Design

- **Frame.** 36 fictional sites in 6 strata: 3 regions x {chain, independent}, 6 sites each. Each week every site is fixed in one true state (available or out of stock). The **truth** is the realised finite-population share, the number the estimator is trying to hit.
- **Panel.** The real `planSweep` draws 3 sites per stratum, seeded by the week.
- **Calls.** Each call is scripted from the dry-run scenarios in `src/calle/scenarios.ts` with the `DEFAULT_MIX` weights. Refused, voicemail, no answer, IVR dead end and null result are nonresponse (25.3% of calls). Usable answers (in stock, limited via `in_stock_human`, `ivr_then_in_stock`, `limited_human`; out of stock via `out_of_stock_human`) always agree with the site's true state. At bad-evidence rate `r`, an out-of-stock site instead produces the `unattributed_quote` scenario: a schema-valid `in_stock` result whose quote is not in the transcript.
- **Gate.** The real `classifyRecipient` (strict policy) runs on each scripted transcript. "Ungated" counts any schema-valid stock answer from a human at the pharmacy, which is what the estimator would see without the evidence gates.
- **Estimator.** Counts go through `combineStrata` and `classifySignal` exactly as `src/app/estimate.ts` does, with `minUsable = 6`, shortage line 0.5, strained line 0.7.
- **Truth per experiment.** (a) draws a per-week pressure `q ~ U(0.15, 0.95)` and sets each site available with probability `q`. (b) and (c) hold the true share fixed at exactly `k` of 36 sites so a false-shortage rate is conditional on a known truth; 20/36 = 0.556 and 16/36 = 0.444 are the nearest achievable to 0.55 and 0.45, and (c) uses 18/36 = 0.5.

## Results

```
Shortline eval  seed=20260907  weeks=10000 per configuration  frame=36 sites (3 regions x chain/independent x 6)  panel=3 per stratum
Mix: nonresponse 25.3% (refused, voicemail, no_answer, ivr_dead_end, null_result); usable answers agree with the site's true state; fabricated in_stock quote at rate r for out-of-stock sites

(a) 95% interval coverage of the true finite-population share, per-week availability probability ~ U(0.15, 0.95), r = 0
branch          coverage    weeks       mean width
stratified      96.5%       3976        0.349
pooled_wilson   98.3%       6024        0.424
overall         97.6%       10000       0.394
weeks with no estimate: 0

(b) shortage declarations, line 0.5, minUsable 6, r = 0 (exactly k of 36 sites available each week)
true share      upper-bound rule    naive point rule    reading
20/36 = 0.556   0.4%                27.2%               false-shortage rate
16/36 = 0.444   3.8%                65.3%               detection rate

(c) mean bias of the point estimate (p_hat - truth) at true share 0.5, evidence gate on (classifyRecipient) versus off (schema-valid answers only)
r       gated bias      ungated bias    gated mean usable   ungated mean usable
0.0     -0.0009         -0.0009         13.44               13.44
0.1     0.0287          0.0518          12.77               13.45
0.2     0.0573          0.0997          12.13               13.45
```

## Interpretation

Both branches reach nominal coverage or better (96.5% stratified, 98.3% pooled, 97.6% overall), and the pooled Wilson branch decided 60% of weeks: with a panel of 3 and 25% nonresponse, any stratum that lands on exactly one usable answer forces the fallback, so at this scale the index is mostly a pooled interval over about 13 answers and the stratified design contributes little. The upper-bound rule raised a false shortage in 0.4% of weeks at a true share of 0.556 against 27.2% for the naive point rule, and paid for it with a detection rate of 3.8% at 0.444 against 65.3%, which quantifies the sensitivity-for-precision trade `docs/statistics.md` promises: a shortage this mild is invisible to the rule at this panel size, and only a larger panel narrows the interval enough to see it. The evidence gate roughly halves the bias from fabricated in-stock quotes (0.029 against 0.052 at r = 0.1, 0.057 against 0.100 at r = 0.2) without removing it, because every dropped observation comes from an out-of-stock site and so becomes informative nonresponse; the residual bias belongs to the sampling design rather than to the gate.
