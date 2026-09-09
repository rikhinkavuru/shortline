# Shortline dashboard rebuild: specification

Source: product owner brief, 2026-09-09. Adaptations for this codebase are marked **[codebase]**.

**[codebase] Stack and constraints.** The project is vanilla TypeScript on the server and plain HTML/CSS/ES-module JavaScript on the client, served by Hono from `src/server/ui/` with no build step. Keep that: `index.html`, `styles.css`, `app.js` at those paths (the server serves them at `/`, `/styles.css`, `/app.js`), plus any extra modules or assets under `src/server/ui/` served at `/ui/<file>` (js, mjs, css, svg, png, woff2, json). No frameworks, no Tailwind, no bundler, no npm UI dependencies; Google Fonts only as an external resource; icons as inline SVG in lucide style. "Components" are small render functions in a `components.js` module. Sample fallback data lives in `sample-state.js` and is used only when `GET /api/state` fails. **No reference image was attached**; follow the token and layout description below literally. The product name stays **Shortline**; tagline stays one line. The greeting uses `state.operatorName` when present ("Good morning, Maya"), otherwise just the time-of-day greeting; time of day comes from `state.localNow` (site zone), not the browser clock.

**[codebase] Behaviour parity.** `docs/design/legacy-app.js` is the previous client. Every interaction in it must survive, byte-for-byte in its API contract:

- `GET /api/state?watch=<id>`; re-fetch after every successful mutation and (debounced 350 ms) after every SSE event.
- `GET /api/events` SSE with events `hello`, `app`, `ping`; feed rows built from `app` events; de-duplicate `call_event` rows by `eventId` and estimate rows by (week, signal, pHat); on load, seed the feed from `state.events`.
- `POST /api/sweeps/run` `{watchId, force}` where `force` is the ignore-calling-hours toggle; show the returned `summary` as a notice.
- `POST /api/find/plan` with `{watchId, region, need, waveSize, askHold, ignoreWindow, onlySiteIds[]}`; render the preview (`knownSources`, `candidates`, `skipped`, `firstWaveCalls`, `maxCalls`).
- `POST /api/find/:id/run` with `{confirm: true, ignoreWindow, plan: <the exact plan inputs>}`; if the response has `replanned: true`, show the notice "The plan had expired on this server and was re-planned from the same inputs before running."
- `POST /api/find/:id/discard`.
- `POST /api/sites/:id/opt-out` `{optOut, reason: "dashboard"}`; a 409 with `error: "callee_opt_out"` must be shown as a notice, never retried.
- `GET /api/transcript?dispatch=&recipient=` for the dialog; observations with `transcriptTurns === 0` show "No conversation: the call was not answered" without fetching; a 404 shows "Transcript not retained".
- Every button handler: disable while running, surface every failure in `#notices`, re-enable in `finally`.
- All data is escaped before insertion into HTML. Never build HTML from unescaped API strings.
- The ignore-calling-hours control is rendered only when `state.mode !== "live"`, and the `force`/`ignoreWindow` flags read `false` when it is absent.
- The window hint text is built from `state.localNow` (`hhmm`, `isoWeekday`, `timezone`) and `state.window` (`start`, `end`, `days`).

**[codebase] State shape.** Read `src/server/state.ts` for the exact JSON. Sample: `https://shortline-rikhinkavuru-9840s-projects.vercel.app/api/state`.

---

Build a polished, responsive, single-page “availability watch” operations dashboard. Adapt a modern fintech-dashboard layout language (centered pale app shell, compact pill navigation, rounded white cards, an icon rail) to this pharmacy/product-availability calling workflow. Implement the actual UI and interactions, not a static mockup.

## Data and safety requirements

- `GET /api/state` returns the exact JSON shape to render. Fetch it on load and use it as the canonical state source. A small typed adapter is fine; do not invent a competing data model.
- Realistic fallback/loading/error states only when the endpoint is unavailable.
- All phone numbers are already masked server-side. Render values exactly as received; never derive, reveal, transform, concatenate, or unmask a phone number.
- One page. No separate routes for sections.
- At a 390px viewport, no horizontal page scroll. The strata table may scroll horizontally only inside its own clearly bounded container.
- Use the ID map below exactly.
- Semantic HTML, keyboard-accessible controls, focus states, visible labels, dialog focus trapping and restoration.
- Respect reduced-motion preferences.
- All dates/times/time zones data-driven; no hard-coded current date except in clearly labelled sample fallback data.

## Product framing and page hierarchy

A watch-and-sweep dashboard for finding a product at monitored sites while respecting calling windows and site courtesy limits.

Wordmark upper left: “Shortline”, with a one-line tagline such as “Availability intelligence, with calls made courteously.”

