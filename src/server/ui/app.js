const $ = (sel) => document.querySelector(sel);
const state = { data: null, watchId: null, preview: null, feed: [] };

const fmtPct = (v) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);
const fmtTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
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
const humanReason = (r) => ({ verified: "verified against transcript", quoted_without_transcript: "quote, no transcript", no_structured_result: "no result extracted", recipient_failed: "call failed", voicemail: "voicemail", ivr_only: "never left the menu", pharmacy_not_reached: "pharmacy staff not reached", refused: "declined to share", no_clear_answer: "no clear answer", pharmacy_staff_not_confirmed: "staff not confirmed", not_in_frame: "does not carry; removed from frame", product_never_asked: "product never named", no_evidence: "no evidence quote", evidence_unattributed: "quote not in transcript" }[r] ?? r);

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status}`);
  }
  return res.json();
}

async function load() {
  const q = state.watchId ? `?watch=${encodeURIComponent(state.watchId)}` : "";
  state.data = await api(`/api/state${q}`);
  state.watchId = state.data.watch?.id ?? null;
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

function renderIndex(d) {
  const est = d.estimates ?? [];
  const latest = est[est.length - 1] ?? null;
  const chip = $("#signal-chip");
  chip.textContent = latest ? latest.signal.replace("_", " ") : "no data";
  chip.className = `chip ${latest ? latest.signal : "insufficient_data"}`;
  const label = d.watch ? [d.watch.product.name, d.watch.product.strength, d.watch.product.form].filter(Boolean).join(" ") : "";
  $("#index-sub").textContent = `${label}: share of pharmacies that can dispense today, from a rotating stratified sample across ${(d.watch?.regions ?? []).length} regions. Band is a 95% interval.`;
  renderChart(est, d.watch?.thresholds?.shortageUpper ?? 0.5);
  const sufficient = est.filter((e) => e.signal !== "insufficient_data");
  const lastOk = sufficient[sufficient.length - 1] ?? null;
  const prevOk = sufficient[sufficient.length - 2] ?? null;
  const delta = lastOk && prevOk && lastOk.overall.pHat !== null && prevOk.overall.pHat !== null ? lastOk.overall.pHat - prevOk.overall.pHat : null;
  $("#index-stats").innerHTML = latest
    ? `
      <div class="stat"><div class="k">Estimate ${esc(latest.isoWeek)}</div><div class="v">${fmtPct(latest.overall.pHat)} <small>${fmtPct(latest.overall.low)}–${fmtPct(latest.overall.high)}</small></div></div>
      <div class="stat"><div class="k">Week over week</div><div class="v">${delta === null ? "—" : `${delta >= 0 ? "+" : ""}${Math.round(delta * 100)} pts`}</div></div>
      <div class="stat"><div class="k">Usable / asked</div><div class="v">${latest.usable} <small>/ ${latest.planned}${latest.responseRate !== null ? ` · ${fmtPct(latest.responseRate)} response` : ""}</small></div></div>
      <div class="stat"><div class="k">Method · coverage</div><div class="v"><small>${esc(latest.method)}</small> ${fmtPct(latest.coverage)}</div></div>`
    : `<div class="empty">No estimate yet. Run a sweep.</div>`;
  const tbody = $("#strata tbody");
  tbody.innerHTML = latest
    ? latest.strata
        .map((s) => {
          const bar = s.pHat === null ? `<span class="empty">no usable observation</span>` : `<div class="bar-wrap"><div class="bar"><div class="ci" style="left:${s.low * 100}%;width:${(s.high - s.low) * 100}%"></div><div class="p" style="left:calc(${s.pHat * 100}% - 1px)"></div></div><span class="n">${fmtPct(s.pHat)} <small>${fmtPct(s.low)}–${fmtPct(s.high)}</small></span></div>`;
          return `<tr><td>${esc(s.region)} · ${esc(s.kind)}</td><td class="num">${s.frameSize}</td><td class="num">${s.planned}</td><td class="num">${s.usable}</td><td class="num">${s.inStock}${s.limited ? ` <small>+${s.limited} ltd</small>` : ""}</td><td>${bar}</td></tr>`;
        })
        .join("")
    : "";
}

function renderChart(est, threshold) {
  const el = $("#chart");
  if (!est.length) {
    el.innerHTML = `<div class="empty">No weekly estimates yet.</div>`;
    return;
  }
  const W = 720, H = 240, padL = 40, padR = 16, padT = 16, padB = 28;
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
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${ticks}<line class="thresh" x1="${padL}" x2="${W - padR}" y1="${y(threshold)}" y2="${y(threshold)}"/><text class="thresh-label" x="${padL + 4}" y="${y(threshold) - 4}">shortage line (upper bound &lt; ${Math.round(threshold * 100)}%)</text><path class="band" d="${band}"/><path class="line" d="${line}"/>${pts}${labels}${sim}</svg>`;
}

