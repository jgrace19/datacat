export const METRICS = [
  {
    id: "category_spend",
    label: "Category spend",
    unit: "usd" as const,
    color: "#6D4BD1",
    description: "spentByCategory total",
    monitor: "Month-to-date category spend dropped",
    condition: "below 70% of the 5m baseline",
  },
  {
    id: "budget_calc_errors",
    label: "Budget calc errors",
    unit: "count" as const,
    color: "#E07A12",
    description: "Budget calculation failures per interval",
    monitor: "Budget calculation errors elevated",
    condition: "at least 20 per interval",
  },
  {
    id: "request_latency_p95_ms",
    label: "Request latency p95",
    unit: "ms" as const,
    color: "#2F6FED",
    description: "p95 request latency",
    monitor: "p95 latency high",
    condition: "at least 200 ms",
  },
  {
    id: "error_rate",
    label: "Error rate",
    unit: "ratio" as const,
    color: "#D23B3B",
    description: "Share of requests that fail",
    monitor: "Request error rate high",
    condition: "at least 2%",
  },
  {
    id: "request_count",
    label: "Request count",
    unit: "count" as const,
    color: "#1AA6A6",
    description: "Requests observed per interval",
    monitor: "Request volume elevated",
    condition: "above 2.2× the baseline",
  },
] as const;

export type MetricId = (typeof METRICS)[number]["id"];
export type MetricSpec = (typeof METRICS)[number];
export type MetricUnit = MetricSpec["unit"];

export const BASELINE_WINDOW_MS = 5 * 60 * 1000;
export const BASELINE_WINDOW_LABEL = "5m";

/** Share of category spend that remains when 1st-of-month expenses are missing. */
export const ANOMALY_SPEND_FACTOR = 0.42;
export const ANOMALY_ERROR_ADD = 38;

export function isMetricId(value: string): value is MetricId {
  return METRICS.some((metric) => metric.id === value);
}

export function metricById(id: string): MetricSpec | undefined {
  return METRICS.find((metric) => metric.id === id);
}

export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** 0 at the trough, 1 at the peak. UTC so a laptop timezone does not change the shape. */
function diurnal(t: number): number {
  const date = new Date(t);
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  return 0.5 + 0.5 * Math.sin(((hour - 10) / 24) * Math.PI * 2);
}

/**
 * Healthy reading for one interval.
 * `rand` should return values in [0, 1). It is called exactly twice.
 */
export function healthyValue(metric: MetricId, t: number, rand: () => number): number {
  const wave = diurnal(t);
  const r1 = rand();
  const r2 = rand();
  switch (metric) {
    case "category_spend": {
      const day = new Date(t).getUTCDate();
      const base = 22_000 + day * 3_400;
      const wobble = Math.sin(t / 3_600_000) * 700;
      return base + wobble + (r1 - 0.5) * 500 + (r2 - 0.5) * 200;
    }
    case "budget_calc_errors": {
      const rare = r1 < 0.06 ? 2 : 0;
      const extra = r2 < 0.3 ? 1 : 0;
      return rare + extra;
    }
    case "request_latency_p95_ms":
      return 90 + wave * 55 + r1 * 18 + r2 * 6;
    case "error_rate":
      return Math.max(0, 0.003 + wave * 0.003 + (r1 - 0.5) * 0.0015 + (r2 - 0.5) * 0.0008);
    case "request_count":
      return Math.round(42 + wave * 34 + r1 * 8 + r2 * 4);
  }
}

export type ModeFlags = {
  anomaly: boolean;
  expected: boolean;
};

/**
 * Anomaly: 1st-of-month expenses disappear from spentByCategory, and budget
 * calculation errors jump with them. Expected spike: a feature-flag launch
 * raises traffic and latency without paging.
 * The two modes compose so a demo can show both at once.
 */
export function applyMode(metric: MetricId, healthy: number, mode: ModeFlags): number {
  let value = healthy;
  if (mode.anomaly) {
    if (metric === "category_spend") value = Math.max(0, healthy * ANOMALY_SPEND_FACTOR);
    else if (metric === "budget_calc_errors") value = healthy + ANOMALY_ERROR_ADD;
    else if (metric === "error_rate") value = Math.min(1, healthy + 0.021);
  }
  if (mode.expected) {
    if (metric === "request_count") value = healthy * 2.7;
    else if (metric === "request_latency_p95_ms") value = healthy * 1.85;
  }
  return value;
}

export type MonitorStatus = "ok" | "warn" | "alert";

export function monitorStatus(metric: MetricId, latest: number, baseline: number, mode: ModeFlags): MonitorStatus {
  switch (metric) {
    case "category_spend":
      if (mode.anomaly) return "alert";
      if (baseline > 0 && latest < baseline * 0.7) return "alert";
      return "ok";
    case "budget_calc_errors":
      if (latest >= 20) return "alert";
      if (latest >= 8) return "warn";
      return "ok";
    case "error_rate":
      if (latest >= 0.05) return "alert";
      if (latest >= 0.02) return "warn";
      return "ok";
    case "request_latency_p95_ms":
      if (latest >= 400) return "alert";
      if (latest >= 200 || mode.expected) return "warn";
      return "ok";
    case "request_count":
      if (mode.expected) return "warn";
      if (baseline > 0 && latest > baseline * 2.2) return "warn";
      return "ok";
  }
}

export function formatMetric(metric: string, value: number): string {
  const spec = metricById(metric);
  const rounded = Math.round(value);
  const grouped = groupInteger(rounded);
  if (!spec) return grouped;
  if (spec.unit === "usd") return `$${grouped}`;
  if (spec.unit === "ms") return `${grouped} ms`;
  if (spec.unit === "ratio") return `${(value * 100).toFixed(2)}%`;
  return grouped;
}

function groupInteger(value: number): string {
  const sign = value < 0 ? "-" : "";
  const digits = Math.abs(value).toString();
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function assertEnvName(env: string): void {
  if (!/^(prod|preview-[A-Za-z0-9._-]{1,80})$/.test(env)) {
    throw new EnvNameError(env);
  }
}

export class EnvNameError extends Error {
  constructor(env: string) {
    super(`env must be "prod" or "preview-<name>", received ${JSON.stringify(env)}`);
    this.name = "EnvNameError";
  }
}