Visual language:
- Soft warm-gray outer page background, approximately `#f3f3f1`.
- A large white/off-white application shell with generous rounded corners, subtle low-contrast border, and a soft diffuse shadow.
- Compact, refined desktop layout with high information density but plenty of breathing room.
- White cards on a slightly warm canvas, 14–18px corner radii, hairline borders, restrained shadows.
- Dark ink text rather than pure black; muted secondary labels; near-white section wells.
- One strong coral/orange accent for the primary action and key active metric. Do not turn the whole UI orange.
- Blue for neutral workflow/state information; distinct semantic colors for outcomes.
- Typography clean and humanist: Inter or Manrope. Page heading 28–34px on desktop, card headings 15–17px, compact labels 11–13px.
- Lucide-style line icons as inline SVG; no emoji as UI icons.
- Controls tactile and compact: pill tabs, softly filled buttons, circular icon buttons, segmented nav, slim dividers.

## Layout

Desktop:
1. A centered app shell approximately 1080–1200px wide.
2. Top bar: left wordmark + tagline; center pill-style anchors Overview, Sweep, Find now, Sites; right: live-updates state, prominent mode badge, watch selector, ignore-calling-hours switch (dry-run only).
3. A slim vertical icon rail inside the shell on desktop: anchors to Overview, Sweep, Find, Sites, Help. Active icon in a dark rounded square. Tooltips. Not the only way to navigate.
4. Main content begins with a light operational heading (“Good morning, Maya” when an operator name is known) and one concise status sentence built from state (current signal, week, mode).
5. First row: Availability Index card (about two columns) with the four metric tiles beside it and the chart; keep a balanced card rhythm.
6. Below: This Week’s Sweep and Find It Now as large cards; Sites & Courtesy beneath or alongside depending on width.
7. Internal card padding 24px on desktop, compact table rows, quiet dividers.

Small widths:
- At 390px collapse the rail into the top anchors.
- Stack every major card into one column.
- Header controls wrap intentionally.
- Metric grid becomes 2×2.
- Feed metadata wraps below the primary row title.
- Horizontal control groups wrap or stack.
- The only horizontal overflow allowed is within `#strata-table-scroll`.

## Global header and status

- `#app-wordmark`, `#app-tagline` (one line).
- `#watch-selector`: labelled selector; paused watches show a visible “Paused” text state.
- `#mode-badge`: always visible: “DRY RUN · no calls” (blue/indigo, simulation icon) or “LIVE · real calls” (coral/red, phone icon). Exact text always present.
- `#ignore-calling-hours`: labelled switch “Ignore calling hours”, rendered only in dry-run.
- `#live-updates-indicator`: dot plus exact text “Live updates connected” / “Reconnecting” / “Updates offline”, driven by the SSE lifecycle.
- `#notices`: aria-live region for transient notices with icon, message, timestamp, close control.

## Panel A: Availability Index (`#availability-index-panel`)

- `#availability-signal-chip`: Available / Strained / Shortage / Insufficient data, distinct treatment and icon. If the current week has insufficient data, keep the last trustworthy signal and append “W37: not enough data yet” (week from data).
- `#availability-chart`: real SVG that resizes; weekly points; 95% band; dashed threshold line labelled exactly `upper bound < 50%` (threshold from data); hollow markers for insufficient-data weeks; `SIMULATED HISTORY` label when any week is simulated; readable axes; tooltip per point (week, estimate, interval, n, simulated/insufficient flags); accessible text summary.
- `#availability-metrics` with `#metric-estimate` (estimate and `95% CI a–b`), `#metric-wow-delta` (directional icon), `#metric-response-rate` (`usable / asked · rate`, or `W37 in progress: N usable of 6 needed` when the current week is incomplete), `#metric-method` (`Stratified` or `Pooled Wilson`, info tooltip in plain language, coverage, `n_eff`).
- `#strata-table-scroll` wrapping `#strata-table`: columns Stratum, Frame, Asked, Usable, Available (`(n ltd)`), Estimate (bar + interval). Empty strata say why (“no usable observation”).

## Panel B: This Week’s Sweep (`#weekly-sweep-panel`)

- `#run-sweep-now`: primary coral button “Run sweep now”; progress state; no duplicate submissions.
- `#sweep-pills`: labelled pills: week, planned, dispatched, verified, waiting for window, in flight, needs human, status, undersampled strata.
- `#calling-window-hint` when nothing dispatched because of the window. Dry run: `It is 18:46 Tue in America/Los_Angeles; calls go out 10:00–17:00 local, Mon–Sat. Tick Ignore calling hours to simulate now.` Live: same sentence ending `The next run inside the window will dial.` Values from data.
- `#sweep-feed`: newest first; time, type icon/accent, primary description, supporting details. Row types: dispatch state (reserved, accepted by CALL-E with call id, verifying, verified, needs human with note); observation (outcome chip, optional `not counted` chip with reason, site, evidence quote, `#transcript-button-{id}`); CALL-E event (“CALL-E event · dialing”, “CALL-E event · completed”, call id); estimate; find status; sweep status; notice. Call ids monospaced and quiet.

