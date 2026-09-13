// Shortline dashboard client. One page, no build step. State comes from
// GET /api/state; every mutation re-fetches it; SSE events feed the activity
// list and trigger a debounced refresh. See docs/design/dashboard-spec.md.

import { icon } from "/ui/icons.js";
import * as F from "/ui/format.js";
import * as C from "/ui/components.js";
import { renderChart } from "/ui/chart.js";
import { SAMPLE_STATE } from "/ui/sample-state.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = F.esc;

const state = {
  data: null,
  watchId: null,
  preview: null,
  planInputs: null,
  feed: [],
  seenEvents: new Set(),
  fallback: false,
  live: "offline",
  noticeSeq: 0,
  lastOpener: null,
  lastOpenerId: "",
  noticeReturn: null
};

const NAV = [
  { target: "overview", label: "Availability", icon: "activity" },
  { target: "weekly-sweep-panel", label: "This week\u2019s sweep", icon: "radar", count: true },
  { target: "find-now-panel", label: "Find it now", icon: "search" },
  { target: "sites-courtesy-panel", label: "Sites", icon: "building" },
  { target: "help-panel", label: "How it works", icon: "help-circle" }
];

/* ------------------------------------------------------------------ API */

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error ? `${body.error}${body.reason ? `: ${body.reason}` : ""}` : `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/** Wrap a button handler: disable while running, surface every failure in #notices, re-enable always. */
function guarded(btn, fn, { busyLabel = "" } = {}) {
  return async (event) => {
    if (event && event.preventDefault) event.preventDefault();
    if (btn && btn.disabled) return;
    let restoreLabel = null;
    const btnId = btn?.id ?? "";
    if (btn) {
      btn.disabled = true;
      btn.classList.add("is-busy");
      btn.setAttribute("aria-busy", "true");
      const labelEl = btn.querySelector(".btn-label");
      if (busyLabel && labelEl) {
        restoreLabel = labelEl.textContent;
        labelEl.textContent = busyLabel;
      }
    }
    try {
      await fn(event);
    } catch (error) {
      pushNotice(error && error.message ? error.message : String(error), "error");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("is-busy");
        btn.removeAttribute("aria-busy");
        const labelEl = btn.querySelector(".btn-label");
        if (restoreLabel !== null && labelEl) labelEl.textContent = restoreLabel;
        // A re-render may have replaced the button (same id) or disabling it may have dropped focus.
        if (btnId && (document.activeElement === document.body || !document.contains(btn))) document.getElementById(btnId)?.focus({ preventScroll: true });
      }
    }
  };
}

const ignoreChecked = () => Boolean($("#ignore-calling-hours")?.checked);

/* -------------------------------------------------------------- Notices */

function pushNotice(message, level = "info") {
  const host = $("#notices");
  if (!host) return;
  const id = `n${++state.noticeSeq}`;
  const at = new Date().toISOString();
  if (document.activeElement && document.activeElement !== document.body && !host.contains(document.activeElement)) state.noticeReturn = document.activeElement;
  host.insertAdjacentHTML("afterbegin", C.Notice({ id, level, message, atText: F.clock(at) }));
  const el = host.querySelector(`[data-notice="${id}"]`);
  if (el) el.querySelector("time")?.setAttribute("datetime", at);
  if (el && (level === "info" || level === "success")) {
    // Auto-dismiss after 9 s, paused while the notice is focused or hovered.
    let timer = setTimeout(() => dismissNotice(id), 9000);
    const pause = () => {
      clearTimeout(timer);
      timer = null;
    };
    const resume = () => {
      if (timer !== null || el.matches(":hover") || el.contains(document.activeElement)) return;
      timer = setTimeout(() => dismissNotice(id), 9000);
    };
    el.addEventListener("focusin", pause);
    el.addEventListener("mouseenter", pause);
    el.addEventListener("focusout", () => setTimeout(resume, 0));
    el.addEventListener("mouseleave", resume);
  }
  // Keep at most six, and never evict a warning or error the operator has not dismissed.
  while (host.children.length > 6) {
    const victim = [...host.children].reverse().find((el) => !el.classList.contains("error") && !el.classList.contains("warn")) ?? host.lastElementChild;
    victim.remove();
  }
}

function dismissNotice(id) {
  const el = $(`#notices [data-notice="${id}"]`);
  if (!el) return;
  const hadFocus = el.contains(document.activeElement);
  el.classList.add("leaving");
  const remove = () => {
    const sibling = el.nextElementSibling ?? el.previousElementSibling;
    el.remove();
    if (!hadFocus) return;
    const back = state.noticeReturn;
    const target = sibling?.querySelector(".notice-close") ?? (back && document.contains(back) ? back : $("#main"));
    target?.focus({ preventScroll: true });
  };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) remove();
  else setTimeout(remove, 180);
}

/** Re-render without dropping keyboard focus: ids are stable, so refocus by id afterwards. */
function preserveFocus(fn) {
  const active = document.activeElement;
  const id = active && active !== document.body ? active.id : "";
  fn();
  if (!id) return;
  if (document.activeElement === document.body || !document.contains(active)) {
    document.getElementById(id)?.focus({ preventScroll: true });
  }
}

/* ---------------------------------------------------------------- Shell */

function topBarControls() {
  return `
    <div class="ignore-slot" id="ignore-slot"></div>
    <span class="mode-badge" id="mode-badge" data-mode="">${icon("flask", { size: 13 })}<span>DRY RUN · no calls</span></span>
    <div class="live" id="live-updates-indicator" role="status" data-state="offline"><span class="live-dot" aria-hidden="true"></span><span class="live-text">Updates offline</span></div>`;
}

/** The watch list in the sidebar: one row per watched product, coloured dot, paused marked in text. */
function watchList() {
  return `<div class="watch-list" id="watch-list">
    <label class="sr-only" for="watch-selector">Watched product</label>
    <select class="select sr-only" id="watch-selector"></select>
    <div class="watch-items" id="watch-items"></div>
    <span class="tag warn" id="watch-paused" hidden>Paused</span>
  </div>`;
}

function sidebarFoot() {
  return `<p class="side-note">Built on <a href="https://www.heycall-e.com/" rel="noopener">CALL-E</a>. Every call discloses that it is automated, and every number stays masked.</p>`;
}

function ignoreSwitch() {
  return `<label class="switch" for="ignore-calling-hours" title="Dry run only: pretend it is business hours at every site"><input type="checkbox" role="switch" id="ignore-calling-hours"><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span><span class="switch-label">Ignore calling hours</span></label>`;
}

