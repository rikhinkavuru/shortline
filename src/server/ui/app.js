const $ = (sel) => document.querySelector(sel);
const state = { data: null, watchId: null, preview: null, planInputs: null, feed: [], seenEvents: new Set(), lastEventAt: "" };

const fmtPct = (v) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);
const fmtTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const rel = (iso) => {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.round(ms / 3600000);
  if (h < 1) return "just now";
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const humanOutcome = (o) => ({ in_stock: "in stock", limited: "limited", out_of_stock: "out of stock", not_carried: "not carried", refused: "refused", unknown: "unknown", voicemail: "voicemail", ivr_dead_end: "menu dead end", not_reached: "not reached", unreachable: "unreachable" }[o] ?? o);
const humanReason = (r) => ({ verified: "verified against transcript", quoted_without_transcript: "quote, no transcript", no_structured_result: "no result extracted", recipient_failed: "call failed", recipient_skipped: "skipped by CALL-E", recipient_pending: "never dialled", recipient_in_progress: "still in progress", not_dialled: "never dialled", voicemail: "voicemail", ivr_only: "never left the menu", pharmacy_not_reached: "pharmacy staff not reached", refused: "declined to share", no_clear_answer: "no clear answer", pharmacy_staff_not_confirmed: "staff not confirmed", not_in_frame: "does not carry; removed from frame", product_never_asked: "product never named", no_evidence: "no evidence quote", evidence_unattributed: "quote not in transcript" }[r] ?? r.replace(/_/g, " "));
const humanMethod = (m) => ({ stratified: "stratified", pooled_wilson: "pooled Wilson" }[m] ?? m);
const methodTitle = (m) => ({ stratified: "Frame-weighted stratified estimate with finite-population correction; Wilson interval on the effective sample size", pooled_wilson: "A stratum had fewer than two usable answers, so all usable answers were pooled into one Wilson interval" }[m] ?? "");
const findLabel = (f) => {
  const r = f.request;
  if (r.status === "met") return "Found";
  if (r.status === "running") return "Calling…";
  if (r.status === "exhausted") return `No source found after ${f.waves} wave${f.waves === 1 ? "" : "s"}`;
  if (r.status === "needs_human") return `Stopped, needs a human look${f.halt?.note ? `: ${f.halt.note}` : ""}`;
  if (r.status === "stopped") return "Discarded";
  return r.status;
};
const normalizePhrase = (t) => String(t ?? "").toLowerCase().replace(/[’'`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

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

function notice(message, level = "warn") {
  state.feed.push({ at: new Date().toISOString(), html: esc(message), kind: level === "warn" ? "notice" : "" });
  renderSweep(state.data ?? { sweep: null, week: "" });
}

/** Wrap a button handler: disable while running, surface every failure in the feed, re-enable always. */
function guarded(btn, fn) {
  return async (event) => {
    if (event && event.preventDefault) event.preventDefault();
    if (btn) btn.disabled = true;
    try {
      await fn(event);
    } catch (error) {
      notice(error && error.message ? error.message : String(error));
    } finally {
      if (btn) btn.disabled = false;
    }
  };
}

async function load() {
  const q = state.watchId ? `?watch=${encodeURIComponent(state.watchId)}` : "";
  state.data = await api(`/api/state${q}`);
  state.watchId = state.data.watch?.id ?? null;
  for (const entry of state.data.events ?? []) feedFromEvent(entry);
  render();
}

function render() {
  const d = state.data;
  if (!d) return;
  renderTop(d);
  renderIndex(d);
  renderSweep(d);
  renderFind(d);
  renderSites(d);
}

function renderTop(d) {
  const badge = $("#mode-badge");
  badge.textContent = d.mode === "live" ? "LIVE · real calls" : "DRY RUN · no calls";
  badge.className = `badge ${d.mode === "live" ? "live" : "dry"}`;
  const sel = $("#watch-select");
  sel.innerHTML = d.watches.map((w) => `<option value="${esc(w.id)}" ${w.id === d.watch?.id ? "selected" : ""}>${esc([w.product.name, w.product.strength, w.product.form].filter(Boolean).join(" "))}${w.status === "paused" ? " (paused)" : ""}</option>`).join("");
  const region = $("#find-region");
  const regions = d.watch?.regions ?? [];
  const current = region.value;
  region.innerHTML = regions.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("");
  if (regions.includes(current)) region.value = current;
  $("#find-ignore-wrap").hidden = d.mode === "live";
}

function windowHint(d) {
  if (!d.localNow || !d.window) return "";
  const days = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return `It is ${d.localNow.hhmm} ${days[d.localNow.isoWeekday] ?? ""} in ${d.localNow.timezone}; calls go out ${d.window.start}–${d.window.end} local, ${d.window.days.map((x) => days[x]).join(" ")}.`;
}

function renderIndex(d) {
  const est = d.estimates ?? [];
  const latest = est[est.length - 1] ?? null;
  const sufficient = est.filter((e) => e.signal !== "insufficient_data");
  const lastOk = sufficient[sufficient.length - 1] ?? null;
  const prevOk = sufficient[sufficient.length - 2] ?? null;
  const headline = lastOk ?? latest;
  const chip = $("#signal-chip");
  if (latest && latest.signal === "insufficient_data" && lastOk) {
    chip.textContent = `${lastOk.isoWeek.slice(5)}: ${lastOk.signal.replace("_", " ")} · ${latest.isoWeek.slice(5)} not enough data yet`;
    chip.className = `chip ${lastOk.signal}`;
  } else {
    chip.textContent = latest ? latest.signal.replace("_", " ") : "no data";
    chip.className = `chip ${latest ? latest.signal : "insufficient_data"}`;
  }
  const label = d.watch ? [d.watch.product.name, d.watch.product.strength, d.watch.product.form].filter(Boolean).join(" ") : "";
  $("#index-sub").textContent = `${label}: share of pharmacies that can dispense today, from a rotating stratified sample across ${(d.watch?.regions ?? []).length} regions. Band is a 95% interval.`;
  renderChart(est, d.watch?.thresholds?.shortageUpper ?? 0.5);
  const delta = lastOk && prevOk && lastOk.overall.pHat !== null && prevOk.overall.pHat !== null ? lastOk.overall.pHat - prevOk.overall.pHat : null;
  const inProgress = latest && latest.signal === "insufficient_data" && lastOk;
  $("#index-stats").innerHTML = headline
    ? `
      <div class="stat"><div class="k">Estimate ${esc(headline.isoWeek)}</div><div class="v">${fmtPct(headline.overall.pHat)} <small>${fmtPct(headline.overall.low)}–${fmtPct(headline.overall.high)}</small></div></div>
      <div class="stat"><div class="k">Week over week</div><div class="v">${delta === null ? "—" : `${delta >= 0 ? "+" : ""}${Math.round(delta * 100)} pts`}</div></div>
      ${inProgress
        ? `<div class="stat"><div class="k">${esc(latest.isoWeek)} in progress</div><div class="v">${latest.usable} <small>usable of ${d.watch?.minUsable ?? 6} needed</small></div></div>`
        : `<div class="stat"><div class="k">Usable / asked</div><div class="v">${headline.usable} <small>/ ${headline.planned}${headline.responseRate !== null ? ` · ${fmtPct(headline.responseRate)} response` : ""}</small></div></div>`}
      <div class="stat" title="${esc(methodTitle(headline.method))}"><div class="k">Method · coverage</div><div class="v"><small>${esc(humanMethod(headline.method))}</small> ${fmtPct(headline.coverage)}${headline.overall.nEff ? ` <small>n<sub>eff</sub> ${headline.overall.nEff}</small>` : ""}</div></div>`
    : `<div class="empty">No estimate yet. Run a sweep.</div>`;
  const tbody = $("#strata tbody");
  tbody.innerHTML = headline
    ? headline.strata
        .map((s) => {
          const bar = s.pHat === null ? `<span class="empty">no usable observation</span>` : `<div class="bar-wrap"><div class="bar"><div class="ci" style="left:${s.low * 100}%;width:${(s.high - s.low) * 100}%"></div><div class="p" style="left:calc(${s.pHat * 100}% - 1px)"></div></div><span class="n">${fmtPct(s.pHat)} <small>${fmtPct(s.low)}–${fmtPct(s.high)}</small></span></div>`;
          return `<tr><td>${esc(s.region)} · ${esc(s.kind)}</td><td class="num">${s.frameSize}</td><td class="num">${s.planned}</td><td class="num">${s.usable}</td><td class="num">${s.available}${s.limited ? ` <small>(${s.limited} ltd)</small>` : ""}</td><td>${bar}</td></tr>`;
        })
        .join("")
    : "";
}

let chartInputs = null;
function renderChart(est, threshold) {
  chartInputs = { est, threshold };
  const el = $("#chart");
  if (!est.length) {
    el.innerHTML = `<div class="empty">No weekly estimates yet.</div>`;
    return;
  }
  const W = Math.max(320, el.clientWidth || 720), H = 240, padL = 40, padR = 16, padT = 16, padB = 28;
  const xs = est.map((_, i) => padL + (i * (W - padL - padR)) / Math.max(1, est.length - 1));
  const y = (v) => padT + (1 - v) * (H - padT - padB);
  const withP = est.map((e, i) => ({ e, x: xs[i] })).filter((p) => p.e.overall.pHat !== null && p.e.signal !== "insufficient_data");
  const thin = est.map((e, i) => ({ e, x: xs[i] })).filter((p) => p.e.overall.pHat !== null && p.e.signal === "insufficient_data");
  const band = withP.length
    ? `M ${withP.map((p) => `${p.x} ${y(p.e.overall.high)}`).join(" L ")} L ${withP.slice().reverse().map((p) => `${p.x} ${y(p.e.overall.low)}`).join(" L ")} Z`
    : "";
  const line = withP.length ? `M ${withP.map((p) => `${p.x} ${y(p.e.overall.pHat)}`).join(" L ")}` : "";
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((v) => `<line class="axis" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${padL - 6}" y="${y(v) + 3}" text-anchor="end">${Math.round(v * 100)}%</text>`).join("");
  const labels = est.map((e, i) => `<text class="tick" x="${xs[i]}" y="${H - 8}" text-anchor="middle">${esc(e.isoWeek.slice(5))}</text>`).join("");
  const pts = withP.map((p) => `<circle class="pt ${esc(p.e.signal)}" cx="${p.x}" cy="${y(p.e.overall.pHat)}" r="4"><title>${esc(p.e.isoWeek)}: ${fmtPct(p.e.overall.pHat)} (${fmtPct(p.e.overall.low)}–${fmtPct(p.e.overall.high)}), n=${p.e.usable}</title></circle>`).join("")
    + thin.map((p) => `<circle class="pt thin" cx="${p.x}" cy="${y(p.e.overall.pHat)}" r="3"><title>${esc(p.e.isoWeek)}: only ${p.e.usable} usable observation(s); not enough for an estimate</title></circle>`).join("");
  const sim = est.some((e) => e.simulated) ? `<text class="sim" x="${W - padR}" y="${padT - 4}" text-anchor="end">SIMULATED HISTORY</text>` : "";
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${ticks}<line class="thresh" x1="${padL}" x2="${W - padR}" y1="${y(threshold)}" y2="${y(threshold)}"/><text class="thresh-label" x="${padL + 4}" y="${y(threshold) - 4}">shortage line (upper bound &lt; ${Math.round(threshold * 100)}%)</text><path class="band" d="${band}"/><path class="line" d="${line}"/>${pts}${labels}${sim}</svg>`;
}
window.addEventListener("resize", () => { if (chartInputs) renderChart(chartInputs.est, chartInputs.threshold); });

function renderSweep(d) {
  const s = d.sweep;
  $("#sweep-summary").innerHTML = s
    ? `<span class="pill">week <b>${esc(s.isoWeek)}</b></span><span class="pill">planned <b>${s.planned}</b></span><span class="pill">dispatched <b>${s.dispatched}</b></span><span class="pill">verified <b>${s.verified}</b></span>${s.waitingForWindow ? `<span class="pill">waiting for window <b>${s.waitingForWindow}</b></span>` : ""}${s.inFlight ? `<span class="pill">in flight <b>${s.inFlight}</b></span>` : ""}${s.needsHuman ? `<span class="pill">needs human <b>${s.needsHuman}</b></span>` : ""}<span class="pill">status <b>${esc(s.status)}</b></span>${s.undersampled.length ? `<span class="pill">undersampled <b>${s.undersampled.length}</b> strata</span>` : ""}`
    : `<span class="pill">No sweep planned for <b>${esc(d.week)}</b> yet</span>`;
  const hint = $("#sweep-hint");
  if (s && s.waitingForWindow > 0 && s.dispatched === 0) {
    hint.textContent = `${windowHint(d)} ${d.mode === "live" ? "The next run inside the window will dial." : "Tick Ignore calling hours (top right) to simulate now."}`;
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
  const feed = $("#feed");
  const items = state.feed.slice(-120).reverse();
  feed.innerHTML = items.length
    ? items.map((it) => `<li class="${esc(it.kind)}"><span class="t">${esc(clock(it.at))}</span><span class="m">${it.html}</span></li>`).join("")
    : `<li><span class="t"></span><span class="m empty">Waiting for activity. Run a sweep or a sourcing request.</span></li>`;
}

function feedFromEvent(entry) {
  const e = entry.event;
  if (e.type === "call_event" && e.eventId) {
    if (state.seenEvents.has(e.eventId)) return;
    state.seenEvents.add(e.eventId);
  }
  const key = `${entry.at}|${JSON.stringify(e)}`;
  if (state.seenEvents.has(key)) return;
  state.seenEvents.add(key);
  const names = (ids) => (state.data ? ids.map((id) => state.data.sites.find((s) => s.id === id)?.name ?? id) : ids);
  let html = null;
  let kind = "";
  if (e.type === "dispatch") {
    const label = { reserved: "reserved", accepted: "accepted by CALL-E", submission_unknown: "submission unknown, will reconcile", terminal_unverified: "call ended, verifying", terminal_verified: "verified", needs_human: "needs human" }[e.state] ?? e.state;
    html = `<span class="oc state">${esc(e.kind)} · ${esc(label)}</span>${esc(names(e.siteIds).join(", "))}${e.callId ? ` <span class="why">${esc(e.callId)}</span>` : ""}${e.note ? `<span class="q">${esc(e.note)}</span>` : ""}`;
  } else if (e.type === "observation") {
    html = `<span class="oc ${esc(e.outcome)}">${esc(humanOutcome(e.outcome))}</span>${e.usable ? "" : `<span class="oc unusable">not counted</span>`}${esc(e.siteName)}<span class="why">${esc(humanReason(e.usableReason))}</span>${e.evidenceQuote ? `<span class="q">${esc(e.evidenceQuote)}</span>` : ""} <button class="link" data-obs="${esc(e.observationId)}">transcript</button>`;
  } else if (e.type === "call_event") {
    html = `<span class="oc state">CALL-E event · ${esc(e.eventType.replace("call.", ""))}</span>${esc(e.message)} <span class="why">${esc(e.callId)}</span>`;
  } else if (e.type === "estimate") {
    // One estimate line per distinct (week, value): a sweep recomputes once per batch.
    const ekey = `estimate|${e.isoWeek}|${e.signal}|${e.pHat}`;
    if (state.seenEvents.has(ekey)) return;
    state.seenEvents.add(ekey);
    html = `<span class="oc ${esc(e.signal)}">${esc(e.signal.replace("_", " "))}</span>estimate ${esc(e.isoWeek)} → ${fmtPct(e.pHat)}`;
  } else if (e.type === "find") {
    const label = { planned: "planned", running: "calling", met: "found", exhausted: "no source found", needs_human: "stopped, needs a human look", stopped: "discarded" }[e.status] ?? e.status;
    html = `<span class="oc state">find · ${esc(label)}</span>${e.confirmed}/${e.need} confirmed`;
  } else if (e.type === "sweep") {
    html = `<span class="oc state">sweep · ${esc(e.status)}</span>${esc(e.note)}`;
  } else if (e.type === "notice") {
    html = esc(e.message);
    kind = e.level === "warn" ? "notice" : "";
  }
  if (html) state.feed.push({ at: entry.at, html, kind });
}

function renderFind(d) {
  const board = $("#find-board");
  const finds = d.finds ?? [];
  board.innerHTML = finds.length
    ? finds
        .map((f) => {
          const r = f.request;
          const sources = f.confirmed
            .map((c) => `<div class="source"><div><b>${esc(c.name)}</b> <span class="mono">${esc(c.phoneMasked)}</span> <span class="oc ${esc(c.outcome)}">${esc(humanOutcome(c.outcome))}</span>${c.holdResponse === "offered" ? `<span class="oc in_stock">hold offered</span>` : ""}<div class="q">${esc(c.evidenceQuote || "observed by monitoring")}</div>${c.restockExpectation ? `<div class="q">next delivery: ${esc(c.restockExpectation)}</div>` : ""}</div><div class="attempt">${c.basis === "monitoring" ? "from monitoring · " : ""}${esc(rel(c.observedAt))}</div></div>`)
            .join("");
          const attempts = f.attempts.map((a) => `<span class="attempt">${a.waveIndex !== null ? `w${a.waveIndex + 1} · ` : ""}${esc(a.name)}: ${esc(humanOutcome(a.outcome))}${a.usable ? "" : ` (${esc(humanReason(a.usableReason))})`}${a.transcriptTurns > 0 ? ` <button class="link" data-obs="${esc(a.observationId)}">transcript</button>` : ""}</span>`).join("");
          return `<div class="find-card ${esc(r.status)}"><h4>${esc(f.productLabel)} · ${esc(r.region)}</h4><div class="meta">${esc(findLabel(f))} · need ${r.need} · ${r.confirmedSiteIds.length} confirmed · ${r.usedSiteIds.length} called · ${esc(fmtTime(r.createdAt))}</div><div class="sources">${sources || `<div class="empty">No confirmed source yet.</div>`}</div><div class="attempts">${attempts}</div></div>`;
        })
        .join("")
    : `<div class="empty">No sourcing requests yet.</div>`;
}

function renderPreview(p) {
  const box = $("#find-preview");
  if (!p) {
    box.hidden = true;
    box.innerHTML = "";
    state.preview = null;
    return;
  }
  const d = state.data;
  const known = p.knownSources.length ? `<h4>Known sources (no call needed)</h4><ul>${p.knownSources.map((k) => `<li><b>${esc(k.name)}</b>: ${esc(humanOutcome(k.outcome))}, observed ${esc(rel(k.observedAt))}${k.evidenceQuote ? `: <i>“${esc(k.evidenceQuote)}”</i>` : ""}</li>`).join("")}</ul>` : "";
  const cands = p.candidates.length ? `<h4>Would call, in waves of ${p.request.waveSize}</h4><ul>${p.candidates.map((c) => `<li>${esc(c.name)} <span class="mono">${esc(c.phoneMasked)}</span> <small>${esc(c.basis.replace(/_/g, " "))}${c.distanceKm !== null ? ` · ${c.distanceKm} km` : ""}</small></li>`).join("")}</ul>` : `<div class="empty">No eligible candidates right now.</div>`;
  const outside = p.skipped.some((s) => s.reason === "outside_calling_window");
  const hint = p.candidates.length === 0 && outside && d?.mode !== "live" ? `<p class="panel-sub">${esc(windowHint(d))} Tick Ignore calling hours (top right) and plan again.</p>` : "";
  const skipped = p.skipped.length ? `<h4>Skipped</h4><ul>${p.skipped.slice(0, 8).map((s) => `<li>${esc(s.name)} <small>${esc(s.reason.replace(/_/g, " "))}</small></li>`).join("")}${p.skipped.length > 8 ? `<li><small>+${p.skipped.length - 8} more</small></li>` : ""}</ul>` : "";
  const live = d?.mode === "live";
  const verb = live ? "Place" : "Simulate";
  const label = p.firstWaveCalls === 0 ? "Nothing to call" : p.maxCalls > p.firstWaveCalls ? `${verb} ${p.firstWaveCalls} ${live ? "real " : ""}call${p.firstWaveCalls === 1 ? "" : "s"} now, up to ${p.maxCalls} in total` : `${verb} ${p.firstWaveCalls} ${live ? "real " : ""}call${p.firstWaveCalls === 1 ? "" : "s"}`;
  box.innerHTML = `${known}${cands}${hint}${skipped}<div class="actions"><button class="btn ${live ? "btn-danger" : ""}" id="find-confirm" ${p.firstWaveCalls === 0 ? "disabled" : ""}>${esc(label)}</button><button class="btn btn-ghost" id="find-cancel">Discard plan</button></div>`;
  box.hidden = false;
  const confirmBtn = $("#find-confirm");
  confirmBtn?.addEventListener("click", guarded(confirmBtn, async () => {
    const res = await api(`/api/find/${encodeURIComponent(p.request.id)}/run`, { method: "POST", body: JSON.stringify({ confirm: true, ignoreWindow: $("#find-ignore").checked, plan: state.planInputs }) });
    if (res.replanned) notice("The plan had expired on this server and was re-planned from the same inputs before running.", "info");
    renderPreview(null);
    await load();
  }));
  $("#find-cancel")?.addEventListener("click", guarded(null, async () => {
    await api(`/api/find/${encodeURIComponent(p.request.id)}/discard`, { method: "POST", body: "{}" }).catch(() => undefined);
    renderPreview(null);
    await load();
  }));
}

function renderSites(d) {
  $("#sites-count").textContent = `${d.sites.length} sites · ${d.sites.filter((s) => s.optOut).length} opted out`;
  $("#sites tbody").innerHTML = d.sites
    .map((s) => {
      const callee = s.optOut && s.optOutReason && s.optOutReason.startsWith("asked on call ");
      const action = callee
        ? `<small title="${esc(s.optOutReason)}">asked not to be called</small>`
        : `<button class="link" data-optout="${esc(s.id)}" data-current="${s.optOut}">${s.optOut ? "opt back in" : "opt out"}</button>`;
      return `<tr class="${s.optOut ? "optout" : ""}"><td><b>${esc(s.name)}</b>${s.testLine ? ` <small>test line</small>` : ""}</td><td><span class="mono">${esc(s.region)} · ${esc(s.kind)}</span></td><td class="mono">${esc(s.phoneMasked)}</td><td>${s.lastOutcome ? `<span class="oc ${esc(s.lastOutcome)}">${esc(humanOutcome(s.lastOutcome))}</span><small>${esc(rel(s.lastObservedAt))}</small>` : `<small>never called</small>`}</td><td class="num">${s.callsThisMonth}</td><td>${action}</td></tr>`;
    })
    .join("");
}

async function showTranscript(observationId) {
  const obs = state.data.observations.find((o) => o.id === observationId) ?? state.data.finds.flatMap((f) => f.attempts).find((a) => a.observationId === observationId);
  if (!obs) return;
  const dlg = $("#transcript-dialog");
  const siteName = obs.siteName ?? obs.name ?? "";
  $("#transcript-title").textContent = `${siteName}: ${humanOutcome(obs.outcome)} (${humanReason(obs.usableReason)})`;
  const body = $("#transcript-body");
  body.innerHTML = `<div class="empty">Loading…</div>`;
  dlg.showModal();
  if ((obs.transcriptTurns ?? 1) === 0) {
    body.innerHTML = `<div class="empty">No conversation: the call was not answered.</div>`;
    return;
  }
  try {
    const { turns } = await api(`/api/transcript?dispatch=${encodeURIComponent(obs.dispatchId)}&recipient=${encodeURIComponent(obs.recipientId)}`);
    const nq = normalizePhrase(obs.evidenceQuote ?? "");
    let marked = false;
    body.innerHTML = turns
      .map((t) => {
        const isEvidence = !marked && nq && t.speaker !== "bot" && ` ${normalizePhrase(t.text)} `.includes(` ${nq} `);
        if (isEvidence) marked = true;
        return `<div class="turn ${esc(t.speaker)} ${isEvidence ? "evidence" : ""}"><span class="who">${esc(t.speaker === "bot" ? "agent" : t.speaker === "user" ? "pharmacy" : "?")}</span><span class="off">${t.offsetSeconds ?? t.offset_seconds ?? 0}s</span><span class="txt">${esc(t.text)}</span></div>`;
      })
      .join("") || `<div class="empty">No transcript stored.</div>`;
  } catch {
    body.innerHTML = `<div class="empty">Transcript not retained.</div>`;
  }
}

function connect() {
  const es = new EventSource("/api/events");
  let timer = null;
  es.addEventListener("hello", () => $("#live-dot").classList.add("on"));
  es.addEventListener("app", (msg) => {
    feedFromEvent(JSON.parse(msg.data));
    renderSweep(state.data ?? { sweep: null, week: "" });
    clearTimeout(timer);
    timer = setTimeout(() => load().catch((e) => notice(e.message)), 350);
  });
  es.onerror = () => $("#live-dot").classList.remove("on");
}

$("#watch-select").addEventListener("change", guarded(null, async (e) => {
  state.watchId = e.target.value;
  state.feed = [];
  state.seenEvents = new Set();
  await load();
}));
$("#run-sweep").addEventListener("click", guarded($("#run-sweep"), async () => {
  const res = await api("/api/sweeps/run", { method: "POST", body: JSON.stringify({ watchId: state.watchId, force: $("#find-ignore").checked }) });
  if (res.summary) {
    const s = res.summary;
    notice(`Sweep: ${s.dispatchedNow} dispatched now, ${s.alreadyDispatched} already this week, ${s.waitingForWindow} waiting for their calling window${s.inFlight ? `, ${s.inFlight} in flight` : ""}${s.needsHuman ? `, ${s.needsHuman} need a human` : ""}.`, "info");
  }
  await load();
}));
$("#find-form").addEventListener("submit", guarded($("#find-form button[type=submit]"), async () => {
  state.planInputs = {
    watchId: state.watchId,
    region: $("#find-region").value,
    need: Number($("#find-need").value),
    waveSize: Number($("#find-wave").value),
    askHold: $("#find-hold").checked,
    ignoreWindow: $("#find-ignore").checked,
    onlySiteIds: $("#find-only").value.split(",").map((s) => s.trim()).filter(Boolean)
  };
  const preview = await api("/api/find/plan", { method: "POST", body: JSON.stringify(state.planInputs) });
  state.preview = preview;
  renderPreview(preview);
}));
document.addEventListener("click", (e) => {
  const obs = e.target.closest("[data-obs]");
  if (obs) return showTranscript(obs.dataset.obs);
  const opt = e.target.closest("[data-optout]");
  if (opt) {
    guarded(opt, async () => {
      const current = opt.dataset.current === "true";
      await api(`/api/sites/${encodeURIComponent(opt.dataset.optout)}/opt-out`, { method: "POST", body: JSON.stringify({ optOut: !current, reason: "dashboard" }) });
      await load();
    })();
  }
});
$("#transcript-close").addEventListener("click", () => $("#transcript-dialog").close());

load().then(() => {
  renderSweep(state.data);
  connect();
}).catch((e) => notice(e.message));
