# Safety contract for shortline-find

- **Modes.** Dry-run is the default and places no calls. Live mode requires `SHORTLINE_MODE=live`, `CALLE_API_KEY`, and `SHORTLINE_LIVE_ACK` set to the exact acknowledgement phrase. The agent must tell the user which mode is active before planning.
- **Intent.** A call is placed only by `shortline_run_find` with `confirm: true` (or the CLI with `--yes`). There is no configuration that removes the confirmation.
- **Callees.** Pharmacies on business lines, inside their local calling window, at most once per product per cooldown, never after a "don't call again".
- **Disclosure.** Every call opens by stating that it is an automated assistant and names the project.
- **No commitments.** The assistant does not order, reserve, pay, or negotiate. With `ask_hold`, a "yes" is recorded as `hold_response: offered`, a stated intention.
- **No cancellation.** An accepted wave cannot be recalled. Waves are small (default three recipients) and sequential.
- **Boundaries.** No medical, legal, or financial advice; no patient information; not for emergencies.
- **Data.** Phone numbers are masked in every output. Transcripts are retained masked for a bounded period for evidence and then purged.
- **Ambiguity.** `needs_human` means a binding or evidence check failed. Show the note, stop, and let a person reconcile.
