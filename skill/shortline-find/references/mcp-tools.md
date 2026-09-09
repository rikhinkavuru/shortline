# Shortline MCP tools

Start: `node /absolute/path/to/bin/shortline.mjs mcp` (stdio). Set `SHORTLINE_DB` to the same database the dashboard and CLI use. Example client entry:

```json
{ "mcpServers": { "shortline": { "command": "node", "args": ["/absolute/path/to/shortline/bin/shortline.mjs", "mcp"], "env": { "SHORTLINE_DB": "/absolute/path/to/shortline/data/shortline.sqlite" } } } }
```

Do not launch it through `npm run mcp`: npm prints a banner on stdout that corrupts the JSON-RPC stream.

| Tool | Places calls | Inputs | Returns |
| --- | --- | --- | --- |
| `shortline_watch_status` | no | `watch_id?` | latest estimate with interval, coverage, response rate, signal, and up to eight weeks of history; or all watches |
| `shortline_list_sites` | no | `region?` | sites with masked numbers, last outcome, opt-out state |
| `shortline_plan_find` | no | `watch_id?`, `product?`, `region`, `need?`, `wave_size?`, `max_waves?`, `ask_hold?`, `near?`, `only_site_ids?` | `find_request_id`, known sources, ranked candidates (masked), skipped sites with reasons, `first_wave_calls`, `max_calls` |
| `shortline_run_find` | **yes** | `find_request_id`, `confirm` (must be true), `ignore_calling_window?` (dry-run only) | final request with confirmed sources and every attempt |
| `shortline_get_find` | no | `find_request_id` | current state of a request |

Annotations: the read tools are `readOnlyHint: true`; `shortline_run_find` is `destructiveHint: true, openWorldHint: true`.

`shortline_run_find` blocks until the request finishes (waves complete one at a time). In live mode a wave of three takes a few minutes. Skip reasons you may see in `skipped`: `opted_out`, `does_not_carry`, `wrong_number`, `call_in_flight`, `outside_calling_window`, `called_in_last_24h`, `observed_out_of_stock_recently`.

## CLI equivalents

```bash
shortline estimate --watch amoxicillin-susp
shortline find --watch amoxicillin-susp --region US-CA-SF --need 2          # plan only
shortline find --watch amoxicillin-susp --region US-CA-SF --need 2 --yes    # plan and place
shortline find-run --id fnd_...                                              # run an existing plan
```

All output masks phone numbers. Add `--json` for machine-readable output.
