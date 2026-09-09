---
name: shortline-find
description: Find which pharmacies can dispense a product today, or read the weekly availability index for a shortage drug, by running Shortline sourcing waves over CALL-E. Use when a user asks where a medication is in stock nearby, whether a drug is in shortage in a region, or wants a pharmacy called about availability. Plans without calling; places calls only after the user approves the plan.
---

# Shortline: find a product by phone, or read its availability index

Shortline is a runnable app (`apps/typescript/shortline` in the awesome-phone-call-agents repository, or the root of github.com/rikhinkavuru/shortline) that treats CALL-E calls as measurements. This skill drives it through its MCP server or CLI. It never dials on its own.

## When to use

- "Where can I get amoxicillin suspension near San Francisco today?"
- "Is albuterol in shortage in the East Bay this week?"
- "Call three pharmacies and tell me who has it."

## When not to use

- Any acute or emergency situation. Tell the user to contact emergency services or a poison control line; do not start calls.
- Anything requiring a patient's identity, prescription details, or a diagnosis. Shortline asks about stock of a named product and nothing else.
- Calling an individual. Shortline calls pharmacies on their business lines only.
- Ordering, reserving, or paying. A "hold" answer is a stated intention, not a reservation.

## Workflow

1. **Connect.** Start the MCP server over stdio with `node /absolute/path/to/bin/shortline.mjs mcp` (never through `npm run`, whose banner corrupts the JSON-RPC stream), or use the CLI. In dry-run mode (the default) every call is simulated; say so to the user.
2. **Check the index first.** Call `shortline_watch_status` (or `shortline estimate`). If the region already shows `available` with a fresh estimate, the user may not need calls at all.
3. **Plan, never dial.** Call `shortline_plan_find` with the watch or product, the region, and how many confirmed sources are needed (default 2). Show the user:
   - known sources from monitoring in the last 24 hours (no call needed);
   - the ranked candidates with **masked** numbers, the calls the first wave places (`first_wave_calls`) and the most the request could place (`max_calls`);
   - the mode (dry-run or live) and that live calls cost money and cannot be recalled.
4. **Wait for explicit approval.** Only after the user says to place the calls, call `shortline_run_find` with `confirm: true`. Do not set `ignore_calling_window` in live mode.
5. **Report with evidence.** Read `shortline_get_find`. For each confirmed source give the name, masked number, outcome (in stock / limited), the evidence quote, restock note, and hold response if asked. List attempts that were not counted with their reason. Never upgrade "unknown", "voicemail", or "refused" into a "no".

## Rules

- Never guess a phone number, region, or timezone. Sites come from the operator's list; the agent never types, repairs, or adds a number and never adds a site.
- Never ask for, print, or store `CALLE_API_KEY` or `SHORTLINE_AUTH_TOKEN`; the app reads them from its own environment.
- Never create a schedule. Weekly sweeps belong to the operator's cron; a sourcing request is one bounded run.
- Never place a call without the user's approval of the specific plan.
- Never run more than one sourcing request at a time for the same product and region.
- Mask every phone number in what you show or store.
- If `shortline_run_find` returns `needs_human`, stop and show the note; do not re-run.

See `references/mcp-tools.md` for tool contracts and `references/safety.md` for the full side-effect contract.