function mainMarkup() {
  return `
    <div class="overview" id="overview">
      <div class="sample-banner" id="sample-banner" hidden></div>
      <section class="index fly" style="--d:.18s" id="availability-index-panel" aria-labelledby="availability-index-title">
        <div class="index-head">
          <div>
            <h2 class="section-title" id="availability-index-title">Availability index</h2>
            <p class="index-sub" id="index-sub"></p>
          </div>
          <div class="signal-slot" id="signal-slot"></div>
        </div>
        <div class="metrics" id="availability-metrics">${C.Skeleton(2)}</div>
        <div class="chart" id="availability-chart">${C.Skeleton(3)}</div>
        <div class="table-scroll" id="strata-table-scroll" tabindex="0" role="region" aria-label="Strata by region and kind; scrolls sideways">${C.Skeleton(3)}</div>
        <p class="table-note" id="strata-note" hidden></p>
      </section>
      ${C.SectionCard({
        cls: "reveal",
        id: "find-now-panel",
        title: "Find it now",
        subtitle: "Source a fill in waves: known sources first, then the closest eligible pharmacies.",
        bodyHtml: `
          <form class="find-form" id="find-now-form" novalidate>
            <div class="field"><label class="field-label" for="find-region">Region</label><select class="select" id="find-region" required></select></div>
            <div class="field"><label class="field-label" for="find-sources-needed">Sources needed</label><input class="input" id="find-sources-needed" type="number" min="1" max="6" value="2" inputmode="numeric"></div>
            <div class="field"><label class="field-label" for="find-wave-size">Wave size</label><input class="input" id="find-wave-size" type="number" min="1" max="6" value="3" inputmode="numeric"></div>
            <div class="field field-wide"><label class="field-label" for="find-only-sites">Only these sites <span class="muted">(optional, comma-separated site ids)</span></label><input class="input mono" id="find-only-sites" type="text" placeholder="eb-ind-3, sf-chn-1" autocomplete="off"></div>
            <label class="check field-wide" for="find-hold-today"><input type="checkbox" id="find-hold-today"><span>Ask to hold one fill for pickup today</span></label>
            <label class="check field-wide" for="find-fresh"><input type="checkbox" id="find-fresh"><span>Call even if seen in stock recently <span class="muted">(re-verify instead of reusing a sighting)</span></span></label>
            <div class="form-actions field-wide">${C.SecondaryButton({ id: "plan-find", label: "Plan calls", type: "submit" })}</div>
          </form>
          <div class="preview" id="find-plan-preview" hidden></div>
          <div class="requests" id="find-request-list">${C.Skeleton(2)}</div>`
      })}
      ${C.SectionCard({
        cls: "reveal",
        id: "sites-courtesy-panel",
        title: "Sites and courtesy",
        headActionsHtml: `<p class="sites-count" id="sites-count"></p>`,
        subtitle: "Numbers are masked everywhere. A site hears about a product at most once per cooldown; anyone who asks not to be called is out for good.",
        bodyHtml: `<div class="sites-wrap" id="sites-wrap">${C.Skeleton(4)}</div>`
      })}
      ${C.SectionCard({ id: "help-panel", title: "How Shortline works", cls: "help reveal", bodyHtml: `<div class="help-grid" id="help-body"></div>` })}
    </div>`;
}

function railMarkup() {
  return `
    <section class="card rail-card fly" style="--d:.3s" id="weekly-sweep-panel" aria-labelledby="weekly-sweep-title">
      <div class="card-head">
        <div class="card-title-wrap"><h2 class="card-title" id="weekly-sweep-title">This week\u2019s sweep</h2></div>
        <div class="card-actions">${C.PrimaryButton({ id: "run-sweep-now", label: "Run sweep", icon: "arrow-right", iconAfter: true })}</div>
      </div>
      <div class="card-body">
        <div class="stats" id="sweep-pills">${C.Skeleton(1)}</div>
        <p class="hint" id="calling-window-hint" hidden></p>
      </div>
    </section>
    <section class="card rail-card feed-card fly" style="--d:.42s" aria-labelledby="activity-title">
      <div class="card-head">
        <div class="card-title-wrap"><h2 class="card-title" id="activity-title">Activity</h2></div>
        <span class="feed-zone" id="feed-zone"></span>
      </div>
      <div class="card-body">
        <p class="sr-only" id="feed-announcer" role="status"></p>
        <div class="feed-scroll" tabindex="0" role="region" aria-label="Activity, newest first"><ol class="feed" id="sweep-feed">${C.Skeleton(3)}</ol></div>
      </div>
    </section>`;
}

function footer() {
  return `<footer class="foot"><span>Observations from dry-run mode are marked simulated. Numbers are masked everywhere.</span></footer>`;
}

/** Sections below the fold fly in the first time they are scrolled to, once each. */
function wireReveal() {
  const targets = [...document.querySelectorAll(".reveal:not(.shown)")];
  if (targets.length === 0) return;
  if (!("IntersectionObserver" in window)) return;
  // Only hide anything once the observer is certain to reveal it again.
  document.body.classList.add("js-reveal");
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.style.setProperty("--d", "0s");
        entry.target.classList.add("shown");
        io.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.08 }
  );
  targets.forEach((el) => io.observe(el));
  // Belt and braces: nothing stays hidden for more than a few seconds.
  setTimeout(() => targets.forEach((el) => el.classList.add("shown")), 4000);
}

function mountShell() {
  const root = $("#root");
  root.innerHTML =
    C.AppShell({
      sidebarHtml: C.Sidebar({
        wordmark: "Shortline",
        tagline: "Availability, verified by phone",
        nav: NAV,
        watchHtml: watchList(),
        footHtml: sidebarFoot()
      }),
      topBarHtml: C.PageBar({
        titleHtml: `<h1 class="greeting" id="greeting">${C.Skeleton(1)}</h1><p class="status-line" id="status-line"></p>`,
        rightHtml: topBarControls()
      }),
      mainHtml: mainMarkup(),
      railHtml: railMarkup(),
      footerHtml: footer()
    }) + C.TranscriptDialog();
  wireReveal();
}

/* ------------------------------------------------------------ Loading */

async function load() {
  const q = state.watchId ? `?watch=${encodeURIComponent(state.watchId)}` : "";
  const data = await api(`/api/state${q}`);
  if (state.fallback) {
    state.fallback = false;
    state.feed = [];
    state.seenEvents = new Set();
    $("#sample-banner").hidden = true;
    pushNotice("Reconnected to the server; sample data replaced with live state.", "success");
  }
  state.data = data;
  state.watchId = data.watch?.id ?? null;
  for (const entry of data.events ?? []) feedFromEvent(entry);
  render();
}

function useSample(error) {
  try {
    state.fallback = true;
    state.data = JSON.parse(JSON.stringify(SAMPLE_STATE));
    state.watchId = state.data.watch?.id ?? null;
    state.feed = [];
    state.seenEvents = new Set();
    for (const entry of state.data.events ?? []) feedFromEvent(entry);
    const banner = $("#sample-banner");
    banner.innerHTML = `${icon("alert-triangle", { size: 15 })}<span><b>Sample data.</b> GET /api/state failed (${esc(error?.message ?? String(error))}); this page shows a labelled sample, not live state.</span>${C.SecondaryButton({ id: "retry-load", label: "Retry", small: true })}`;
    banner.hidden = false;
    $("#retry-load")?.addEventListener("click", guarded($("#retry-load"), () => load(), { busyLabel: "Retrying…" }));
    pushNotice(`Could not load /api/state: ${error?.message ?? error}. Showing sample data.`, "error");
    render();
  } catch (renderError) {
    pushNotice(`Sample render failed: ${renderError?.message ?? renderError}`, "error");
  }
}

function render() {
  const d = state.data;
  if (!d) return;
  F.setDisplayZone(d.localNow?.timezone ?? null);
  document.body.dataset.state = "ready";
  preserveFocus(() => {
    renderTop(d);
    renderOverview(d);
    renderIndex(d);
    renderSweep(d);
    renderFind(d);
    renderSites(d);
    renderHelp(d);
  });
}

/* ---------------------------------------------------------- Top bar */

