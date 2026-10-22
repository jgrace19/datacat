import type { Config } from "./config.ts";
import { DEFAULT_CONFIG, normalizeBotAlias } from "./config.ts";
import {
  BASELINE_WINDOW_LABEL,
  BASELINE_WINDOW_MS,
  METRICS,
  applyMode,
  assertEnvName,
  formatMetric,
  healthyValue,
  isMetricId,
  metricById,
  monitorStatus,
  round4,
  type MetricId,
  type MonitorStatus,
  type ModeFlags,
} from "./metrics.ts";
import { SeriesStore, downsample, type Point } from "./store.ts";
import { signBody } from "./sign.ts";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export type DeliveryStatus = "pending" | "delivered" | "failed" | "skipped";

export type Incident = {
  id: string;
  metric: MetricId;
  env: string;
  baseline: number;
  value: number;
  window: string;
  status: "alert" | "resolved";
  openedAt: number;
  resolvedAt?: number;
  summary: string;
  delivery: {
    status: DeliveryStatus;
    attempts: number;
    statusCode?: number;
    responseBody?: string;
    error?: string;
    deliveredAt?: number;
  };
};

export type LogKind = "anomaly" | "expected_spike" | "resolve" | "ingest" | "alert" | "push" | "info";

export type LogEvent = {
  id: string;
  t: number;
  kind: LogKind;
  level: "info" | "warn" | "alert" | "ok";
  message: string;
  env?: string;
  incidentId?: string;
  label?: string;
};

export type PushStatus = "idle" | "delivered" | "failed" | "skipped";

export type LastPush = {
  at?: number;
  status: PushStatus;
  statusCode?: number;
  error?: string;
  responseBody?: string;
};

export const RANGES = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
} as const;

export type RangeKey = keyof typeof RANGES;

type EnvMode = ModeFlags & {
  anomalyAt?: number;
  expectedAt?: number;
  expectedLabel?: string;
};

type IngestPoint = {
  metric: string;
  v: number;
  t?: number;
};

export type IngestBody = {
  env?: string;
  source?: string;
  metric?: string;
  v?: number;
  t?: number;
  points?: IngestPoint[];
};

const ALERT_PATH = "/v1/channels/observability/alert";
const METRICS_PATH = "/v1/channels/observability/metrics";
const MAX_DELIVERY_ATTEMPTS = 8;
/** How much of the chart the injected regime should occupy on a 1h view. */
const DISPLAY_LEAD_MS = 10 * 60 * 1000;

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randAt(env: string, metric: string, t: number): () => number {
  return mulberry32(hashString(`${env}\0${metric}\0${Math.floor(t)}`) || 1);
}