## Panel C: Find It Now (`#find-now-panel`)

- `#find-now-form`: `#find-region`, `#find-sources-needed`, `#find-wave-size`, `#find-only-sites` (“Only these sites”, site ids), `#find-hold-today` (“Ask to hold one fill for pickup today”).
- `#find-plan-preview`: known sources (“No call needed”, quote, age); candidates (name, masked number, basis `unknown` / `observed in stock`, distance); skipped (site, reason); eligibility hint when none eligible; `#confirm-find-plan` reading exactly `Place 1 real call now, up to 3 in total` (live) or `Simulate 1 call now, up to 3 in total` (dry run) with numbers from data; `#discard-find-plan` “Discard”.
- `#find-request-list`: cards with product · region; `#request-status-{id}`: Found / Calling… / No source found after N waves / Stopped, needs a human look: reason / Discarded; need, confirmed, called, time; confirmed sources (name, masked number, outcome chip, hold offered chip, quote, next delivery, provenance `from monitoring` or `this request`, age); attempts as chips (wave, site, outcome, reason if not counted, transcript button).

## Panel D: Sites & Courtesy (`#sites-courtesy-panel`)

- Monitored count and opted-out count.
- `#sites-table`: name (with `test line` tag), stratum, masked number, last outcome chip + age, calls in last 30 days, `#site-action-{siteId}`: `opt out` / `opt back in` / `asked not to be called` (no undo offered, visibly explained).

## Transcript dialog (`#transcript-dialog`, `#transcript-turns`)

- Accessible modal: close button, Escape, focus trap, focus restoration.
- Title: site, outcome, reason. Turns: speaker (agent / pharmacy), offset seconds, text. Highlight the evidence turn with a soft yellow/orange contextual highlight and an “Evidence” label.
- Empty states: `No conversation: the call was not answered` / `Transcript not retained`.

## Outcome-chip system

Reusable chip with label, icon/shape, and color (never color alone), 24–28px tall, sentence case, readable in grayscale: in stock (green), limited (amber), out of stock (rose), refused (plum), unknown (gray), voicemail (indigo), menu dead end (slate), not reached (blue-gray), unreachable (charcoal), not counted (outlined warm gray, always with a reason nearby), state (blue neutral pill).

## Tokens

Canvas `#F3F3F1`; shell/card `#FFFFFF` / `#FCFCFB`; inset `#F7F7F5`; ink `#1E1E1A`; muted `#74736D`; hairline `#ECEBE7`; coral `#FF643F`; blue `#3C78D8`; success `#1F9D69`; warning `#C98918`; danger `#D84D57`; radii 16px cards, 12px inputs, pill tags; soft diffuse shadow; 24px card padding desktop, 14–18px grid gaps.

## Reusable render functions

AppShell, TopBar, SideRail, SectionCard, MetricTile, StatusPill, OutcomeChip, IconButton, PrimaryButton, SecondaryButton, Notice, DataTable, ActivityFeedItem, Tooltip, EmptyState, TranscriptDialog.

## Stable element-ID map

`app-shell`, `app-wordmark`, `app-tagline`, `watch-selector`, `mode-badge`, `ignore-calling-hours`, `live-updates-indicator`, `notices`, `availability-index-panel`, `availability-signal-chip`, `availability-chart`, `availability-metrics`, `metric-estimate`, `metric-wow-delta`, `metric-response-rate`, `metric-method`, `strata-table-scroll`, `strata-table`, `weekly-sweep-panel`, `run-sweep-now`, `sweep-pills`, `calling-window-hint`, `sweep-feed`, `find-now-panel`, `find-now-form`, `find-region`, `find-sources-needed`, `find-wave-size`, `find-only-sites`, `find-hold-today`, `find-plan-preview`, `confirm-find-plan`, `discard-find-plan`, `find-request-list`, `sites-courtesy-panel`, `sites-table`, `transcript-dialog`, `transcript-turns`; dynamic `transcript-button-{id}`, `request-status-{id}`, `site-action-{siteId}`.

## Acceptance checks

- Verify at 1440, 1024, 768, 390 px. No horizontal page overflow at 390. Only the strata container scrolls horizontally.
- Dry-run and live cannot be confused. Ignore calling hours only appears in dry-run. Every phone number stays masked.
- All data states, empty states, notices, chips, tooltips, transcript conditions, and courtesy actions render from API data.
- Sample fallback data exercises: an insufficient current week, simulated history, a limited stratum, a paused watch, a calling-window delay, a not-counted observation, a CALL-E event, a found request, a human-needed request, an opted-out site, and a callee opt-out.
- No lorem ipsum, no financial language, no leftover balance/card/transaction UI.