function renderSweep(d) {
  const s = d.sweep;
  $("#sweep-summary").innerHTML = s
    ? `<span class="pill">week <b>${esc(s.isoWeek)}</b></span><span class="pill">planned <b>${s.planned}</b></span><span class="pill">dispatched <b>${s.dispatched}</b></span><span class="pill">verified <b>${s.verified}</b></span><span class="pill">status <b>${esc(s.status)}</b></span>${s.undersampled.length ? `<span class="pill">undersampled <b>${s.undersampled.length}</b> strata</span>` : ""}`
    : `<span class="pill">No sweep planned for <b>${esc(d.week)}</b> yet</span>`;
  const feed = $("#feed");
  const items = state.feed.slice(-80).reverse();
  feed.innerHTML = items.length
    ? items.map((it) => `<li class="${esc(it.kind)}"><span class="t">${esc(fmtTime(it.at).split(", ")[1] ?? "")}</span><span class="m">${it.html}</span></li>`).join("")
    : `<li><span class="t"></span><span class="m empty">Waiting for activity. Run a sweep or a sourcing request.</span></li>`;
}

function feedFromEvent(entry) {
  const e = entry.event;
  const names = (ids) => (state.data ? ids.map((id) => state.data.sites.find((s) => s.id === id)?.name ?? id) : ids);
  let html = null;
  let kind = "";
  if (e.type === "dispatch") {
    const label = { reserved: "reserved", accepted: "accepted by CALL-E", submission_unknown: "submission unknown — will reconcile", terminal_unverified: "call ended, verifying", terminal_verified: "verified", needs_human: "needs human" }[e.state] ?? e.state;
    html = `<span class="oc state">${esc(e.kind)} · ${esc(label)}</span>${esc(names(e.siteIds).join(", "))}${e.callId ? ` <span class="why">${esc(e.callId)}</span>` : ""}${e.note ? `<span class="q">${esc(e.note)}</span>` : ""}`;
  } else if (e.type === "observation") {
    html = `<span class="oc ${esc(e.outcome)}">${esc(humanOutcome(e.outcome))}</span>${e.usable ? "" : `<span class="oc unusable">not counted</span>`}${esc(e.siteName)}<span class="why">${esc(humanReason(e.usableReason))}</span>${e.evidenceQuote ? `<span class="q">${esc(e.evidenceQuote)}</span>` : ""} <button class="link" data-obs="${esc(e.observationId)}">transcript</button>`;
  } else if (e.type === "call_event") {
    html = `<span class="oc state">${esc(e.eventType.replace("call.", ""))}</span>${esc(e.message)}`;
  } else if (e.type === "estimate") {
    html = `<span class="oc ${esc(e.signal)}">${esc(e.signal.replace("_", " "))}</span>estimate ${esc(e.isoWeek)} → ${fmtPct(e.pHat)}`;
  } else if (e.type === "find") {
    html = `<span class="oc state">find · ${esc(e.status)}</span>${e.confirmed}/${e.need} confirmed`;
  } else if (e.type === "sweep") {
    html = `<span class="oc state">sweep · ${esc(e.status)}</span>${esc(e.note)}`;
  } else if (e.type === "notice") {
    html = esc(e.message);
    kind = "notice";
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
            .map((c) => `<div class="source"><div><b>${esc(c.name)}</b> <span class="mono">${esc(c.phoneMasked)}</span> <span class="oc ${esc(c.outcome)}">${esc(humanOutcome(c.outcome))}</span>${c.holdResponse === "offered" ? `<span class="oc in_stock">hold offered</span>` : ""}<div class="q">${esc(c.evidenceQuote || "observed by surveillance")}</div>${c.restockExpectation ? `<div class="q">next delivery: ${esc(c.restockExpectation)}</div>` : ""}</div><div class="attempt">${esc(rel(c.observedAt))}</div></div>`)
            .join("");
          const attempts = f.attempts.map((a) => `<span class="attempt">${a.waveIndex !== null ? `w${a.waveIndex + 1} · ` : ""}${esc(a.name)}: ${esc(humanOutcome(a.outcome))}${a.usable ? "" : ` (${esc(humanReason(a.usableReason))})`}</span>`).join("");
          return `<div class="find-card ${esc(r.status)}"><h4>${esc(f.productLabel)} · ${esc(r.region)}</h4><div class="meta">${esc(r.status)} · need ${r.need} · ${r.confirmedSiteIds.length} confirmed · ${r.usedSiteIds.length} called · ${esc(fmtTime(r.createdAt))}</div><div class="sources">${sources || `<div class="empty">No confirmed source yet.</div>`}</div><div class="attempts">${attempts}</div></div>`;
        })
        .join("")
    : `<div class="empty">No sourcing requests yet.</div>`;
}

