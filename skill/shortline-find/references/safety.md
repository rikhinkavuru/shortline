# Safety contract for shortline-find

- **Modes.** Dry-run is the default and places no calls. Live mode requires `SHORTLINE_MODE=live`, `CALLE_API_KEY`, and `SHORTLINE_LIVE_ACK` set to the exact acknowledgement phrase. The agent must tell the user which mode is active before planning.
- **Intent.** A call is placed only by `shortline_run_find` with `confirm: true` (or the CLI with `--yes`). There is no configuration that removes the confirmation.
- **Callees.** Pharmacies on business lines, inside their local calling window, at most once per product per cooldown, never after a "don't call again".
- **Disclosure.** Every call opens by stating that it is an automated assistant and names the project.
- **No commitments.** The assistant does not order, reserve, pay, or negotiate. With `ask_hold`, a "yes" is recorded as `hold_response: offered`, a stated intention.
- **No cancellation.** An accepted wave cannot be recalled. Waves are small (default three recipients) and sequential.
- **Boundaries.** No medical, legal, or financial advice; no patient information; not for emergencies.
- **Data.** Phone numbers are masked in every output. Transcripts are retained masked for a bounded period for evidence and then purged.
- **Numbers.** Every number is validated as E.164 by the app (`assertE164`). The agent never types, repairs, or guesses a number and never adds a site; sites come from the operator's list.
- **Credentials.** `CALLE_API_KEY` and `SHORTLINE_AUTH_TOKEN` are read by the app from its environment only. The agent never asks for them, prints them, or stores them.
- **No schedules.** The skill creates no recurring job. Weekly sweeps are the operator's cron; a sourcing request is one bounded run that ends at `met`, `exhausted`, `stopped`, or `needs_human`.
- **Calling hours.** `ignore_calling_window` is a dry-run convenience; in live mode the app refuses it and the agent must not retry with it.
- **Ambiguity.** `needs_human` means a binding or evidence check failed; the response carries the halt note. Show it, stop, and let a person reconcile.