function renderTop(d) {
  const badge = $("#mode-badge");
  const live = d.mode === "live";
  badge.dataset.mode = live ? "live" : "dry";
  badge.innerHTML = `${icon(live ? "phone" : "flask", { size: 14 })}<span>${live ? "LIVE · real calls" : "DRY RUN · no calls"}</span>`;
  badge.title = live ? "Live mode: real calls are placed" : "Dry run: calls are simulated, nobody is dialled";

  // The watch list is the sidebar's data source: one row per product. The select stays in the
  // DOM (visually hidden) so the control keeps a native label, value, and change event.
  const sel = $("#watch-selector");
  const watches = d.watches ?? [];
  const options = watches.map((w) => `<option value="${esc(w.id)}"${w.id === d.watch?.id ? " selected" : ""}>${esc(F.productLabel(w.product))}${w.status === "paused" ? " · Paused" : ""}</option>`).join("");
  if (sel.dataset.sig !== options) {
    sel.innerHTML = options || `<option value="">No watches</option>`;
    sel.dataset.sig = options;
  }
  if (d.watch?.id) sel.value = d.watch.id;
  const items = watches
    .map((w, i) => {
      const active = w.id === d.watch?.id;
      const paused = w.status === "paused";
      return `<button type="button" class="watch-item${active ? " is-active" : ""}" data-watch="${esc(w.id)}"${active ? ' aria-current="true"' : ""}>
        <span class="watch-dot" data-hue="${i % 4}" aria-hidden="true"></span>
        <span class="watch-name">${esc(F.productLabel(w.product))}</span>
        ${paused ? `<span class="watch-state">Paused</span>` : ""}
      </button>`;
    })
    .join("");
  const host = $("#watch-items");
  if (host.dataset.sig !== items) {
    host.innerHTML = items || `<p class="side-empty">No watches</p>`;
    host.dataset.sig = items;
  }
  const paused = d.watch?.status === "paused";
  $("#watch-paused").hidden = true;
  if (paused) sel.setAttribute("aria-describedby", "watch-paused");
  else sel.removeAttribute("aria-describedby");

  const count = $('[data-count="weekly-sweep-panel"]');
  if (count) {
    const sweep = d.sweep;
    const pending = sweep ? Math.max(0, sweep.planned - sweep.verified) : 0;
    count.textContent = pending > 0 ? String(pending) : "";
    count.hidden = pending === 0;
  }

  const slot = $("#ignore-slot");
  if (live) {
    slot.innerHTML = "";
  } else if (!$("#ignore-calling-hours")) {
    slot.innerHTML = ignoreSwitch();
  }

  const region = $("#find-region");
  const regions = d.watch?.regions ?? [];
  const current = region.value;
  const ropts = regions.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("");
  if (region.dataset.sig !== ropts) {
    region.innerHTML = ropts;
    region.dataset.sig = ropts;
  }
  if (regions.includes(current)) region.value = current;
}

function setLive(status) {
  state.live = status;
  const el = $("#live-updates-indicator");
  if (!el) return;
  el.dataset.state = status;
  const text = status === "connected" ? "Live updates connected" : status === "reconnecting" ? "Reconnecting" : "Updates offline";
  el.querySelector(".live-text").textContent = text;
  el.title = text;
}

/* ---------------------------------------------------------- Overview */

function latestEstimates(d) {
  const est = d.estimates ?? [];
  const latest = est[est.length - 1] ?? null;
  const sufficient = est.filter((e) => e.signal !== "insufficient_data" && e.overall?.pHat !== null);
  const lastOk = sufficient[sufficient.length - 1] ?? null;
  const prevOk = sufficient[sufficient.length - 2] ?? null;
  // "In progress" only describes the current week; a closed insufficient week is simply insufficient.
  return { est, latest, lastOk, prevOk, headline: lastOk ?? latest, inProgress: Boolean(latest && latest.signal === "insufficient_data" && latest.isoWeek === d.week) };
}

function renderOverview(d) {
  $("#greeting").textContent = F.greeting(d.localNow, d.operatorName);
  const { latest, lastOk, inProgress } = latestEstimates(d);
  const label = F.productLabel(d.watch?.product);
  const sig = lastOk ? `${F.humanSignal(lastOk.signal).toLowerCase()} signal for ${lastOk.isoWeek}` : "no estimate yet";
  const wk = inProgress && latest ? `${latest.isoWeek} has ${F.plural(latest.usable ?? 0, "usable answer")} so far` : `week ${d.week}`;
  const mode = d.mode === "live" ? "live mode, real calls" : "dry run, no calls are placed";
  $("#status-line").textContent = `${label ? `${label}: ` : ""}${sig}. ${wk.charAt(0).toUpperCase()}${wk.slice(1)}, ${mode}.`;
}

/* --------------------------------------------------- Availability index */

