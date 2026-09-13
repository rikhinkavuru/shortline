// Small render functions returning HTML strings. Plain-string arguments are
// escaped here; arguments whose names end in `Html` are trusted markup that a
// component already produced. Nothing from the API is ever passed as Html.

import { icon } from "/ui/icons.js";
import { esc, humanOutcome, humanReason, humanSignal } from "/ui/format.js";

let tipSeq = 0;

export function AppShell({ sidebarHtml, topBarHtml, mainHtml, railHtml, footerHtml = "" }) {
  return `<div class="shell" id="app-shell">
    ${sidebarHtml}
    <div class="workspace">
      ${topBarHtml}
      <div class="work-body">
        <main class="main" id="main" tabindex="-1">${mainHtml}</main>
        <aside class="rail" aria-label="Live activity">${railHtml}</aside>
      </div>
      ${footerHtml}
    </div>
  </div>`;
}

export function Sidebar({ wordmark, tagline, nav, watchHtml, footHtml }) {
  const links = nav
    .map(
      (n) => `<a class="nav-item" href="#${esc(n.target)}" data-nav="${esc(n.target)}">
        <span class="nav-icon" aria-hidden="true">${icon(n.icon, { size: 17 })}</span>
        <span class="nav-label">${esc(n.label)}</span>
        ${n.count ? `<span class="nav-count" data-count="${esc(n.target)}"></span>` : ""}
      </a>`
    )
    .join("");
  return `<div class="sidebar">
    <a class="brand" id="app-wordmark" href="#overview">
      <span class="brand-mark" aria-hidden="true">${icon("radio", { size: 17 })}</span>
      <span class="brand-text"><b>${esc(wordmark)}</b><span class="tagline" id="app-tagline">${esc(tagline)}</span></span>
    </a>
    <nav class="nav" aria-label="Sections">${links}</nav>
    <div class="side-block">
      <p class="side-label">Watching</p>
      ${watchHtml}
    </div>
    <div class="side-foot">${footHtml}</div>
  </div>`;
}

export function PageBar({ titleHtml, rightHtml }) {
  return `<header class="topbar">
    <div class="page-title">${titleHtml}</div>
    <div class="topbar-right" id="topbar-controls">${rightHtml}</div>
  </header>`;
}

export function SectionCard({ id, title, icon: name = "", subtitle = "", headActionsHtml = "", bodyHtml, cls = "" }) {
  const titleId = `${id}-title`;
  return `<section class="card ${esc(cls)}" id="${esc(id)}" aria-labelledby="${titleId}">
    <div class="card-head">
      <div class="card-title-wrap">
        <h2 class="card-title" id="${titleId}">${esc(title)}</h2>
        ${subtitle ? `<p class="card-sub">${esc(subtitle)}</p>` : ""}
      </div>
      ${headActionsHtml ? `<div class="card-actions">${headActionsHtml}</div>` : ""}
    </div>
    <div class="card-body">${bodyHtml}</div>
  </section>`;
}

/** `srJoin` is visually hidden text placed between label and value so the DOM text reads as one sentence. */
export function MetricTile({ id, label, valueHtml, sub = "", subHtml = "", icon: name = "", tone = "", tooltipHtml = "", title = "", srJoin = "" }) {
  return `<div class="metric ${esc(tone)}" id="${esc(id)}"${title ? ` title="${esc(title)}"` : ""}>
    <div class="metric-k"><span>${esc(label)}</span>${srJoin ? `<span class="sr-only">${esc(srJoin)}</span>` : ""}${tooltipHtml}</div>
    <div class="metric-v">${valueHtml}</div>
    ${subHtml ? `<div class="metric-s">${subHtml}</div>` : sub ? `<div class="metric-s">${esc(sub)}</div>` : ""}
  </div>`;
}

export function StatusPill({ label, value, tone = "", muted = false }) {
  return `<div class="stat ${esc(tone)}${muted ? " muted" : ""}"><span class="stat-k">${esc(label)}</span><b class="stat-v">${esc(value)}</b></div>`;
}

const OUTCOME_STYLE = {
  in_stock: { tone: "in_stock", icon: "package-check" },
  limited: { tone: "limited", icon: "package" },
  out_of_stock: { tone: "out_of_stock", icon: "package-x" },
  not_carried: { tone: "not_carried", icon: "ban" },
  refused: { tone: "refused", icon: "hand" },
  unknown: { tone: "unknown", icon: "circle-dashed" },
  voicemail: { tone: "voicemail", icon: "voicemail" },
  ivr_dead_end: { tone: "ivr_dead_end", icon: "menu" },
  not_reached: { tone: "not_reached", icon: "phone-missed" },
  unreachable: { tone: "unreachable", icon: "wifi-off" }
};

