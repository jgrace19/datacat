const RANGES = [
  ["15m", "Past 15 Minutes"],
  ["1h", "Past 1 Hour"],
  ["4h", "Past 4 Hours"],
  ["1d", "Past 1 Day"],
];

const VIEWS = {
  dashboards: ["Dashboards", "freshcart"],
  monitors: ["Monitors", "Monitor status"],
  incidents: ["Incidents", "Incidents"],
  events: ["Events", "Event stream"],
  integrations: ["Integrations", "Bot delivery"],
};

const state = {
  view: "dashboards",
  env: "prod",
  range: "1h",
  q: "",
  data: null,
  timeOpen: false,
  envOpen: false,
  paused: false,
  busy: false,
  expanded: null,
  eventFilter: "all",
  error: "",
};

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function formatValue(unit, value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  if (unit === "usd") return "$" + Math.round(n).toLocaleString("en-US");
  if (unit === "cents") {
    const sign = n < 0 ? "-" : "";
    const abs = Math.abs(Math.round(n));
    const dollars = Math.floor(abs / 100);
    const frac = String(abs % 100).padStart(2, "0");
    return sign + "$" + dollars.toLocaleString("en-US") + "." + frac;
  }
  if (unit === "ms") return Math.round(n).toLocaleString("en-US") + " ms";
  if (unit === "ratio") return (n * 100).toFixed(2) + "%";
  return Math.round(n).toLocaleString("en-US");
}