function renderIndex(d) {
  const { est, latest, lastOk, prevOk, headline, inProgress } = latestEstimates(d);
  const chipHost = $("#signal-slot");
  if (latest && inProgress && lastOk) {
    chipHost.innerHTML = C.SignalChip(lastOk.signal, { id: "availability-signal-chip", suffix: `${F.weekShort(latest.isoWeek)}: not enough data yet`, large: true });
  } else if (latest) {
    chipHost.innerHTML = C.SignalChip(latest.signal, { id: "availability-signal-chip", large: true });
  } else {
    chipHost.innerHTML = C.SignalChip("insufficient_data", { id: "availability-signal-chip", large: true });
  }
  const label = F.productLabel(d.watch?.product);
  $("#index-sub").textContent = label
    ? `${label}: share of pharmacies that can dispense today, from a rotating stratified sample across ${F.plural((d.watch?.regions ?? []).length, "region")}. Band is a 95% interval.`
    : "Share of pharmacies that can dispense today. Band is a 95% interval.";

  renderChart($("#availability-chart"), { estimates: est, threshold: d.watch?.thresholds?.shortageUpper ?? 0.5, minUsable: d.watch?.minUsable ?? 6, week: d.week });

  const metrics = $("#availability-metrics");
  const openTip = metrics.querySelector(".tip.is-open .tip-trigger")?.id ?? "";
  if (!headline) {
    metrics.innerHTML = C.EmptyState({ icon: "bar-chart", title: "No estimate yet", hint: "Run a sweep to compute the first weekly index.", compact: true });
  } else {
    const delta = lastOk && prevOk && lastOk.overall.pHat !== null && prevOk.overall.pHat !== null ? lastOk.overall.pHat - prevOk.overall.pHat : null;
    const deltaPts = delta === null ? null : Math.round(delta * 100);
    const deltaIcon = deltaPts === null ? "minus" : deltaPts > 0 ? "trending-up" : deltaPts < 0 ? "trending-down" : "minus";
    const deltaTone = deltaPts === null ? "" : deltaPts > 0 ? "up" : deltaPts < 0 ? "down" : "flat";
    const minUsable = d.watch?.minUsable ?? 6;
    metrics.innerHTML = [
      C.MetricTile({
        id: "metric-estimate",
        label: `Estimate ${F.weekShort(headline.isoWeek)}`,
        title: `Estimate ${headline.isoWeek}`,
        icon: "target",
        tone: "accent",
        valueHtml: `<span class="num">${esc(F.fmtPct(headline.overall.pHat))}</span>`,
        sub: headline.overall.low === null ? "interval unavailable" : `95% CI ${F.fmtInterval(headline.overall.low, headline.overall.high)}`
      }),
      C.MetricTile({
        id: "metric-wow-delta",
        label: "Week over week",
        icon: "calendar",
        tone: deltaTone,
        valueHtml: `<span class="delta">${icon(deltaIcon, { size: 18 })}<span class="num">${deltaPts === null ? "—" : `${deltaPts > 0 ? "+" : ""}${deltaPts} pts`}</span></span>`,
        sub: lastOk && prevOk ? `${F.weekShort(prevOk.isoWeek)} → ${F.weekShort(lastOk.isoWeek)}` : "needs two sufficient weeks"
      }),
      inProgress && latest
        ? C.MetricTile({
            id: "metric-response-rate",
            label: `${F.weekShort(latest.isoWeek)} in progress`,
            srJoin: ": ",
            icon: "hourglass",
            tone: "progress",
            valueHtml: `<span class="num">${esc(latest.usable ?? 0)}</span> <span class="unit">usable of ${esc(minUsable)} needed</span>`,
            sub: `${latest.planned ?? 0} asked so far`,
            title: `${F.weekShort(latest.isoWeek)} in progress: ${latest.usable ?? 0} usable of ${minUsable} needed`
          })
        : C.MetricTile({
            id: "metric-response-rate",
            label: "Response rate",
            icon: "phone",
            valueHtml: `<span class="num">${esc(headline.usable)} / ${esc(headline.planned)}</span>${headline.responseRate !== null ? ` <span class="unit">· ${esc(F.fmtPct(headline.responseRate))}</span>` : ""}`,
            sub: "usable / asked · rate"
          }),
      C.MetricTile({
        id: "metric-method",
        label: "Method",
        icon: "sigma",
        valueHtml: `<span class="num sm">${esc(F.humanMethod(headline.method))}</span>`,
        subHtml: `<span>coverage ${esc(F.fmtPct(headline.coverage))}</span>${headline.overall.nEff ? `<span class="dot-sep" aria-hidden="true">·</span><span>n_eff ${esc(headline.overall.nEff)}</span>` : ""}`,
        tooltipHtml: C.Tooltip({ id: "metric-method-tip", text: `${F.methodExplainer(headline.method)} Coverage is the share of the frame covered by strata with at least one usable answer.`, label: "What this method means" })
      })
    ].join("");
  }
  if (openTip) {
    const trigger = metrics.querySelector(".tip .tip-trigger");
    if (trigger) setTipOpen(trigger, true);
  }

  const cols = [
    { label: "Stratum" },
    { label: "Frame", align: "num", title: "Sites believed to carry the product" },
    { label: "Asked", align: "num" },
    { label: "Usable", align: "num" },
    { label: "Available", align: "num", title: "In stock plus limited; (n ltd) is the limited share" },
    { label: "Estimate", title: "Point estimate with 95% interval" }
  ];
  const rows = headline
    ? (headline.strata ?? []).map((s) => ({
        cells: [
          `<span class="stratum"><b>${esc(s.region)}</b> · ${esc(s.kind)}</span>`,
          esc(s.frameSize),
          esc(s.planned),
          esc(s.usable),
          `${esc(s.available)}${s.limited ? ` <span class="muted">(${esc(s.limited)} ltd)</span>` : ""}`,
          s.pHat === null
            ? `<span class="muted why">${icon("circle-dashed", { size: 12 })}no usable observation</span>`
            : `<div class="bar-wrap"><div class="bar" aria-hidden="true"><div class="ci" style="left:${(s.low * 100).toFixed(1)}%;width:${((s.high - s.low) * 100).toFixed(1)}%"></div><div class="p" style="left:${(s.pHat * 100).toFixed(1)}%"></div></div><span class="bar-n"><b>${esc(F.fmtPct(s.pHat))}</b> <span class="muted">${esc(F.fmtInterval(s.low, s.high))}</span></span></div>`
        ]
      }))
    : [];
  $("#strata-table-scroll").innerHTML = C.DataTable({
    id: "strata-table",
    cls: "strata",
    columns: cols,
    rows,
    caption: headline ? `Strata for ${headline.isoWeek}` : "Strata",
    emptyHtml: C.EmptyState({ icon: "layers", title: "No strata yet", hint: "Strata appear after the first sweep.", compact: true })
  });
  const note = $("#strata-note");
  note.textContent = rows.length ? "Frame: sites believed to carry the product. Available: in stock plus limited; (n ltd) is the limited share. Estimate: point estimate with 95% interval." : "";
  note.hidden = !rows.length;
}

/** Tooltip bubbles open on hover and focus via CSS; tap and keyboard toggle them here. */
function setTipOpen(trigger, open) {
  const tip = trigger.closest(".tip");
  if (!tip) return;
  tip.classList.toggle("is-open", open);
  trigger.setAttribute("aria-expanded", open ? "true" : "false");
}
function closeTips(except = null) {
  for (const t of document.querySelectorAll(".tip.is-open .tip-trigger")) if (t !== except) setTipOpen(t, false);
}

/* ------------------------------------------------------------- Sweep */

function renderSweep(d) {
  const s = d.sweep;
  const pills = $("#sweep-pills");
  if (s) {
    const undersampled = s.undersampled ?? [];
    pills.innerHTML = [
      C.StatusPill({ label: "week", value: s.isoWeek, tone: "blue" }),
      C.StatusPill({ label: "planned", value: s.planned }),
      C.StatusPill({ label: "dispatched", value: s.dispatched, muted: !s.dispatched }),
      C.StatusPill({ label: "verified", value: s.verified, tone: s.verified ? "success" : "", muted: !s.verified }),
      C.StatusPill({ label: "waiting for window", value: s.waitingForWindow, tone: s.waitingForWindow ? "warn" : "", muted: !s.waitingForWindow }),
      C.StatusPill({ label: "in flight", value: s.inFlight, tone: s.inFlight ? "blue" : "", muted: !s.inFlight }),
      C.StatusPill({ label: "needs human", value: s.needsHuman, tone: s.needsHuman ? "danger" : "", muted: !s.needsHuman }),
      C.StatusPill({ label: "status", value: s.status, tone: "blue" }),
      `<div class="stat${undersampled.length ? " warn" : " muted"}" title="${esc(undersampled.join(", ") || "every stratum met its panel")}"><span class="stat-k">undersampled strata</span><b class="stat-v">${esc(undersampled.length)}</b></div>`,
      undersampled.length ? `<p class="stat-note" id="undersampled-strata">${undersampled.length === 1 ? "One stratum could not fill its panel" : `${esc(undersampled.length)} strata could not fill their panels`} this week: ${esc(undersampled.map((u) => u.replace("|", " · ")).join(", "))}.</p>` : ""
    ].join("");
  } else {
    pills.innerHTML = C.EmptyState({ icon: "radar", title: `No sweep planned for ${d.week} yet`, hint: "Run sweep now plans a rotating panel per stratum and dials inside each site’s calling window.", compact: true });
  }
  const hint = $("#calling-window-hint");
  if (s && s.waitingForWindow > 0 && s.dispatched === 0 && d.localNow && d.window) {
    hint.innerHTML = `${icon("clock", { size: 14 })}<span>${esc(F.windowHintFull(d))}</span>`;
    hint.hidden = false;
  } else {
    hint.hidden = true;
    hint.innerHTML = "";
  }
  $("#feed-zone").textContent = d.localNow?.timezone ? `times in ${d.localNow.timezone}` : "";
  renderFeed();
}

function siteNameOf(id) {
  return state.data?.sites?.find((s) => s.id === id)?.name ?? id;
}