function renderPreview(p) {
  const box = $("#find-preview");
  if (!p) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  const known = p.knownSources.length ? `<h4>Known sources (no call needed)</h4><ul>${p.knownSources.map((k) => `<li><b>${esc(k.name)}</b> — ${esc(humanOutcome(k.outcome))}, observed ${esc(rel(k.observedAt))}${k.evidenceQuote ? `: <i>“${esc(k.evidenceQuote)}”</i>` : ""}</li>`).join("")}</ul>` : "";
  const cands = p.candidates.length ? `<h4>Would call, in waves of ${p.request.waveSize}</h4><ul>${p.candidates.map((c) => `<li>${esc(c.name)} <span class="mono">${esc(c.phoneMasked)}</span> <small>${esc(c.basis.replace(/_/g, " "))}${c.distanceKm !== null ? ` · ${c.distanceKm} km` : ""}</small></li>`).join("")}</ul>` : `<div class="empty">No eligible candidates right now.</div>`;
  const skipped = p.skipped.length ? `<h4>Skipped</h4><ul>${p.skipped.slice(0, 8).map((s) => `<li>${esc(s.name)} <small>${esc(s.reason.replace(/_/g, " "))}</small></li>`).join("")}${p.skipped.length > 8 ? `<li><small>+${p.skipped.length - 8} more</small></li>` : ""}</ul>` : "";
  const live = state.data?.mode === "live";
  box.innerHTML = `${known}${cands}${skipped}<div class="actions"><button class="btn ${live ? "btn-danger" : ""}" id="find-confirm" ${p.estimatedCalls === 0 ? "disabled" : ""}>${live ? `Place up to ${p.estimatedCalls} real call(s)` : `Run ${p.estimatedCalls} simulated call(s)`}</button><button class="btn btn-ghost" id="find-cancel">Discard plan</button></div>`;
  box.hidden = false;
  $("#find-confirm")?.addEventListener("click", async () => {
    $("#find-confirm").disabled = true;
    await api(`/api/find/${encodeURIComponent(p.request.id)}/run`, { method: "POST", body: JSON.stringify({ confirm: true, ignoreWindow: $("#find-ignore").checked }) });
    renderPreview(null);
  });
  $("#find-cancel")?.addEventListener("click", () => renderPreview(null));
}