function mulberry32(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}${suffix}`;
}

function alertPayload(incident: Incident) {
  return {
    incidentId: incident.id,
    metric: incident.metric,
    env: incident.env,
    baseline: incident.baseline,
    value: incident.value,
    window: incident.window,
  };
}

export type CreateAppOptions = {
  config?: Partial<Config>;
  now?: () => number;
  fetchImpl?: typeof fetch;
};

export class DatacatApp {
  readonly config: Config;
  readonly store: SeriesStore;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly modes = new Map<string, EnvMode>();
  private readonly lastT = new Map<string, number>();
  private readonly lastIngestAt = new Map<string, number>();
  private readonly ingestLogAt = new Map<string, number>();
  private incidents: Incident[] = [];
  private events: LogEvent[] = [];
  private seq = 0;
  private loopsStarted = false;
  private genTimer: ReturnType<typeof setInterval> | undefined;
  private pushTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private flushChain: Promise<void> = Promise.resolve();
  private botAlias: string;
  private pushEnabled: boolean;
  private pushIntervalMs: number;
  private lastPush: LastPush = { status: "idle" };

  constructor(options: CreateAppOptions = {}) {
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
    const span = Math.max(this.config.historyHours, 2) * 3_600_000;
    const maxPoints = Math.ceil(span / this.config.generatorIntervalMs) + 2_000;
    this.store = new SeriesStore(maxPoints);
    this.botAlias = this.config.botAlias;
    this.pushEnabled = this.config.metricsPushEnabled;
    this.pushIntervalMs = this.config.metricsPushIntervalMs;
  }

  startLoops(): void {
    this.loopsStarted = true;
    this.genTimer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        console.error("[datacat] generator tick failed", error);
      }
    }, this.config.generatorIntervalMs);
    this.genTimer.unref?.();
    this.reschedulePush();
  }

  stopLoops(): void {
    this.loopsStarted = false;
    if (this.genTimer) clearInterval(this.genTimer);
    if (this.pushTimer) clearInterval(this.pushTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.genTimer = undefined;
    this.pushTimer = undefined;
    this.retryTimer = undefined;
  }

  backfill(env: string, hours: number): void {
    assertEnvName(env);
    if (hours <= 0) return;
    const end = this.now();
    const start = end - hours * 3_600_000;
    const step = this.config.generatorIntervalMs;
    for (let t = start; t <= end; t += step) {
      this.writeSamples(env, t, false);
    }
  }

  tick(at = this.now()): void {
    for (const env of this.generatedEnvs(at)) {
      this.writeSamples(env, this.nextStamp(env, at), true);
    }
  }

  query(metric: string, env: string, from: number, to: number, max = 2000): {
    metric: MetricId;
    env: string;
    from: number;
    to: number;
    points: Point[];
  } {
    const id = this.requireMetric(metric);
    assertEnvName(env);
    if (!Number.isFinite(from) || !Number.isFinite(to)) throw new HttpError(400, "from and to must be numbers");
    if (from > to) throw new HttpError(400, "from must be <= to");
    return {
      metric: id,
      env,
      from,
      to,
      points: downsample(this.store.query(env, id, from, to), max),
    };
  }

  ingest(body: IngestBody): { env: string; accepted: number } {
    const env = body.env ?? "";
    assertEnvName(env);
    if (env === "prod") {
      throw new HttpError(400, "prod is owned by the synthetic generator; ingest preview-<pr> instead");
    }
    const points = this.normalizeIngest(body);
    const mode = this.modeOf(env);
    const transform = mode.anomaly || mode.expected;
    let newest = this.lastIngestAt.get(env) ?? 0;
    for (const point of points) {
      const metric = this.requireMetric(point.metric);
      const t = point.t ?? this.now();
      if (!Number.isFinite(t)) throw new HttpError(400, "point t must be a finite number");
      const value = transform ? applyMode(metric, point.v, mode) : point.v;
      this.store.append(env, metric, t, round4(value));
      if (t > newest) newest = t;
    }
    this.lastIngestAt.set(env, newest);
    const source = (body.source ?? "ingest").slice(0, 40);
    const lastLog = this.ingestLogAt.get(env) ?? 0;
    if (this.now() - lastLog > 30_000) {
      this.ingestLogAt.set(env, this.now());
      this.log({
        kind: "ingest",
        level: "info",
        env,
        label: "ingest",
        message: `Ingested ${points.length} points into ${env} from ${source}.`,
      });
    }
    return { env, accepted: points.length };
  }

  triggerAnomaly(env = "prod", metric = "category_spend"): { incident: Incident; created: boolean } {
    assertEnvName(env);
    const metricId = this.requireMetric(metric);
    const existing = this.incidents.find(
      (incident) => incident.status === "alert" && incident.env === env && incident.metric === metricId,
    );
    if (existing) return { incident: existing, created: false };

    this.ensureHistory(env);
    const now = this.now();
    const start = now - DISPLAY_LEAD_MS;
    const previous = this.store.query(env, metricId, start - BASELINE_WINDOW_MS, start - 1);
    const baseline = previous.length
      ? average(previous.map((point) => point.v))
      : healthyValue(metricId, start, () => 0.5);

    const mode = this.modeOf(env);
    mode.anomaly = true;
    mode.anomalyAt = start;
    this.rewriteRange(env, start, now);
    const latest = this.store.latest(env, metricId);
    const value = latest?.v ?? round4(applyMode(metricId, baseline, mode));

    const incident: Incident = {
      id: this.nid("inc"),
      metric: metricId,
      env,
      baseline: round4(baseline),
      value,
      window: BASELINE_WINDOW_LABEL,
      status: "alert",
      openedAt: now,
      summary: "1st-of-month expenses dropped from spentByCategory",
      delivery: { status: "pending", attempts: 0 },
    };
    this.incidents.push(incident);
    this.log({
      kind: "anomaly",
      level: "alert",
      env,
      incidentId: incident.id,
      label: "drop",
      t: start,
      message: `Anomaly injected on ${env}: 1st-of-month expenses dropped from spentByCategory. ${metricId} is ${formatMetric(metricId, value)} vs baseline ${formatMetric(metricId, incident.baseline)} over ${BASELINE_WINDOW_LABEL}. budget_calc_errors spiked in correlation.`,
    });
    return { incident, created: true };
  }

  triggerExpectedSpike(env = "prod", label = "feature flag launch"): { env: string; label: string; active: true } {
    assertEnvName(env);
    const text = label.trim().slice(0, 80) || "feature flag launch";
    this.ensureHistory(env);
    const now = this.now();
    const mode = this.modeOf(env);
    mode.expected = true;
    mode.expectedAt = now - DISPLAY_LEAD_MS;
    mode.expectedLabel = text;
    const from = Math.min(mode.anomalyAt ?? mode.expectedAt, mode.expectedAt);
    this.rewriteRange(env, from, now);
    this.log({
      kind: "expected_spike",
      level: "warn",
      env,
      label: "feature flag",
      t: mode.expectedAt,
      message: `Expected spike on ${env}: ${text}. request_count and latency are elevated. Annotated, not paged.`,
    });
    return { env, label: text, active: true };
  }

  resolve(options: { env?: string; incidentId?: string } = {}): Incident[] {
    const { env, incidentId } = options;
    if (env) assertEnvName(env);
    const targets = this.incidents.filter((incident) => {
      if (incident.status !== "alert") return false;
      if (incidentId && incident.id !== incidentId) return false;
      if (env && incident.env !== env) return false;
      return true;
    });
    const envs = new Set<string>();
    if (env) envs.add(env);
    for (const incident of targets) envs.add(incident.env);

    const changed: Incident[] = [];
    let cleared = false;
    const now = this.now();
    for (const name of envs) {
      const mode = this.modes.get(name);
      if (mode?.anomaly || mode?.expected) {
        const from = Math.min(mode.anomalyAt ?? now, mode.expectedAt ?? now);
        mode.anomaly = false;
        mode.expected = false;
        mode.anomalyAt = undefined;
        mode.expectedAt = undefined;
        mode.expectedLabel = undefined;
        this.rewriteRange(name, from, now);
        cleared = true;
      }
    }
    for (const incident of targets) {
      incident.status = "resolved";
      incident.resolvedAt = now;
      changed.push(incident);
    }
    if (changed.length === 0 && !cleared) return [];
    const where = env ?? (changed[0]?.env ?? "all");
    this.log({
      kind: "resolve",
      level: "ok",
      env: env ?? changed[0]?.env,
      label: "resolved",
      message: `Resolved ${where}: returned to baseline.`,
    });
    return changed;
  }

  redeliver(id: string): Incident {
    const incident = this.incidents.find((item) => item.id === id);
    if (!incident) throw new HttpError(404, "incident not found");
    if (incident.delivery.status === "delivered") return incident;
    incident.delivery.status = "pending";
    incident.delivery.attempts = 0;
    incident.delivery.error = undefined;
    return incident;
  }

  listIncidents(): Incident[] {
    return this.incidents.slice().reverse();
  }

  listEvents(): LogEvent[] {
    return this.events.slice().reverse();
  }

  updateSettings(patch: { botAlias?: string; pushEnabled?: boolean; pushIntervalMs?: number }): {
    botAlias: string;
    pushEnabled: boolean;
    pushIntervalMs: number;
  } {
    let aliasChanged = false;
    if (patch.botAlias !== undefined) {
      let next: string;
      try {
        next = normalizeBotAlias(patch.botAlias);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : "invalid bot alias");
      }
      aliasChanged = next !== this.botAlias;
      this.botAlias = next;
    }
    if (patch.pushEnabled !== undefined) this.pushEnabled = patch.pushEnabled;
    if (patch.pushIntervalMs !== undefined) {
      if (!Number.isFinite(patch.pushIntervalMs) || patch.pushIntervalMs < 2000) {
        throw new HttpError(400, "pushIntervalMs must be a number >= 2000");
      }
      this.pushIntervalMs = Math.floor(patch.pushIntervalMs);
    }
    if (aliasChanged && this.botAlias) {
      for (const incident of this.incidents) {
        if (incident.delivery.status === "skipped") {
          incident.delivery.status = "pending";
          incident.delivery.error = undefined;
        }
      }
      void this.flushAlerts();
    }
    if (this.loopsStarted) this.reschedulePush();
    this.log({
      kind: "info",
      level: "info",
      label: "settings",
      message: `Settings updated. Push ${this.pushEnabled ? "on" : "off"} every ${this.pushIntervalMs}ms. Bot alias ${this.botAlias || "unset"}.`,
    });
    return {
      botAlias: this.botAlias,
      pushEnabled: this.pushEnabled,
      pushIntervalMs: this.pushIntervalMs,
    };
  }

  dashboard(env: string, range: RangeKey) {
    assertEnvName(env);
    if (!(range in RANGES)) throw new HttpError(400, "range must be 15m, 1h, 4h, or 1d");
    const to = Math.max(this.now(), this.lastT.get(env) ?? 0);
    const from = to - RANGES[range];
    const mode = this.modeOf(env);
    const flags: ModeFlags = { anomaly: mode.anomaly, expected: mode.expected };
    const metrics = METRICS.map((spec) => {
      const points = downsample(this.store.query(env, spec.id, from, to), 360);
      const latestPoint = points[points.length - 1] ?? this.store.latest(env, spec.id);
      const latest = latestPoint?.v ?? 0;
      const before = mode.anomalyAt ? points.filter((point) => point.t < mode.anomalyAt!) : points;
      const pool = before.length > 0 ? before : points;
      const baseline = pool.length ? average(pool.map((point) => point.v)) : 0;
      return {
        ...spec,
        baseline: round4(baseline),
        latest: round4(latest),
        status: points.length === 0 ? ("ok" as MonitorStatus) : monitorStatus(spec.id, latest, baseline, flags),
        points,
      };
    });
    const annotations = this.events
      .filter(
        (event) =>
          event.env === env &&
          event.t >= from &&
          event.t <= to &&
          (event.kind === "anomaly" || event.kind === "expected_spike" || event.kind === "resolve"),
      )
      .map((event) => ({ t: event.t, kind: event.kind, label: event.label ?? event.kind }));
    return {
      now: this.now(),
      env,
      envs: this.envList(),
      range,
      from,
      to,
      source: env === "prod" ? "synthetic" : this.lastIngestAt.has(env) ? "ingest" : "synthetic",
      lastIngestAt: this.lastIngestAt.get(env) ?? null,
      mode: {
        anomaly: mode.anomaly,
        anomalyAt: mode.anomalyAt ?? null,
        expected: mode.expected,
        expectedAt: mode.expectedAt ?? null,
        expectedLabel: mode.expectedLabel ?? null,
      },
      generator: {
        running: this.loopsStarted,
        intervalMs: this.config.generatorIntervalMs,
      },
      metrics,
      annotations,
      incidents: this.listIncidents().slice(0, 50),
      events: this.listEvents().slice(0, 100),
      settings: this.settingsView(),
    };
  }

  settingsView() {
    return {
      botAlias: this.botAlias,
      tokenConfigured: this.config.agentAliasToken.length > 0,
      observabilityTokenConfigured: this.config.observabilitySharedSecret.length > 0,
      hmacConfigured: this.config.webhookSecret.length > 0,
      hmacHeader: this.config.hmacHeader,
      pushEnabled: this.pushEnabled,
      pushIntervalMs: this.pushIntervalMs,
      lastPush: this.lastPush,
    };
  }

  flushAlerts(): Promise<void> {
    const run = this.flushChain.then(() => this.flushOnce());
    this.flushChain = run.catch((error) => {
      console.error("[datacat] alert flush failed", error);
    });
    return run;
  }

  async pushMetricsOnce(options: { force?: boolean } = {}): Promise<LastPush> {
    if (!this.pushEnabled && !options.force) {
      return this.notePush("skipped", { error: "push disabled" });
    }
    if (!this.botAlias) {
      return this.notePush("skipped", { error: "BOT_ALIAS is not set" });
    }
    const now = this.now();
    const from = now - 5 * 60 * 1000;
    const snapshots = [];
    for (const env of this.envList()) {
      for (const spec of METRICS) {
        const points = downsample(this.store.query(env, spec.id, from, now), 30);
        if (points.length === 0 && env !== "prod") continue;
        const latest = points[points.length - 1]?.v ?? this.store.latest(env, spec.id)?.v ?? null;
        const baseline = points.length ? round4(average(points.map((point) => point.v))) : null;
        const mode = this.modeOf(env);
        snapshots.push({
          env,
          metric: spec.id,
          unit: spec.unit,
          latest: latest === null ? null : round4(latest),
          baseline,
          status:
            latest === null
              ? "ok"
              : monitorStatus(spec.id, latest, baseline ?? latest, { anomaly: mode.anomaly, expected: mode.expected }),
          points,
        });
      }
    }
    const payload = {
      sentAt: new Date(now).toISOString(),
      snapshots,
      openIncidents: this.incidents
        .filter((incident) => incident.status === "alert")
        .map((incident) => alertPayload(incident)),
    };
    const body = JSON.stringify(payload);
    try {
      const response = await this.fetchImpl(joinUrl(this.botAlias, METRICS_PATH), {
        method: "POST",
        headers: this.authHeaders(body, "metrics:snapshot"),
        body,
        signal: AbortSignal.timeout(5000),
      });
      const text = (await response.text()).slice(0, 2000);
      if (!response.ok) {
        return this.notePush("failed", { statusCode: response.status, responseBody: text, error: `HTTP ${response.status}` });
      }
      return this.notePush("delivered", { statusCode: response.status, responseBody: text });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.notePush("failed", { error: message });
    }
  }

  private async flushOnce(): Promise<void> {
    for (const incident of this.incidents) {
      if (incident.delivery.status === "delivered") continue;
      if (incident.delivery.status === "skipped" && !this.botAlias) continue;
      if (incident.delivery.status === "failed" && incident.delivery.attempts >= MAX_DELIVERY_ATTEMPTS) continue;
      await this.deliver(incident);
    }
    if (!this.loopsStarted) return;
    const needsRetry = this.incidents.some(
      (incident) => incident.delivery.status === "failed" && incident.delivery.attempts < MAX_DELIVERY_ATTEMPTS,
    );
    if (needsRetry) this.scheduleRetry();
  }

  private async deliver(incident: Incident): Promise<void> {
    if (incident.delivery.status === "delivered") return;
    if (!this.botAlias) {
      if (incident.delivery.status !== "skipped") {
        incident.delivery.status = "skipped";
        incident.delivery.error = "BOT_ALIAS is not set";
        this.log({
          kind: "alert",
          level: "warn",
          env: incident.env,
          incidentId: incident.id,
          label: "not sent",
          message: `Alert ${incident.id} not sent: BOT_ALIAS is not set.`,
        });
      }
      return;
    }
    const payload = alertPayload(incident);
    const body = JSON.stringify(payload);
    incident.delivery.attempts += 1;
    try {
      const response = await this.fetchImpl(joinUrl(this.botAlias, ALERT_PATH), {
        method: "POST",
        headers: this.authHeaders(body, `incident:${incident.id}`),
        body,
        signal: AbortSignal.timeout(5000),
      });
      const text = (await response.text()).slice(0, 2000);
      incident.delivery.statusCode = response.status;
      incident.delivery.responseBody = text;
      if (response.ok) {
        incident.delivery.status = "delivered";
        incident.delivery.deliveredAt = this.now();
        incident.delivery.error = undefined;
        this.log({
          kind: "alert",
          level: "ok",
          env: incident.env,
          incidentId: incident.id,
          label: "delivered",
          message: `Alert ${incident.id} delivered (HTTP ${response.status}).`,
        });
        return;
      }
      incident.delivery.status = "failed";
      incident.delivery.error = `HTTP ${response.status}`;
      this.log({
        kind: "alert",
        level: "alert",
        env: incident.env,
        incidentId: incident.id,
        label: "failed",
        message: `Alert ${incident.id} delivery failed (HTTP ${response.status}).`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      incident.delivery.status = "failed";
      incident.delivery.error = message;
      this.log({
        kind: "alert",
        level: "alert",
        env: incident.env,
        incidentId: incident.id,
        label: "failed",
        message: `Alert ${incident.id} delivery failed: ${message}`,
      });
    }
  }

  private authHeaders(body: string, sessionKey: string): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "datacat",
      "X-BDK-Session-Key": sessionKey,
    };
    if (this.config.agentAliasToken) headers["X-Agent-Alias-Token"] = this.config.agentAliasToken;
    if (this.config.observabilitySharedSecret) {
      headers["X-Observability-Token"] = this.config.observabilitySharedSecret;
    }
    // HMAC stays off unless DATACAT_WEBHOOK_SECRET is set. Hosted bots reject
    // X-BDK-Session-Key when the body is also signed, so the default is no signature.
    if (this.config.webhookSecret) headers[this.config.hmacHeader] = signBody(this.config.webhookSecret, body);
    return headers;
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flushAlerts();
    }, 3000);
    this.retryTimer.unref?.();
  }

  private notePush(
    status: Exclude<PushStatus, "idle">,
    extra: { statusCode?: number; error?: string; responseBody?: string },
  ): LastPush {
    const previous = this.lastPush.status;
    this.lastPush = { at: this.now(), status, ...extra };
    if (previous !== status) {
      const detail = extra.error ? `: ${extra.error}` : extra.statusCode ? ` (HTTP ${extra.statusCode})` : "";
      this.log({
        kind: "push",
        level: status === "delivered" ? "ok" : "warn",
        label: status,
        message: `Snapshot push ${status}${detail}.`,
      });
    }
    return this.lastPush;
  }

  private reschedulePush(): void {
    if (this.pushTimer) clearInterval(this.pushTimer);
    this.pushTimer = undefined;
    if (!this.pushEnabled || !this.loopsStarted) return;
    this.pushTimer = setInterval(() => {
      void this.pushMetricsOnce().catch((error) => {
        console.error("[datacat] metrics push failed", error);
      });
    }, this.pushIntervalMs);
    this.pushTimer.unref?.();
  }

  private generatedEnvs(at: number): string[] {
    const envs = new Set<string>(["prod"]);
    for (const [env, mode] of this.modes) {
      if (env === "prod" || (!mode.anomaly && !mode.expected)) continue;
      const lastIngest = this.lastIngestAt.get(env) ?? 0;
      if (at - lastIngest < this.config.generatorIntervalMs * 3) continue;
      envs.add(env);
    }
    return [...envs];
  }

  private ensureHistory(env: string): void {
    if (this.store.latest(env, "category_spend")) return;
    const hours = this.config.historyHours > 0 ? Math.min(this.config.historyHours, 6) : 2;
    this.backfill(env, hours);
  }

  private writeSamples(env: string, t: number, transform: boolean): void {
    const mode = this.modeOf(env);
    for (const spec of METRICS) {
      const healthy = healthyValue(spec.id, t, randAt(env, spec.id, t));
      const value = transform ? applyMode(spec.id, healthy, mode) : healthy;
      this.store.append(env, spec.id, t, round4(value));
    }
    const previous = this.lastT.get(env) ?? 0;
    if (t > previous) this.lastT.set(env, t);
  }

  /** Recompute stored samples in [start, now] from the deterministic baseline and the current mode. */
  private rewriteRange(env: string, start: number, now: number): void {
    const mode = this.modeOf(env);
    let replaced = false;
    for (const spec of METRICS) {
      const existing = this.store.query(env, spec.id, start, now);
      for (const point of existing) {
        replaced = true;
        const healthy = healthyValue(spec.id, point.t, randAt(env, spec.id, point.t));
        const value = mode.anomaly || mode.expected ? applyMode(spec.id, healthy, mode) : healthy;
        this.store.append(env, spec.id, point.t, round4(value));
      }
    }
    if (!replaced) {
      const step = this.config.generatorIntervalMs;
      for (let t = start; t <= now; t += step) this.writeSamples(env, t, true);
      return;
    }
    const latest = this.lastT.get(env) ?? 0;
    if (latest < now) this.writeSamples(env, now, true);
  }

  private nextStamp(env: string, now: number): number {
    const last = this.lastT.get(env) ?? 0;
    return now > last ? now : last + 1;
  }

  private modeOf(env: string): EnvMode {
    let mode = this.modes.get(env);
    if (!mode) {
      mode = { anomaly: false, expected: false };
      this.modes.set(env, mode);
    }
    return mode;
  }

  private envList(): string[] {
    const found = new Set<string>(["prod", ...this.store.envs(), ...this.modes.keys()]);
    return [...found].sort((a, b) => {
      if (a === "prod") return -1;
      if (b === "prod") return 1;
      return a.localeCompare(b);
    });
  }

  private requireMetric(metric: string): MetricId {
    if (!isMetricId(metric)) throw new HttpError(400, `unknown metric ${JSON.stringify(metric)}`);
    return metric;
  }

  private normalizeIngest(body: IngestBody): Array<{ metric: string; v: number; t?: number }> {
    const points: Array<{ metric: string; v: number; t?: number }> = [];
    if (Array.isArray(body.points)) {
      for (const point of body.points) {
        if (!point || typeof point !== "object") throw new HttpError(400, "each point must be an object");
        points.push(point);
      }
    } else if (body.metric !== undefined || body.v !== undefined) {
      points.push({ metric: body.metric ?? "", v: body.v ?? Number.NaN, t: body.t });
    }
    if (points.length === 0) throw new HttpError(400, "ingest requires points");
    if (points.length > 1000) throw new HttpError(400, "ingest accepts at most 1000 points");
    for (const point of points) {
      if (!isMetricId(point.metric)) throw new HttpError(400, `unknown metric ${JSON.stringify(point.metric)}`);
      if (typeof point.v !== "number" || !Number.isFinite(point.v)) {
        throw new HttpError(400, `value for ${point.metric} must be a finite number`);
      }
    }
    return points;
  }

  private log(event: Omit<LogEvent, "id" | "t"> & { t?: number }): LogEvent {
    const entry: LogEvent = {
      id: this.nid("evt"),
      t: event.t ?? this.now(),
      kind: event.kind,
      level: event.level,
      message: event.message,
      env: event.env,
      incidentId: event.incidentId,
      label: event.label,
    };
    this.events.push(entry);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    return entry;
  }

  private nid(prefix: string): string {
    this.seq += 1;
    const rand = Math.random().toString(36).slice(2, 6);
    return `${prefix}_${this.now().toString(36)}_${this.seq.toString(36)}_${rand}`;
  }
}

export function isRangeKey(value: string): value is RangeKey {
  return value in RANGES;
}

export function metricKnown(id: string): boolean {
  return metricById(id) !== undefined;
}