function feedFromEvent(entry) {
  const e = entry?.event;
  if (!e || !e.type) return;
  if (e.type === "call_event" && e.eventId) {
    if (state.seenEvents.has(e.eventId)) return;
    state.seenEvents.add(e.eventId);
  }
  const key = `${entry.at}|${JSON.stringify(e)}`;
  if (state.seenEvents.has(key)) return;
  state.seenEvents.add(key);
  if (e.type === "estimate") {
    // One estimate line per distinct (week, signal, value): a sweep recomputes once per batch.
    const ekey = `estimate|${e.isoWeek}|${e.signal}|${e.pHat}`;
    if (state.seenEvents.has(ekey)) return;
    state.seenEvents.add(ekey);
  }
  const known = ["dispatch", "observation", "call_event", "estimate", "find", "sweep", "notice"];
  if (!known.includes(e.type)) return;
  state.feed.push({ at: entry.at, type: e.type, e });
}

function feedRow(item) {
  const e = item.e;
  const time = { timeText: F.clock(item.at), timeTitle: F.fmtDateTime(item.at), timeIso: item.at };
  if (e.type === "dispatch") {
    const names = (e.siteIds ?? []).map(siteNameOf).join(", ");
    const tone = e.state === "needs_human" ? "warn" : e.state === "terminal_verified" ? "ok" : "";
    return C.ActivityFeedItem({
      type: "dispatch",
      tone,
      ...time,
      primaryHtml: `${C.StateChip(`${e.kind} · ${F.humanDispatchState(e.state)}`, { small: true, icon: e.state === "needs_human" ? "user" : "send" })}<span class="feed-text">${esc(names)}</span>`,
      detailsHtml: `${e.callId ? `<span class="callid mono">${esc(e.callId)}</span>` : ""}${e.note ? `<span class="note">${esc(e.note)}</span>` : ""}`
    });
  }
  if (e.type === "observation") {
    const obs = findObservation(e.observationId);
    return C.ActivityFeedItem({
      type: "observation",
      tone: e.usable ? "" : "muted",
      ...time,
      primaryHtml: `${C.OutcomeChip(e.outcome, { small: true })}${e.usable ? "" : C.NotCountedChip(e.usableReason, { small: true })}<span class="feed-text">${esc(e.siteName ?? siteNameOf(e.siteId))}</span>`,
      detailsHtml: `<span class="why">${esc(F.humanReason(e.usableReason))}</span>${e.evidenceQuote ? C.Quote(e.evidenceQuote) : ""}${transcriptButton({ observationId: e.observationId, siteName: e.siteName ?? siteNameOf(e.siteId), noConversation: Boolean(obs && obs.transcriptTurns === 0), id: `transcript-button-${e.observationId}` })}`
    });
  }
  if (e.type === "call_event") {
    const kind = String(e.eventType ?? "").replace(/^call\./, "").replace(/_/g, " ");
    return C.ActivityFeedItem({
      type: "call_event",
      ...time,
      primaryHtml: `${C.StateChip(`CALL-E event · ${kind}`, { small: true, icon: "message-square" })}<span class="feed-text">${esc(e.message)}</span>`,
      detailsHtml: `<span class="callid mono">${esc(e.callId)}</span>`
    });
  }
  if (e.type === "estimate") {
    return C.ActivityFeedItem({
      type: "estimate",
      ...time,
      primaryHtml: `${C.SignalChip(e.signal)}<span class="feed-text">estimate ${esc(e.isoWeek)} → ${esc(F.fmtPct(e.pHat))}</span>`
    });
  }
  if (e.type === "find") {
    return C.ActivityFeedItem({
      type: "find",
      tone: e.status === "met" ? "ok" : e.status === "needs_human" ? "warn" : "",
      ...time,
      primaryHtml: `${C.StateChip(`find · ${F.FIND_EVENT_STATUS[e.status] ?? e.status}`, { small: true, icon: "search" })}<span class="feed-text">${esc(e.confirmed)}/${esc(e.need)} confirmed</span>`,
      detailsHtml: e.findRequestId ? `<span class="callid mono">${esc(e.findRequestId)}</span>` : ""
    });
  }
  if (e.type === "sweep") {
    return C.ActivityFeedItem({
      type: "sweep",
      ...time,
      primaryHtml: `${C.StateChip(`sweep · ${e.status}`, { small: true, icon: "radar" })}<span class="feed-text">${esc(e.note)}</span>`,
      detailsHtml: e.isoWeek ? `<span class="why">${esc(e.isoWeek)}</span>` : ""
    });
  }
  if (e.type === "notice") {
    return C.ActivityFeedItem({
      type: "notice",
      tone: e.level === "warn" ? "warn" : "",
      ...time,
      primaryHtml: `<span class="feed-text">${esc(e.message)}</span>`
    });
  }
  return "";
}

/** Transcript control with a site-specific accessible name; the visible label stays short. */
function transcriptButton({ observationId, siteName, noConversation, id = "" }) {
  const label = noConversation ? "no conversation" : "transcript";
  const name = noConversation ? `No conversation: ${siteName}` : `Transcript: ${siteName}`;
  return C.LinkButton({ id, label, icon: "file-text", attrs: `data-obs="${esc(observationId)}" aria-label="${esc(name)}"` });
}

const FEED_CAP = 150;

/**
 * Full mode rebuilds the list (after every state load). Incremental mode, used for SSE
 * events, prepends only the rows that are new so focus is kept and nothing is re-announced;
 * the newest row's text goes to the single status announcer instead.
 */
function renderFeed({ full = true } = {}) {
  const feed = $("#sweep-feed");
  if (!feed) return;
  const rendered = Number(feed.dataset.count ?? 0);
  const sameWatch = feed.dataset.watch === String(state.watchId);
  if (!full && sameWatch && state.feed.length === rendered) return;
  if (!full && sameWatch && rendered > 0 && state.feed.length > rendered) {
    const fresh = state.feed.slice(rendered).reverse();
    feed.insertAdjacentHTML("afterbegin", fresh.map(feedRow).join(""));
    // The feed row now owns transcript-button-{id}; drop the duplicate an attempt chip may hold.
    for (const it of fresh) {
      if (it.type !== "observation") continue;
      document.querySelectorAll(`#find-request-list [id="transcript-button-${CSS.escape(it.e.observationId)}"]`).forEach((el) => el.removeAttribute("id"));
    }
    while (feed.children.length > FEED_CAP) feed.lastElementChild.remove();
    feed.dataset.count = String(state.feed.length);
    announceFeed(feed.firstElementChild);
    return;
  }
  const items = state.feed.slice(-FEED_CAP).reverse();
  preserveFocus(() => {
    feed.innerHTML = items.length
      ? items.map(feedRow).join("")
      : `<li class="feed-empty">${C.EmptyState({ icon: "activity", title: "Waiting for activity", hint: "Run a sweep or a sourcing request.", compact: true })}</li>`;
  });
  feed.dataset.count = String(state.feed.length);
  feed.dataset.watch = String(state.watchId);
}