function formatClock(t) {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatStamp(t) {
  return new Date(t).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function rangeLabel(key) {
  return RANGES.find(([id]) => id === key)?.[1] ?? "Past 1 Hour";
}

function statusLabel(status) {
  if (status === "ok") return "OK";
  if (status === "warn") return "WARN";
  if (status === "alert") return "ALERT";
  return String(status || "").toUpperCase();
}

function deliveryLabel(delivery) {
  if (!delivery) return "—";
  if (delivery.status === "delivered") return `Delivered${delivery.statusCode ? " · HTTP " + delivery.statusCode : ""}`;
  if (delivery.status === "failed") return `Failed${delivery.error ? " · " + delivery.error : ""}`;
  if (delivery.status === "skipped") return "Not sent · bot alias unset";
  return "Delivering…";
}

function matchesQuery(text) {
  if (!state.q) return true;
  return text.toLowerCase().includes(state.q);
}

function openIncidents(data, envOnly) {
  const list = data?.incidents ?? [];
  return list.filter((incident) => incident.status === "alert" && (!envOnly || incident.env === state.env));
}

let refreshChain = Promise.resolve();

function refresh() {
  const run = refreshChain.then(loadDashboard);
  refreshChain = run.catch(() => {});
  return run;
}

async function loadDashboard() {
  try {
    const response = await fetch(`/api/dashboard?env=${encodeURIComponent(state.env)}&range=${encodeURIComponent(state.range)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    state.error = "";
    if (!state.data.envs.includes(state.env)) state.env = "prod";
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  }
  render();
}

function render() {
  const scrollY = window.scrollY;
  const data = state.data;
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view);
  });
  const crumb = VIEWS[state.view] ?? VIEWS.dashboards;
  $("crumb").innerHTML = `<span>${esc(crumb[0])}</span> / ${esc(crumb[1])}`;
  document.title = `datacat · ${crumb[1]}`;

  const open = openIncidents(data, false);
  const badge = $("incident-badge");
  badge.hidden = open.length === 0;
  badge.textContent = String(open.length);

  $("live-dot").classList.toggle("paused", state.paused);
  $("live-label").textContent = state.paused ? "Paused" : "Live";

  const pushOn = Boolean(data?.settings.pushEnabled);
  $("push-switch").classList.toggle("on", pushOn);
  $("push-btn").setAttribute("aria-pressed", pushOn ? "true" : "false");

  const running = Boolean(data?.generator.running);
  $("gen-dot").classList.toggle("idle", !running);
  $("gen-label").textContent = running ? "Generator live" : "Generator idle";

  renderPickers(data);
  renderBanner(data);
  if (shouldSkipView()) return;
  $("view").innerHTML = viewHtml(data);
  bindCharts();
  window.scrollTo(0, scrollY);
}

function shouldSkipView() {
  const active = document.activeElement;
  if (!active) return false;
  if (active.id === "search") return false;
  return Boolean(active.closest("#settings-form"));
}

function renderPickers(data) {
  const envs = data?.envs ?? ["prod"];
  $("time-picker").innerHTML = `
    <button class="picker-btn" type="button" data-action="toggle-time" aria-expanded="${state.timeOpen}">
      ${esc(rangeLabel(state.range))} ▾
    </button>
    ${state.timeOpen ? `<div class="menu">${RANGES.map(([id, label]) => `
      <button type="button" data-action="range" data-range="${id}" class="${id === state.range ? "selected" : ""}">
        ${esc(label)} ${id === state.range ? "✓" : ""}
      </button>`).join("")}</div>` : ""}`;
  $("env-picker").innerHTML = `
    <button class="picker-btn" type="button" data-action="toggle-env" aria-expanded="${state.envOpen}">
      <span class="var-key">$env</span> ${esc(state.env)} ▾
    </button>
    ${state.envOpen ? `<div class="menu">${envs.map((env) => `
      <button type="button" data-action="env" data-env="${esc(env)}" class="${env === state.env ? "selected" : ""}">
        ${esc(env)} ${env === state.env ? "✓" : ""}
      </button>`).join("")}</div>` : ""}`;
}

function renderBanner(data) {
  const host = $("banner");
  if (state.error) {
    host.innerHTML = `<div class="banner alert" role="alert"><strong>Dashboard request failed</strong><div>${esc(state.error)}</div></div>`;
    return;
  }
  if (!data) {
    host.innerHTML = "";
    return;
  }
  const open = openIncidents(data, true);
  if (open.length) {
    const incident = open[0];
    const spec = data.metrics.find((metric) => metric.id === incident.metric);
    host.innerHTML = `
      <div class="banner alert" role="alert">
        <span class="status alert">ALERT</span>
        <div class="banner-copy">
          <strong>${esc(incident.summary)}</strong>
          <div>${esc(spec?.label ?? incident.metric)} on ${esc(incident.env)} is ${esc(formatValue(spec?.unit, incident.value))} vs baseline ${esc(formatValue(spec?.unit, incident.baseline))} · window ${esc(incident.window)} · ${esc(incident.id)}</div>
          <div class="banner-sub">${esc(deliveryLabel(incident.delivery))}${open.length > 1 ? ` · ${open.length} open` : ""}${data.mode.expected ? " · expected spike also active" : ""}</div>
        </div>
        <button class="btn" type="button" data-action="resolve">Resolve</button>
      </div>`;
    return;
  }
  if (data.mode.expected) {
    host.innerHTML = `
      <div class="banner expected" role="status">
        <span class="status warn">WARN</span>
        <div class="banner-copy">
          <strong>Expected spike · ${esc(data.mode.expectedLabel || "promo launch")}</strong>
          <div>Order volume is elevated on ${esc(data.env)} for a promo launch. Annotated on the charts. Not paging.</div>
        </div>
        <button class="btn" type="button" data-action="resolve">Resolve</button>
      </div>`;
    return;
  }
  host.innerHTML = "";
}

function viewHtml(data) {
  if (!data) return `<p class="loading">Loading samples…</p>`;
  if (state.view === "dashboards") return dashboardHtml(data);
  if (state.view === "monitors") return monitorsHtml(data, true);
  if (state.view === "incidents") return incidentsHtml(data, true);
  if (state.view === "events") return eventsHtml(data, true);
  return settingsHtml(data);
}

function dashboardHtml(data) {
  const source = data.source === "ingest" ? "ingested by the preview runner" : "synthetic generator";
  const metrics = data.metrics.filter((metric) => matchesQuery(`${metric.label} ${metric.id} ${metric.monitor}`));
  const canResolve = data.mode.anomaly || data.mode.expected || openIncidents(data, true).length > 0;
  return `
    <div class="page-head">
      <div>
        <h1>freshcart</h1>
        <p class="sub">grocery checkout · ${esc(state.env)} · ${esc(source)} · ${esc(rangeLabel(state.range))}</p>
      </div>
      <div class="actions">
        <button class="btn btn-danger" type="button" data-action="anomaly" ${state.busy ? "disabled" : ""}>Trigger anomaly</button>
        <button class="btn btn-warn" type="button" data-action="expected" ${state.busy ? "disabled" : ""}>Trigger expected spike</button>
        <button class="btn btn-ok" type="button" data-action="resolve" ${state.busy || !canResolve ? "disabled" : ""}>Resolve</button>
      </div>
    </div>
    <div class="pill-row">
      ${data.metrics.map((metric) => `
        <span class="pill"><span class="status ${metric.status}">${statusLabel(metric.status)}</span>${esc(metric.label)}</span>
      `).join("")}
    </div>
    <div class="grid">
      ${metrics.map((metric) => widgetHtml(metric, data)).join("") || `<p class="empty">No metrics match “${esc(state.q)}”.</p>`}
    </div>
    <div class="split">
      <section class="panel">
        <div class="panel-head"><h2>Incidents</h2><span class="widget-meta">${esc(state.env)} and others</span></div>
        ${incidentTable(data.incidents)}
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Event stream</h2></div>
        ${eventList(data.events.filter((event) => !event.env || event.env === state.env).slice(0, 12))}
      </section>
    </div>`;
}

function widgetHtml(metric, data) {
  const delta = deltaInfo(metric);
  return `
    <article class="widget">
      <div class="widget-top">
        <div class="widget-title">${esc(metric.label)}</div>
        <div class="widget-meta">${esc(metric.id)}</div>
      </div>
      <div class="widget-value ${metric.status === "ok" ? "" : metric.status}">${esc(formatValue(metric.unit, metric.latest))}</div>
      <div class="delta ${delta.cls}">${esc(delta.text)}</div>
      <div class="chart" data-chart="${esc(metric.id)}"></div>
      <div class="legend"><span class="swatch" style="background:${esc(metric.color)}"></span>${esc(metric.description)}</div>
    </article>`;
}

function deltaInfo(metric) {
  const baseline = Number(metric.baseline);
  const latest = Number(metric.latest);
  if (!Number.isFinite(baseline) || (baseline === 0 && latest === 0)) return { text: "flat vs baseline", cls: "" };
  const abs = Math.abs(latest - baseline);
  const pct = baseline === 0 ? (latest === 0 ? 0 : 100) : ((latest - baseline) / Math.abs(baseline)) * 100;
  const small = metric.unit === "count" ? abs < 2 : metric.unit === "ratio" ? abs < 0.004 : Math.abs(pct) < 3;
  if (small && metric.status === "ok") return { text: "flat vs baseline", cls: "" };
  const arrow = pct >= 0 ? "▲" : "▼";
  const text = `${arrow} ${Math.abs(pct).toFixed(1)}% vs baseline`;
  if (metric.status === "alert") return { text, cls: "bad" };
  if (metric.status === "warn") return { text, cls: "warn" };
  return { text, cls: "" };
}

function monitorsHtml(data, full) {
  const rows = data.metrics.filter((metric) => matchesQuery(`${metric.label} ${metric.monitor} ${metric.id}`));
  return `
    ${full ? `<div class="page-head"><div><h1>Monitors</h1><p class="sub">${esc(state.env)} · evaluated from the latest sample</p></div></div>` : ""}
    <section class="panel">
      <table>
        <thead><tr><th>Status</th><th>Monitor</th><th>Env</th><th>Condition</th><th>Latest</th><th>Baseline</th><th></th></tr></thead>
        <tbody>
          ${rows.map((metric) => `
            <tr>
              <td><span class="status ${metric.status}">${statusLabel(metric.status)}</span></td>
              <td><strong>${esc(metric.monitor)}</strong><div class="widget-meta">${esc(metric.id)}</div></td>
              <td>${esc(state.env)}</td>
              <td>${esc(metric.condition)}</td>
              <td>${esc(formatValue(metric.unit, metric.latest))}</td>
              <td>${esc(formatValue(metric.unit, metric.baseline))}</td>
              <td>${spark(metric.points, metric.color)}</td>
            </tr>`).join("") || `<tr><td colspan="7" class="empty">No monitors match.</td></tr>`}
        </tbody>
      </table>
    </section>`;
}

function incidentsHtml(data, full) {
  return `
    ${full ? `<div class="page-head"><div><h1>Incidents</h1><p class="sub">One alert is posted per incident id. A successful delivery is not repeated.</p></div></div>` : ""}
    <section class="panel">${incidentTable(data.incidents)}</section>`;
}

function incidentTable(incidents) {
  const rows = incidents.filter((incident) => matchesQuery(`${incident.id} ${incident.metric} ${incident.env} ${incident.summary}`));
  if (!rows.length) return `<p class="empty">No incidents. Baseline is healthy.</p>`;
  return `
    <table>
      <thead><tr><th>Status</th><th>Incident</th><th>Env</th><th>Metric</th><th>Value</th><th>Baseline</th><th>Opened</th><th>Delivery</th></tr></thead>
      <tbody>
        ${rows.map((incident) => {
          const spec = state.data?.metrics.find((metric) => metric.id === incident.metric);
          const unit = spec?.unit ?? (incident.metric.endsWith("_cents") ? "cents" : incident.metric.endsWith("error_rate") ? "ratio" : incident.metric.includes("latency") ? "ms" : "count");
          const open = state.expanded === incident.id;
          return `
            <tr>
              <td><span class="status ${incident.status === "alert" ? "alert" : "resolved"}">${incident.status === "alert" ? "ALERT" : "RESOLVED"}</span></td>
              <td><div class="mono">${esc(incident.id)}</div><div class="widget-meta">${esc(incident.summary)}</div></td>
              <td>${esc(incident.env)}</td>
              <td>${esc(incident.metric)}</td>
              <td>${esc(formatValue(unit, incident.value))}</td>
              <td>${esc(formatValue(unit, incident.baseline))}</td>
              <td>${esc(formatStamp(incident.openedAt))}</td>
              <td>
                <span class="status ${esc(incident.delivery.status)}">${esc(incident.delivery.status.toUpperCase())}</span>
                <div class="widget-meta">${esc(deliveryLabel(incident.delivery))}</div>
                <button class="linkish" type="button" data-action="expand" data-id="${esc(incident.id)}">${open ? "Hide" : "Response"}</button>
                ${incident.delivery.status === "failed" || incident.delivery.status === "skipped" ? `<button class="linkish" type="button" data-action="redeliver" data-id="${esc(incident.id)}">Retry</button>` : ""}
              </td>
            </tr>
            ${open ? `<tr><td colspan="8"><pre class="response">${esc(responseText(incident))}</pre></td></tr>` : ""}`;
        }).join("")}
      </tbody>
    </table>`;
}

function responseText(incident) {
  const delivery = incident.delivery;
  const lines = [
    `status: ${delivery.status}`,
    `attempts: ${delivery.attempts}`,
    delivery.statusCode ? `http: ${delivery.statusCode}` : "",
    delivery.error ? `error: ${delivery.error}` : "",
    delivery.deliveredAt ? `deliveredAt: ${new Date(delivery.deliveredAt).toISOString()}` : "",
    "",
    delivery.responseBody || "(no response body)",
  ];
  return lines.filter((line, index) => line !== "" || index > 3).join("\n");
}

function eventsHtml(data, full) {
  const filters = ["all", "anomaly", "expected_spike", "alert", "resolve", "ingest", "push"];
  const events = data.events.filter((event) => state.eventFilter === "all" || event.kind === state.eventFilter);
  return `
    ${full ? `<div class="page-head"><div><h1>Events</h1><p class="sub">Anomaly, expected spike, delivery, ingest, and snapshot push.</p></div></div>` : ""}
    <div class="filters">
      ${filters.map((filter) => `<button class="chip ${state.eventFilter === filter ? "on" : ""}" type="button" data-action="filter" data-filter="${filter}">${esc(filter.replace("_", " "))}</button>`).join("")}
    </div>
    <section class="panel">${eventList(events)}</section>`;
}

function eventList(events) {
  if (!events.length) return `<p class="empty">No events yet.</p>`;
  return events.map((event) => `
    <div class="event">
      <time datetime="${esc(new Date(event.t).toISOString())}">${esc(formatClock(event.t))}</time>
      <span class="kind ${esc(event.kind)}">${esc(event.kind.replace("_", " "))}</span>
      <div>${esc(event.message)}</div>
    </div>`).join("");
}

function settingsHtml(data) {
  const settings = data.settings;
  const last = settings.lastPush;
  return `
    <div class="page-head"><div><h1>Integrations</h1><p class="sub">Outbound only. A hosted bot reads alerts and snapshots without dialing this laptop.</p></div></div>
    <form id="settings-form" class="form panel" style="padding:16px">
      <div class="field">
        <label for="bot-alias">Bot alias</label>
        <input id="bot-alias" name="botAlias" value="${esc(settings.botAlias)}" placeholder="https://bot.example">
        <p class="help">Alerts go to <span class="mono">/v1/channels/observability/alert</span>. Snapshots go to <span class="mono">/v1/channels/observability/metrics</span>.</p>
      </div>
      <div class="field">
        <label for="push-interval">Snapshot interval (ms)</label>
        <input id="push-interval" name="pushIntervalMs" type="number" min="2000" step="1000" value="${esc(settings.pushIntervalMs)}">
      </div>
      <div class="actions">
        <button class="btn" type="button" data-action="save-settings">Save</button>
        <button class="btn" type="button" data-action="push-now">Push now</button>
      </div>
      <div class="kv">
        <div><b>Alias token</b>${settings.tokenConfigured ? "Configured" : "Not set"}</div>
        <div><b>Observability token</b>${settings.observabilityTokenConfigured ? "Configured" : "Not set"}</div>
        <div><b>HMAC</b>${settings.hmacConfigured ? esc(settings.hmacHeader) : "Off"}</div>
        <div><b>Last push</b>${esc(last.status)}${last.statusCode ? " · HTTP " + esc(last.statusCode) : ""}${last.error ? " · " + esc(last.error) : ""}</div>
      </div>
      ${last.responseBody ? `<pre class="response">${esc(last.responseBody)}</pre>` : ""}
      <p class="help">The alias token, observability shared secret, and HMAC secret stay in the environment. They are not shown here. HMAC is off unless a webhook secret is set.</p>
    </form>`;
}

function spark(points, color) {
  if (!points.length) return "";
  const width = 120;
  const height = 32;
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    min = Math.min(min, point.v);
    max = Math.max(max, point.v);
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const coords = points.map((point, index) => {
    const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
    const y = height - ((point.v - min) / (max - min)) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><polyline fill="none" stroke="${esc(color)}" stroke-width="1.5" points="${coords}"/></svg>`;
}

function bindCharts() {
  if (!state.data || state.view !== "dashboards") return;
  document.querySelectorAll("[data-chart]").forEach((node) => {
    const metric = state.data.metrics.find((item) => item.id === node.dataset.chart);
    if (metric) drawChart(node, metric, state.data);
  });
}

function drawChart(node, metric, data) {
  const width = Math.max(280, node.clientWidth || 480);
  const height = 168;
  const pad = { l: 56, r: 12, t: 16, b: 22 };
  const points = metric.points;
  if (points.length < 2) {
    node.innerHTML = `<p class="empty">Waiting for samples.</p>`;
    return;
  }
  const first = points[0].t;
  const last = points[points.length - 1].t;
  const windowSpan = Math.max(1, data.to - data.from);
  const zoomed = last - first < windowSpan * 0.5;
  const from = zoomed ? first : data.from;
  const to = Math.max(data.to, last);
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    min = Math.min(min, point.v);
    max = Math.max(max, point.v);
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  min -= span * 0.12;
  max += span * 0.12;
  if (min < 0 && metric.latest >= 0 && metric.baseline >= 0) min = 0;
  const x = (t) => pad.l + ((t - from) / Math.max(1, to - from)) * (width - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / Math.max(1e-9, max - min)) * (height - pad.t - pad.b);
  const tickValues = axisTicks(min, max, 4);
  const line = points.map((point, index) => `${index ? "L" : "M"}${x(point.t).toFixed(1)},${y(point.v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points[points.length - 1].t).toFixed(1)},${y(min).toFixed(1)} L${x(points[0].t).toFixed(1)},${y(min).toFixed(1)} Z`;
  const grid = tickValues.map((value) => {
    const yy = y(value).toFixed(1);
    return `<line x1="${pad.l}" x2="${width - pad.r}" y1="${yy}" y2="${yy}" stroke="#e6e8ee" stroke-width="1"/>
      <text x="${pad.l - 6}" y="${Number(yy) + 3}" text-anchor="end" fill="#8b919d" font-size="10">${esc(tickLabel(metric.unit, value))}</text>`;
  }).join("");
  const xLabels = [0, 0.5, 1].map((fraction) => {
    const t = from + (to - from) * fraction;
    const anchor = fraction === 0 ? "start" : fraction === 1 ? "end" : "middle";
    return `<text x="${x(t).toFixed(1)}" y="${height - 4}" text-anchor="${anchor}" fill="#8b919d" font-size="10">${esc(formatClock(t))}</text>`;
  }).join("");
  const shades = shadeRects(data, metric.id, x, pad, width, height);
  const markers = (data.annotations || []).map((mark) => {
    if (!markAffects(mark.kind, metric.id)) return "";
    if (mark.t < from || mark.t > to) return "";
    const px = x(mark.t);
    const color = mark.kind === "anomaly" ? "#d32f2f" : mark.kind === "expected_spike" ? "#e6a100" : "#2f9e44";
    return `<line x1="${px}" x2="${px}" y1="${pad.t}" y2="${height - pad.b}" stroke="${color}" stroke-dasharray="3 3" stroke-width="1"/>
      <text x="${px + 3}" y="${pad.t + 10}" fill="${color}" font-size="10">${esc(mark.label || "")}</text>`;
  }).join("");
  const gid = `fill-${metric.id}`;
  node.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <defs>
      <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${metric.color}" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="${metric.color}" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    ${grid}
    ${shades}
    <path d="${area}" fill="url(#${gid})"></path>
    <path d="${line}" fill="none" stroke="${metric.color}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"></path>
    ${markers}
    ${xLabels}
    <line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${height - pad.b}" visibility="hidden"></line>
  </svg><div class="tip" hidden></div>`;
  const svg = node.querySelector("svg");
  const tip = node.querySelector(".tip");
  const cross = svg.querySelector(".cross");
  svg.addEventListener("mousemove", (event) => {
    const rect = svg.getBoundingClientRect();
    const scale = width / rect.width;
    const px = (event.clientX - rect.left) * scale;
    let nearest = points[0];
    let best = Infinity;
    for (const point of points) {
      const distance = Math.abs(x(point.t) - px);
      if (distance < best) {
        best = distance;
        nearest = point;
      }
    }
    const nx = x(nearest.t);
    cross.setAttribute("x1", String(nx));
    cross.setAttribute("x2", String(nx));
    cross.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.innerHTML = `<b style="color:${esc(metric.color)}">${esc(formatValue(metric.unit, nearest.v))}</b>${esc(formatStamp(nearest.t))}`;
    const left = Math.min(rect.width - 140, Math.max(8, (nx / scale) + 8));
    tip.style.left = `${left}px`;
    tip.style.top = "8px";
  });
  svg.addEventListener("mouseenter", () => {
    state.hovering = true;
  });
  svg.addEventListener("mouseleave", () => {
    state.hovering = false;
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
  });
}

function markAffects(kind, metricId) {
  const money = ["freshcart.checkout.gmv_cents", "freshcart.checkout.average_order_value_cents"];
  const promo = [
    "freshcart.checkout.orders",
    "freshcart.checkout.units",
    "freshcart.checkout.gmv_cents",
    "freshcart.http.latency_p95_ms",
  ];
  if (kind === "anomaly" || kind === "resolve") return money.includes(metricId);
  if (kind === "expected_spike") return promo.includes(metricId);
  return false;
}

function shadeRects(data, metricId, x, pad, width, height) {
  const boxes = [];
  const right = width - pad.r;
  const top = pad.t;
  const boxHeight = height - pad.t - pad.b;
  if (data.mode.anomaly && data.mode.anomalyAt && markAffects("anomaly", metricId)) {
    const left = Math.max(pad.l, Math.min(right, x(data.mode.anomalyAt)));
    boxes.push(`<rect x="${left}" y="${top}" width="${Math.max(0, right - left)}" height="${boxHeight}" fill="rgba(211,47,47,0.08)"></rect>`);
  }
  if (data.mode.expected && data.mode.expectedAt && markAffects("expected_spike", metricId)) {
    const left = Math.max(pad.l, Math.min(right, x(data.mode.expectedAt)));
    boxes.push(`<rect x="${left}" y="${top}" width="${Math.max(0, right - left)}" height="${boxHeight}" fill="rgba(230,161,0,0.12)"></rect>`);
  }
  return boxes.join("");
}

function axisTicks(min, max, count) {
  const span = max - min || 1;
  const step = niceNum(span / Math.max(1, count - 1));
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let i = 0; i < 8; i += 1) {
    const value = start + i * step;
    if (value > max + step * 0.001) break;
    if (value >= min - step * 0.001) ticks.push(value);
  }
  return ticks.length ? ticks : [min, max];
}

function niceNum(range) {
  const exp = Math.floor(Math.log10(range));
  const fraction = range / 10 ** exp;
  let nice = 10;
  if (fraction < 1.5) nice = 1;
  else if (fraction < 3) nice = 2;
  else if (fraction < 7) nice = 5;
  return nice * 10 ** exp;
}

function tickLabel(unit, value) {
  if (unit === "cents") {
    const dollars = value / 100;
    if (Math.abs(dollars) >= 100) return "$" + Math.round(dollars);
    return "$" + dollars.toFixed(0);
  }
  if (unit === "ratio") return (value * 100).toFixed(Math.abs(value) < 0.02 ? 2 : 1) + "%";
  if (unit === "usd") {
    const abs = Math.abs(value);
    if (abs >= 10000) return "$" + Math.round(value / 1000) + "k";
    if (abs >= 1000) return "$" + (value / 1000).toFixed(1) + "k";
    return "$" + Math.round(value);
  }
  if (Math.abs(value) >= 100) return String(Math.round(value));
  if (Math.abs(value) >= 10) return String(Math.round(value * 10) / 10);
  return String(Math.round(value * 100) / 100);
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      if (payload.error) message = payload.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return response.json();
}

async function runAction(action, node) {
  if (state.busy && ["anomaly", "expected", "resolve", "redeliver", "save-settings", "push-now"].includes(action)) return;
  const settingsPatch = action === "save-settings"
    ? { botAlias: $("bot-alias")?.value ?? "", pushIntervalMs: Number($("push-interval")?.value) }
    : null;
  try {
    if (action === "nav") {
      state.view = node.dataset.view;
      location.hash = `#/${state.view}`;
      state.timeOpen = false;
      state.envOpen = false;
      render();
      return;
    }
    if (action === "toggle-time") {
      state.timeOpen = !state.timeOpen;
      state.envOpen = false;
      render();
      return;
    }
    if (action === "toggle-env") {
      state.envOpen = !state.envOpen;
      state.timeOpen = false;
      render();
      return;
    }
    if (action === "range") {
      state.range = node.dataset.range;
      state.timeOpen = false;
      await refresh();
      return;
    }
    if (action === "env") {
      state.env = node.dataset.env;
      state.envOpen = false;
      await refresh();
      return;
    }
    if (action === "pause") {
      state.paused = !state.paused;
      render();
      return;
    }
    if (action === "expand") {
      state.expanded = state.expanded === node.dataset.id ? null : node.dataset.id;
      render();
      return;
    }
    if (action === "filter") {
      state.eventFilter = node.dataset.filter;
      render();
      return;
    }
    if (action === "toggle-push") {
      await post("/api/settings", { pushEnabled: !state.data?.settings.pushEnabled });
      await refresh();
      return;
    }
    state.busy = true;
    render();
    if (action === "anomaly") await post("/api/anomaly", { env: state.env });
    else if (action === "expected") await post("/api/expected-spike", { env: state.env, label: "promo launch" });
    else if (action === "resolve") await post("/api/resolve", { env: state.env });
    else if (action === "redeliver") await post(`/api/incidents/${encodeURIComponent(node.dataset.id)}/redeliver`, {});
    else if (action === "push-now") await post("/api/push-now", {});
    else if (action === "save-settings") await post("/api/settings", settingsPatch);
    await refresh();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    render();
  } finally {
    if (state.busy) {
      state.busy = false;
      render();
    }
  }
}

document.body.addEventListener("click", (event) => {
  const node = event.target.closest("[data-action]");
  if (!node) {
    if (state.timeOpen || state.envOpen) {
      state.timeOpen = false;
      state.envOpen = false;
      render();
    }
    return;
  }
  event.preventDefault();
  void runAction(node.dataset.action, node);
});

document.body.addEventListener("submit", (event) => {
  if (event.target instanceof HTMLFormElement && event.target.id === "settings-form") {
    event.preventDefault();
    void runAction("save-settings", event.target);
  }
});

$("search").addEventListener("input", (event) => {
  state.q = event.target.value.trim().toLowerCase();
  render();
});

window.addEventListener("hashchange", () => {
  const view = location.hash.replace("#/", "");
  if (VIEWS[view]) state.view = view;
  render();
});

window.addEventListener("resize", () => bindCharts());

const initial = location.hash.replace("#/", "");
if (VIEWS[initial]) state.view = initial;

refresh();
setInterval(() => {
  if (!state.paused && !state.busy && !state.hovering && !state.timeOpen && !state.envOpen) {
    void refresh();
  }
}, 2000);