function renderSites(d) {
  $("#sites-count").textContent = `${d.sites.length} sites · ${d.sites.filter((s) => s.optOut).length} opted out`;
  $("#sites tbody").innerHTML = d.sites
    .map(
      (s) => `<tr class="${s.optOut ? "optout" : ""}"><td><b>${esc(s.name)}</b></td><td><span class="mono">${esc(s.region)} · ${esc(s.kind)}</span></td><td class="mono">${esc(s.phoneMasked)}</td><td>${s.lastOutcome ? `<span class="oc ${esc(s.lastOutcome)}">${esc(humanOutcome(s.lastOutcome))}</span><small>${esc(rel(s.lastObservedAt))}</small>` : `<small>never called</small>`}</td><td class="num">${s.callsThisMonth}</td><td><button class="link" data-optout="${esc(s.id)}" data-current="${s.optOut}">${s.optOut ? "opt back in" : "opt out"}</button></td></tr>`
    )
    .join("");
}

async function showTranscript(observationId) {
  const obs = state.data.observations.find((o) => o.id === observationId);
  if (!obs) return;
  const dlg = $("#transcript-dialog");
  $("#transcript-title").textContent = `${obs.siteName} — ${humanOutcome(obs.outcome)} (${humanReason(obs.usableReason)})`;
  const body = $("#transcript-body");
  body.innerHTML = `<div class="empty">Loading…</div>`;
  dlg.showModal();
  try {
    const { turns } = await api(`/api/transcript?dispatch=${encodeURIComponent(obs.dispatchId)}&recipient=${encodeURIComponent(obs.recipientId)}`);
    const quote = (obs.evidenceQuote ?? "").toLowerCase();
    body.innerHTML = turns
      .map((t) => {
        let txt = esc(t.text);
        if (quote && t.speaker !== "bot" && t.text.toLowerCase().includes(quote)) {
          const i = t.text.toLowerCase().indexOf(quote);
          txt = `${esc(t.text.slice(0, i))}<mark>${esc(t.text.slice(i, i + quote.length))}</mark>${esc(t.text.slice(i + quote.length))}`;
        }
        return `<div class="turn ${esc(t.speaker)}"><span class="who">${esc(t.speaker === "bot" ? "agent" : t.speaker === "user" ? "pharmacy" : "?")}</span><span class="off">${t.offsetSeconds ?? t.offset_seconds ?? 0}s</span><span class="txt">${txt}</span></div>`;
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
    timer = setTimeout(() => load().catch(() => undefined), 350);
  });
  es.onerror = () => $("#live-dot").classList.remove("on");
}

$("#watch-select").addEventListener("change", (e) => {
  state.watchId = e.target.value;
  state.feed = [];
  load();
});
$("#run-sweep").addEventListener("click", async () => {
  const btn = $("#run-sweep");
  btn.disabled = true;
  try {
    await api("/api/sweeps/run", { method: "POST", body: JSON.stringify({ watchId: state.watchId, force: $("#find-ignore").checked }) });
  } finally {
    setTimeout(() => (btn.disabled = false), 1500);
  }
});
$("#find-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const preview = await api("/api/find/plan", {
    method: "POST",
    body: JSON.stringify({ watchId: state.watchId, region: $("#find-region").value, need: Number($("#find-need").value), waveSize: Number($("#find-wave").value), askHold: $("#find-hold").checked, ignoreWindow: $("#find-ignore").checked })
  });
  state.preview = preview;
  renderPreview(preview);
});
document.addEventListener("click", async (e) => {
  const obs = e.target.closest("[data-obs]");
  if (obs) return showTranscript(obs.dataset.obs);
  const opt = e.target.closest("[data-optout]");
  if (opt) {
    const current = opt.dataset.current === "true";
    await api(`/api/sites/${encodeURIComponent(opt.dataset.optout)}/opt-out`, { method: "POST", body: JSON.stringify({ optOut: !current, reason: "dashboard" }) });
    load();
  }
});
$("#transcript-close").addEventListener("click", () => $("#transcript-dialog").close());

load().then(() => {
  for (const entry of state.data.events ?? []) feedFromEvent(entry);
  renderSweep(state.data);
  connect();
});