function announceFeed(row) {
  const announcer = $("#feed-announcer");
  if (!announcer || !row) return;
  const primary = row.querySelector(".feed-primary");
  const text = primary ? [...primary.children].map((c) => c.textContent.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ") : "";
  if (!text) return;
  announcer.textContent = "";
  requestAnimationFrame(() => {
    announcer.textContent = text;
  });
}

/* ------------------------------------------------------------- Find */

function findObservation(observationId) {
  const d = state.data;
  if (!d) return null;
  return d.observations?.find((o) => o.id === observationId) ?? (d.finds ?? []).flatMap((f) => f.attempts ?? []).find((a) => a.observationId === observationId) ?? null;
}

const REQUEST_TONE = { met: "in_stock", running: "state", exhausted: "out_of_stock", needs_human: "limited", stopped: "unknown", planned: "state" };
const REQUEST_ICON = { met: "check-circle", running: "loader", exhausted: "x-circle", needs_human: "user", stopped: "ban", planned: "target" };

function renderFind(d) {
  const list = $("#find-request-list");
  const finds = d.finds ?? [];
  // The spec id transcript-button-{observationId} lives on the feed row when the feed has it,
  // otherwise on the attempt chip (the feed keeps the newest 150 events).
  const inFeed = new Set(state.feed.slice(-FEED_CAP).filter((i) => i.type === "observation").map((i) => i.e.observationId));
  list.innerHTML = finds.length
    ? finds.map((f) => {
        const r = f.request;
        const sources = (f.confirmed ?? []).length
          ? f.confirmed
              .map(
                (c) => `<div class="source">
              <div class="source-head"><b>${esc(c.name)}</b><span class="mono">${esc(c.phoneMasked)}</span>${C.OutcomeChip(c.outcome, { small: true })}${c.holdResponse === "offered" ? C.HoldChip() : ""}</div>
              ${c.evidenceQuote ? C.Quote(c.evidenceQuote) : `<span class="muted">observed by monitoring</span>`}
              ${c.restockExpectation ? `<span class="delivery">${icon("truck", { size: 12 })}next delivery: ${esc(c.restockExpectation)}</span>` : ""}
              <span class="prov">${esc(c.basis === "monitoring" ? "from monitoring" : "this request")} · ${esc(F.rel(c.observedAt, d.now))}</span>
            </div>`
              )
              .join("")
          : C.EmptyState({ icon: "package", title: "No confirmed source yet", compact: true });
        const attempts = (f.attempts ?? []).length
          ? `<div class="attempts">${f.attempts
              .map(
                (a) => `<span class="attempt">${a.waveIndex !== null && a.waveIndex !== undefined ? `<span class="wave mono">w${esc(a.waveIndex + 1)}</span>` : ""}<span class="attempt-site">${esc(a.name)}</span>${C.OutcomeChip(a.outcome, { small: true })}${a.usable ? "" : `${C.NotCountedChip(a.usableReason, { small: true })}<span class="why">${esc(F.humanReason(a.usableReason))}</span>`}${transcriptButton({ observationId: a.observationId, siteName: a.name, noConversation: !(a.transcriptTurns > 0), id: inFeed.has(a.observationId) ? "" : `transcript-button-${a.observationId}` })}</span>`
              )
              .join("")}</div>`
          : "";
        const tone = REQUEST_TONE[r.status] ?? "unknown";
        return `<article class="req ${esc(r.status)}">
          <header class="req-head">
            <h3 class="req-title">${esc(f.productLabel)} <span class="muted">·</span> ${esc(r.region)}</h3>
            <span class="chip oc ${esc(tone)}" id="request-status-${esc(r.id)}">${icon(REQUEST_ICON[r.status] ?? "circle-dashed", { size: 13 })}<span>${esc(F.findStatusLabel(f))}</span></span>
          </header>
          <p class="req-meta">need ${esc(r.need)} · ${esc(r.confirmedSiteIds.length)} confirmed · ${esc(r.usedSiteIds.length)} called · ${esc(F.fmtTime(r.createdAt))}${r.askHold ? " · hold requested" : ""}</p>
          <div class="sources">${sources}</div>
          ${attempts}
        </article>`;
      }).join("")
    : C.EmptyState({ icon: "search", title: "No sourcing requests yet", hint: "Plan a find above; nothing is dialled until you confirm.", compact: true });
}

function renderPreview(p) {
  const box = $("#find-plan-preview");
  if (!p) {
    const hadFocus = box.contains(document.activeElement);
    box.hidden = true;
    box.innerHTML = "";
    state.preview = null;
    if (hadFocus) $("#plan-find")?.focus({ preventScroll: true });
    return;
  }
  const d = state.data;
  const live = d?.mode === "live";
  const known = (p.knownSources ?? []).length
    ? `<h4 class="preview-h">Known sources</h4><ul class="plist">${p.knownSources
        .map((k) => `<li><span class="plist-main"><b>${esc(k.name)}</b>${C.Tag("No call needed", "success")}${C.OutcomeChip(k.outcome, { small: true })}</span><span class="plist-sub">${k.evidenceQuote ? C.Quote(k.evidenceQuote) : ""}<span class="muted">observed ${esc(F.rel(k.observedAt, d?.now))}</span></span></li>`)
        .join("")}</ul>`
    : "";
  const cands = (p.candidates ?? []).length
    ? `<h4 class="preview-h">Would call, in waves of ${esc(p.request?.waveSize ?? "")}</h4><ul class="plist">${p.candidates
        .map((c) => `<li><span class="plist-main"><b>${esc(c.name)}</b><span class="mono">${esc(c.phoneMasked)}</span></span><span class="plist-sub">${C.Tag(F.humanBasis(c.basis), c.basis === "observed_in_stock" ? "success" : "")}${c.distanceKm !== null && c.distanceKm !== undefined ? `<span class="muted">${esc(c.distanceKm)} km</span>` : ""}<span class="muted">${esc(c.kind ?? "")}</span></span></li>`)
        .join("")}</ul>`
    : C.EmptyState({ icon: "phone-off", title: "No eligible candidates right now", compact: true });
  const hint = (p.candidates ?? []).length === 0 ? `<p class="hint">${icon("clock", { size: 14 })}<span>${esc(eligibilityHint(p, d, live))}</span></p>` : "";
  const skipped = (p.skipped ?? []).length
    ? `<h4 class="preview-h">Skipped</h4><ul class="plist compact">${p.skipped.slice(0, 8).map((s) => `<li><span class="plist-main">${esc(s.name)}</span><span class="plist-sub"><span class="muted">${esc(F.humanSkip(s.reason))}</span></span></li>`).join("")}${p.skipped.length > 8 ? `<li class="muted">+${esc(p.skipped.length - 8)} more</li>` : ""}</ul>`
    : "";
  const verb = live ? "Place" : "Simulate";
  const n = p.firstWaveCalls ?? 0;
  const label = n === 0 ? "Nothing to call" : `${verb} ${n} ${live ? "real " : ""}call${n === 1 ? "" : "s"} now, up to ${p.maxCalls} in total`;
  box.innerHTML = `<div class="preview-head"><h3 class="preview-title">${icon("target", { size: 15 })}Plan preview</h3><span class="muted">${esc(p.request?.region ?? "")} · need ${esc(p.request?.need ?? "")}</span></div>${known}${cands}${hint}${skipped}<div class="preview-actions">${C.PrimaryButton({ id: "confirm-find-plan", label, icon: live ? "phone" : "play", danger: live, disabled: n === 0 })}${C.SecondaryButton({ id: "discard-find-plan", label: "Discard", icon: "x" })}</div>`;
  box.hidden = false;
  const confirmBtn = $("#confirm-find-plan");
  confirmBtn?.addEventListener(
    "click",
    guarded(confirmBtn, async () => {
      const res = await api(`/api/find/${encodeURIComponent(p.request.id)}/run`, { method: "POST", body: JSON.stringify({ confirm: true, ignoreWindow: ignoreChecked(), plan: state.planInputs }) });
      if (res.replanned) pushNotice("The plan had expired on this server and was re-planned from the same inputs before running.", "info");
      renderPreview(null);
      await load();
    }, { busyLabel: live ? "Placing calls…" : "Simulating…" })
  );
  const discardBtn = $("#discard-find-plan");
  discardBtn?.addEventListener(
    "click",
    guarded(discardBtn, async () => {
      try {
        await api(`/api/find/${encodeURIComponent(p.request.id)}/discard`, { method: "POST", body: "{}" });
      } catch (error) {
        // A plan that already expired on the server is gone either way; any other failure is
        // reported, but the stale preview is still cleared and state refetched (legacy parity).
        if (error.status !== 404) pushNotice(error.message, "error");
      } finally {
        renderPreview(null);
        await load();
      }
    })
  );
}

/** One sentence explaining why nothing is eligible and what would change that. */
function eligibilityHint(p, d, live) {
  const skipped = p.skipped ?? [];
  const outside = skipped.some((s) => s.reason === "outside_calling_window");
  if (outside && F.windowHint(d)) return `${F.windowHint(d)} ${live ? "Plan again inside the window." : "Tick Ignore calling hours and plan again."}`;
  const counts = new Map();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const region = p.request?.region ?? "this region";
  if (!top) return `No site in ${region} is eligible right now; widen the region or check the watch’s site list.`;
  const advice = top === "opted_out" ? "widen the region or opt sites back in." : top === "does_not_carry" || top === "wrong_number" ? "widen the region." : top === "call_in_flight" ? "wait for the current calls to finish." : "widen the region or wait for the cooldown.";
  return `Every eligible site in ${region} is ${F.humanSkip(top)}; ${advice}`;
}

/* ------------------------------------------------------------- Sites */

function renderSites(d) {
  const sites = d.sites ?? [];
  const opted = sites.filter((s) => s.optOut).length;
  $("#sites-count").innerHTML = `${icon("building", { size: 13 })}<b>${esc(sites.length)}</b> monitored <span class="dot-sep">·</span> ${icon("user-x", { size: 13 })}<b>${esc(opted)}</b> opted out`;
  const rows = sites.map((s) => {
    const callee = Boolean(s.optOut && s.optOutReason && String(s.optOutReason).startsWith("asked on call "));
    const action = callee
      ? `<span class="site-action-text" id="site-action-${esc(s.id)}"><span>${icon("phone-off", { size: 12 })}asked not to be called</span><span class="muted">${esc(s.optOutReason)} · no undo</span></span>`
      : C.LinkButton({ id: `site-action-${esc(s.id)}`, label: s.optOut ? "opt back in" : "opt out", icon: s.optOut ? "check" : "ban", attrs: `data-optout="${esc(s.id)}" data-current="${s.optOut ? "true" : "false"}" aria-label="${esc(s.optOut ? `Opt ${s.name} back in` : `Opt out ${s.name}`)}"` });
    return {
      cls: s.optOut ? "optout" : "",
      cells: [
        `<span class="site-name"><b>${esc(s.name)}</b>${s.testLine ? C.Tag("test line", "blue") : ""}${s.optOut && !callee ? C.Tag("opted out", "warn") : ""}</span>`,
        `<span class="mono stratum-cell">${esc(s.region)}<span class="muted"> · ${esc(s.kind)}</span></span>`,
        `<span class="mono">${esc(s.phoneMasked)}</span>`,
        s.lastOutcome ? `<span class="last">${C.OutcomeChip(s.lastOutcome, { small: true })}<span class="muted">${esc(F.rel(s.lastObservedAt, d.now))}</span></span>` : `<span class="muted">never called</span>`,
        esc(s.callsThisMonth),
        action
      ]
    };
  });
  $("#sites-wrap").innerHTML = C.DataTable({
    id: "sites-table",
    cls: "sites",
    columns: [{ label: "Site" }, { label: "Stratum" }, { label: "Number" }, { label: "Last outcome" }, { label: "Calls 30d", align: "num", title: "Shortline calls to this site in the last 30 days" }, { label: "Courtesy", sr: true }],
    rows,
    caption: "Monitored sites",
    emptyHtml: C.EmptyState({ icon: "building", title: "No sites loaded", compact: true })
  });
}

async function setSiteOptOut(siteId, optOut) {
  try {
    await api(`/api/sites/${encodeURIComponent(siteId)}/opt-out`, { method: "POST", body: JSON.stringify({ optOut, reason: "dashboard" }) });
  } catch (error) {
    if (error.status === 409 && error.body?.error === "callee_opt_out") {
      pushNotice(`${siteNameOf(siteId)} asked not to be called${error.body.reason ? ` (${error.body.reason})` : ""}. Shortline never re-adds a site that asked on a call.`, "warn");
      await load();
      return;
    }
    throw error;
  }
  pushNotice(`${siteNameOf(siteId)} ${optOut ? "opted out" : "opted back in"}.`, "success");
  await load();
}

/* -------------------------------------------------------------- Help */

function renderHelp(d) {
  const w = d.watch ?? {};
  $("#help-body").innerHTML = [
    ["radar", "Weekly sweep", `Each week Shortline picks ${esc(w.panelPerStratum ?? 3)} sites per region-and-kind stratum, calls them inside their local window (${esc(d.window?.start ?? "")}–${esc(d.window?.end ?? "")}), and turns verified answers into the availability index with a 95% interval.`],
    ["search", "Find it now", "A sourcing request checks fresh monitoring first, then calls the closest eligible pharmacies in small waves until enough sources confirm. Nothing is dialled before you confirm the plan."],
    ["shield-check", "Courtesy limits", `A site is asked about a product at most once per ${esc(w.cooldownDays ?? 14)} days and never more than once in ${esc(w.globalMinGapDays ?? 5)} days across products. Anyone who asks not to be called is opted out for good; every number stays masked.`]
  ]
    .map(([ic, title, text]) => `<div class="help-item"><span class="help-icon">${icon(ic, { size: 16 })}</span><div><h3 class="help-title">${esc(title)}</h3><p class="help-text">${text}</p></div></div>`)
    .join("");
}

/* --------------------------------------------------------- Transcript */

async function openTranscript(observationId, opener) {
  const obs = findObservation(observationId);
  if (!obs) {
    pushNotice("That observation is no longer in the recent list, so its transcript cannot be opened.", "warn");
    return;
  }
  const dlg = $("#transcript-dialog");
  const body = $("#transcript-turns");
  const siteName = obs.siteName ?? obs.name ?? siteNameOf(obs.siteId);
  $("#transcript-title").textContent = siteName;
  $("#transcript-sub").innerHTML = `${C.OutcomeChip(obs.outcome, { small: true })}${obs.usable === false ? C.NotCountedChip(obs.usableReason, { small: true }) : ""}<span class="muted">${esc(F.humanReason(obs.usableReason))}</span>`;
  body.innerHTML = `<div class="turn-loading">${icon("loader", { size: 16, cls: "spin" })}Loading…</div>`;
  body.setAttribute("aria-busy", "true");
  if (!dlg.open) {
    // Remember the opener by id too: a background re-render can replace the node while the dialog is open.
    state.lastOpener = opener ?? document.activeElement;
    state.lastOpenerId = state.lastOpener?.id ?? "";
    dlg.showModal();
  }
  $("#transcript-close")?.focus();
  if ((obs.transcriptTurns ?? 1) === 0) {
    body.innerHTML = C.EmptyState({ icon: "phone-missed", title: "No conversation: the call was not answered", compact: true });
    body.removeAttribute("aria-busy");
    return;
  }
  try {
    const { turns } = await api(`/api/transcript?dispatch=${encodeURIComponent(obs.dispatchId)}&recipient=${encodeURIComponent(obs.recipientId)}`);
    const nq = F.normalizePhrase(obs.evidenceQuote ?? "");
    let marked = false;
    const html = (turns ?? [])
      .map((t) => {
        const isEvidence = !marked && Boolean(nq) && t.speaker !== "bot" && ` ${F.normalizePhrase(t.text)} `.includes(` ${nq} `);
        if (isEvidence) marked = true;
        return C.TranscriptTurn({ speaker: t.speaker, offsetSeconds: t.offsetSeconds ?? t.offset_seconds ?? 0, text: t.text, evidence: isEvidence });
      })
      .join("");
    body.innerHTML = html || C.EmptyState({ icon: "file-text", title: "Transcript not retained", compact: true });
  } catch (error) {
    // Only a 404 means the transcript was discarded; anything else is a load failure with a retry.
    body.innerHTML =
      error.status === 404
        ? C.EmptyState({ icon: "file-text", title: "Transcript not retained", compact: true })
        : `${C.EmptyState({ icon: "alert-circle", title: `Could not load the transcript (${error.message})`, compact: true })}<div class="turn-loading">${C.LinkButton({ label: "Retry", icon: "loader", attrs: `data-retry-obs="${esc(observationId)}"` })}</div>`;
  } finally {
    body.removeAttribute("aria-busy");
  }
}

function wireDialog() {
  const dlg = $("#transcript-dialog");
  $("#transcript-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });
  dlg.addEventListener("close", () => {
    const opener = state.lastOpener;
    const openerId = state.lastOpenerId;
    state.lastOpener = null;
    state.lastOpenerId = "";
    const target = opener && document.contains(opener) ? opener : openerId ? document.getElementById(openerId) : null;
    if (target && typeof target.focus === "function") target.focus();
  });
  dlg.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const focusable = [...dlg.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

/* --------------------------------------------------------------- SSE */

let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => load().catch((e) => pushNotice(e.message, "error")), 350);
}

function connect() {
  if (typeof EventSource === "undefined") {
    setLive("offline");
    return;
  }
  const es = new EventSource("/api/events");
  setLive("reconnecting");
  let connectedOnce = false;
  es.addEventListener("hello", () => {
    if (connectedOnce) scheduleReload();
    connectedOnce = true;
    setLive("connected");
    if (state.fallback) load().catch(() => undefined);
  });
  es.addEventListener("ping", () => {
    if (state.live !== "connected") setLive("connected");
  });
  es.addEventListener("app", (msg) => {
    try {
      feedFromEvent(JSON.parse(msg.data));
    } catch {
      return;
    }
    renderFeed({ full: false });
    scheduleReload();
  });
  es.onerror = () => setLive(es.readyState === EventSource.CLOSED ? "offline" : "reconnecting");
}

/* ---------------------------------------------------------- Navigation */

function wireNav() {
  const links = [...document.querySelectorAll("[data-nav]")];
  const targets = NAV.map((n) => document.getElementById(n.target)).filter(Boolean);
  const setActive = (id) => {
    for (const a of links) {
      if (a.dataset.nav === id) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    }
  };
  setActive("overview");
  if (typeof IntersectionObserver === "undefined") return;
  const visible = new Map();
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) visible.set(en.target.id, en.isIntersecting ? en.intersectionRatio : 0);
      let best = null, ratio = 0;
      for (const t of targets) {
        const r = visible.get(t.id) ?? 0;
        if (r > ratio) {
          ratio = r;
          best = t.id;
        }
      }
      if (best) setActive(best);
    },
    { rootMargin: "-80px 0px -55% 0px", threshold: [0, 0.2, 0.5, 1] }
  );
  targets.forEach((t) => io.observe(t));
}