/** Outcome chip: label + icon + colour, never colour alone. */
export function OutcomeChip(outcome, { small = false } = {}) {
  const st = OUTCOME_STYLE[outcome] ?? { tone: "unknown", icon: "circle-dashed" };
  return `<span class="chip oc ${esc(st.tone)}${small ? " sm" : ""}" data-shape="${esc(st.icon)}">${esc(humanOutcome(outcome))}</span>`;
}

export function NotCountedChip(reason, { small = false } = {}) {
  return `<span class="chip oc not_counted${small ? " sm" : ""}" title="${esc(humanReason(reason))}">not counted</span>`;
}

/** Neutral blue "state" pill for workflow states (dispatch, find, sweep, CALL-E events). */
export function StateChip(label, { small = false, icon: name = "" } = {}) {
  return `<span class="chip oc state${small ? " sm" : ""}">${esc(label)}</span>`;
}

export function HoldChip() {
  return `<span class="chip oc hold sm">hold offered</span>`;
}

const SIGNAL_ICON = { available: "check-circle", strained: "alert-triangle", shortage: "x-circle", insufficient_data: "circle-dashed" };

export function SignalChip(signal, { suffix = "", id = "", large = false } = {}) {
  const s = SIGNAL_ICON[signal] ? signal : "insufficient_data";
  return `<span class="chip signal ${esc(s)}${large ? " lg" : ""}"${id ? ` id="${esc(id)}"` : ""}>${icon(SIGNAL_ICON[s], { size: large ? 15 : 13 })}<span>${esc(humanSignal(signal))}</span>${suffix ? `<span class="chip-suffix"><span class="chip-sep" aria-hidden="true">·</span>${esc(suffix)}</span>` : ""}</span>`;
}

export function Tag(text, tone = "") {
  return `<span class="tag ${esc(tone)}">${esc(text)}</span>`;
}

export function PrimaryButton({ id = "", label, icon: name = "", type = "button", danger = false, disabled = false, attrs = "" }) {
  return `<button class="btn btn-primary${danger ? " btn-danger" : ""}" type="${esc(type)}"${id ? ` id="${esc(id)}"` : ""}${disabled ? " disabled" : ""} ${attrs}><span class="btn-spinner" aria-hidden="true">${icon("loader", { size: 14 })}</span>${name ? icon(name, { size: 15 }) : ""}<span class="btn-label">${esc(label)}</span></button>`;
}

export function SecondaryButton({ id = "", label, icon: name = "", type = "button", disabled = false, attrs = "", small = false }) {
  return `<button class="btn btn-secondary${small ? " btn-sm" : ""}" type="${esc(type)}"${id ? ` id="${esc(id)}"` : ""}${disabled ? " disabled" : ""} ${attrs}><span class="btn-spinner" aria-hidden="true">${icon("loader", { size: 14 })}</span>${name ? icon(name, { size: 14 }) : ""}<span class="btn-label">${esc(label)}</span></button>`;
}

export function LinkButton({ id = "", label, icon: name = "", attrs = "" }) {
  return `<button class="btn btn-link" type="button"${id ? ` id="${esc(id)}"` : ""} ${attrs}><span class="btn-spinner" aria-hidden="true">${icon("loader", { size: 12 })}</span>${name ? icon(name, { size: 13 }) : ""}<span class="btn-label">${esc(label)}</span></button>`;
}

export function IconButton({ id = "", icon: name, label, attrs = "", cls = "" }) {
  return `<button class="icon-btn ${esc(cls)}" type="button"${id ? ` id="${esc(id)}"` : ""} aria-label="${esc(label)}" title="${esc(label)}" ${attrs}>${icon(name, { size: 16 })}</button>`;
}

const NOTICE_ICON = { info: "info", success: "check-circle", warn: "alert-triangle", error: "alert-circle" };

export function Notice({ id, level = "info", message, atText }) {
  return `<div class="notice ${esc(level)}" data-notice="${esc(id)}">
    <span class="notice-icon">${icon(NOTICE_ICON[level] ?? "info", { size: 16 })}</span>
    <div class="notice-body"><p class="notice-msg">${esc(message)}</p><time class="notice-at">${esc(atText)}</time></div>
    ${IconButton({ icon: "x", label: "Dismiss notice", attrs: `data-dismiss="${esc(id)}"`, cls: "notice-close" })}
  </div>`;
}