/* --------------------------------------------------------------- Wire */

function wire() {
  // Clicking a sidebar watch drives the same native select, so one code path handles both.
  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest?.("[data-watch]");
    if (!btn) return;
    const sel = $("#watch-selector");
    if (!sel || sel.value === btn.dataset.watch) return;
    sel.value = btn.dataset.watch;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });

  $("#watch-selector").addEventListener(
    "change",
    guarded(null, async (e) => {
      state.watchId = e.target.value;
      state.feed = [];
      state.seenEvents = new Set();
      renderPreview(null);
      await load();
    })
  );
  const runBtn = $("#run-sweep-now");
  runBtn.addEventListener(
    "click",
    guarded(runBtn, async () => {
      const res = await api("/api/sweeps/run", { method: "POST", body: JSON.stringify({ watchId: state.watchId, force: ignoreChecked() }) });
      if (res.summary) {
        const s = res.summary;
        pushNotice(`Sweep: ${s.dispatchedNow} dispatched now, ${s.alreadyDispatched} already this week, ${s.waitingForWindow} waiting for their calling window${s.inFlight ? `, ${s.inFlight} in flight` : ""}${s.needsHuman ? `, ${s.needsHuman} need a human` : ""}.`, "info");
      } else {
        pushNotice("Sweep started; results arrive as calls complete.", "info");
      }
      await load();
    }, { busyLabel: "Running sweep…" })
  );
  const planBtn = $("#plan-find");
  $("#find-now-form").addEventListener(
    "submit",
    guarded(planBtn, async () => {
      state.planInputs = {
        watchId: state.watchId,
        region: $("#find-region").value,
        need: Number($("#find-sources-needed").value),
        waveSize: Number($("#find-wave-size").value),
        askHold: $("#find-hold-today").checked,
        ignoreKnownSources: $("#find-fresh").checked,
        ignoreWindow: ignoreChecked(),
        onlySiteIds: $("#find-only-sites").value.split(",").map((s) => s.trim()).filter(Boolean)
      };
      const preview = await api("/api/find/plan", { method: "POST", body: JSON.stringify(state.planInputs) });
      state.preview = preview;
      renderPreview(preview);
      $("#find-plan-preview").scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }, { busyLabel: "Planning…" })
  );
  document.addEventListener("click", (e) => {
    const dismiss = e.target.closest("[data-dismiss]");
    if (dismiss) {
      dismissNotice(dismiss.dataset.dismiss);
      return;
    }
    const tipTrigger = e.target.closest(".tip-trigger");
    if (tipTrigger) {
      const open = tipTrigger.getAttribute("aria-expanded") !== "true";
      closeTips(tipTrigger);
      setTipOpen(tipTrigger, open);
      return;
    }
    if (!e.target.closest(".tip")) closeTips();
    const retry = e.target.closest("[data-retry-obs]");
    if (retry) {
      openTranscript(retry.dataset.retryObs, retry).catch((err) => pushNotice(err.message, "error"));
      return;
    }
    const obs = e.target.closest("[data-obs]");
    if (obs) {
      openTranscript(obs.dataset.obs, obs).catch((err) => pushNotice(err.message, "error"));
      return;
    }
    const opt = e.target.closest("[data-optout]");
    if (opt) {
      guarded(opt, async () => {
        const current = opt.dataset.current === "true";
        await setSiteOptOut(opt.dataset.optout, !current);
      })();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTips();
  });
  wireDialog();
  wireNav();
}

mountShell();
wire();
load()
  .catch((error) => useSample(error))
  .finally(() => connect());

// Exposed for the callee opt-out check: the UI offers no undo for those sites.
export { setSiteOptOut, load, pushNotice };