/** Table with data-label attributes so rows can stack on narrow screens. */
export function DataTable({ id, columns, rows, cls = "", emptyHtml = "", caption = "" }) {
  // Explicit table roles survive the display:block stacking used on narrow screens.
  const head = columns.map((c) => `<th scope="col" role="columnheader"${c.align ? ` class="${esc(c.align)}"` : ""}${c.title ? ` title="${esc(c.title)}"` : ""}>${c.sr ? `<span class="sr-only">${esc(c.label)}</span>` : esc(c.label)}</th>`).join("");
  const body = rows.length
    ? rows
        .map((r) => `<tr role="row"${r.cls ? ` class="${esc(r.cls)}"` : ""}>${r.cells.map((cell, i) => `<td role="cell" data-label="${esc(columns[i]?.label ?? "")}"${columns[i]?.align ? ` class="${esc(columns[i].align)}"` : ""}>${cell}</td>`).join("")}</tr>`)
        .join("")
    : `<tr role="row" class="empty-row"><td role="cell" colspan="${columns.length}">${emptyHtml}</td></tr>`;
  return `<table class="table ${esc(cls)}" id="${esc(id)}" role="table">${caption ? `<caption class="sr-only">${esc(caption)}</caption>` : ""}<thead role="rowgroup"><tr role="row">${head}</tr></thead><tbody role="rowgroup">${body}</tbody></table>`;
}

const FEED_ICON = { dispatch: "send", observation: "phone", call_event: "message-square", estimate: "bar-chart", find: "search", sweep: "radar", notice: "bell" };

export function ActivityFeedItem({ type, timeText, timeTitle, timeIso = "", primaryHtml, detailsHtml = "", tone = "" }) {
  return `<li class="feed-item ${esc(type)} ${esc(tone)}">
    <time class="feed-time"${timeIso ? ` datetime="${esc(timeIso)}"` : ""} title="${esc(timeTitle)}">${esc(timeText)}<span class="sr-only"> ${esc(timeTitle)}</span></time>
    <span class="feed-icon" aria-hidden="true">${icon(FEED_ICON[type] ?? "activity", { size: 14 })}</span>
    <div class="feed-main"><div class="feed-primary">${primaryHtml}</div>${detailsHtml ? `<div class="feed-details">${detailsHtml}</div>` : ""}</div>
  </li>`;
}

/** Info tooltip: a small button that reveals a bubble on hover, focus, or tap (toggle wired in app.js). */
export function Tooltip({ text, label = "More information", id = "" }) {
  id = id || `tip-${++tipSeq}`;
  return `<span class="tip"><button type="button" class="tip-trigger" id="${id}-trigger" aria-label="${esc(label)}" aria-describedby="${id}" aria-expanded="false">${icon("info", { size: 13 })}</button><span class="tip-bubble" role="tooltip" id="${id}">${esc(text)}</span></span>`;
}

export function EmptyState({ icon: name = "circle-dashed", title, hint = "", compact = false }) {
  return `<div class="empty${compact ? " compact" : ""}">${icon(name, { size: compact ? 16 : 22 })}<div><p class="empty-title">${esc(title)}</p>${hint ? `<p class="empty-hint">${esc(hint)}</p>` : ""}</div></div>`;
}

export function Skeleton(lines = 3) {
  return `<div class="skeleton" aria-hidden="true">${Array.from({ length: lines }, (_, i) => `<span class="sk-line" style="width:${[92, 68, 80, 55][i % 4]}%"></span>`).join("")}</div>`;
}

export function TranscriptDialog() {
  return `<dialog class="dialog" id="transcript-dialog" aria-labelledby="transcript-title" aria-describedby="transcript-sub">
    <div class="dialog-head">
      <div><h3 class="dialog-title" id="transcript-title">Transcript</h3><p class="dialog-sub" id="transcript-sub"></p></div>
      ${IconButton({ id: "transcript-close", icon: "x", label: "Close transcript" })}
    </div>
    <div class="transcript" id="transcript-turns" tabindex="0" role="region" aria-label="Transcript" aria-live="polite"></div>
  </dialog>`;
}

export function TranscriptTurn({ speaker, offsetSeconds, text, evidence = false }) {
  const who = speaker === "bot" ? "agent" : speaker === "user" ? "pharmacy" : "other";
  return `<div class="turn ${esc(who)}${evidence ? " evidence" : ""}">
    <div class="turn-meta"><span class="turn-who">${icon(who === "agent" ? "bot" : "store", { size: 13 })}${esc(who)}</span><span class="turn-off mono">${esc(offsetSeconds)}s</span>${evidence ? `<span class="turn-evidence">${icon("quote", { size: 11 })}Evidence</span>` : ""}</div>
    <p class="turn-text">${esc(text)}</p>
  </div>`;
}

export function Mono(text) {
  return `<span class="mono">${esc(text)}</span>`;
}

export function Quote(text) {
  return `<span class="quote">${icon("quote", { size: 11 })}<span>${esc(text)}</span></span>`;
}
