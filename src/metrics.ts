export const ORDERS = "freshcart.checkout.orders";
export const UNITS = "freshcart.checkout.units";
export const GMV_CENTS = "freshcart.checkout.gmv_cents";
export const AOV_CENTS = "freshcart.checkout.average_order_value_cents";
export const LATENCY_P95_MS = "freshcart.http.latency_p95_ms";
export const ERROR_RATE = "freshcart.http.error_rate";

/** Healthy GreenMart basket from the marketplace demo: 7 units, $34.83. */
export const HEALTHY_AOV_CENTS = 3483;
/** Same basket when multi-quantity lines are charged at the unit price only: $23.56. */
export const ANOMALY_AOV_CENTS = 2356;
export const ANOMALY_PRICE_FACTOR = ANOMALY_AOV_CENTS / HEALTHY_AOV_CENTS;
export const UNITS_PER_ORDER = 7;
export const PROMO_LIFT = 2.4;

export const METRICS = [
  {
    id: ORDERS,
    label: "Orders",
    unit: "count" as const,
    color: "#1AA6A6",
    description: "Completed checkouts",
    monitor: "Checkout orders",
    condition: "volume stays flat unless a promo is annotated",
  },
  {
    id: UNITS,
    label: "Units",
    unit: "count" as const,
    color: "#2F6FED",
    description: "Pick quantity across orders",
    monitor: "Checkout units",
    condition: "volume stays flat unless a promo is annotated",
  },
  {
    id: GMV_CENTS,
    label: "GMV",
    unit: "cents" as const,
    color: "#6D4BD1",
    description: "Charged subtotal",
    monitor: "GMV dropped",
    condition: "below 80% of the 5m baseline",
  },
  {
    id: AOV_CENTS,
    label: "Average order value",
    unit: "cents" as const,
    color: "#E07A12",
    description: "Charged subtotal per order",
    monitor: "AOV dropped",
    condition: "below 80% of the 5m baseline",
  },
  {
    id: LATENCY_P95_MS,
    label: "Request latency p95",
    unit: "ms" as const,
    color: "#5B6CFF",
    description: "p95 API latency",
    monitor: "p95 latency high",
    condition: "at least 220 ms",
  },
  {
    id: ERROR_RATE,
    label: "Error rate",
    unit: "ratio" as const,
    color: "#D23B3B",
    description: "Share of API requests that fail",
    monitor: "Request error rate high",
    condition: "at least 2%",
  },
] as const;

export type MetricId = (typeof METRICS)[number]["id"];
export type MetricSpec = (typeof METRICS)[number];
export type MetricUnit = MetricSpec["unit"];
export type Sample = Record<MetricId, number>;

export const PRIMARY_METRIC: MetricId = AOV_CENTS;
export const EXPECTED_LABEL = "promo launch";

export const BASELINE_WINDOW_MS = 5 * 60 * 1000;
export const BASELINE_WINDOW_LABEL = "5m";

export function isMetricId(value: string): value is MetricId {
  return METRICS.some((metric) => metric.id === value);
}

export function metricById(id: string): MetricSpec | undefined {
  return METRICS.find((metric) => metric.id === id);
}

export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function diurnal(t: number): number {
  const date = new Date(t);
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  return 0.5 + 0.5 * Math.sin(((hour - 10) / 24) * Math.PI * 2);
}

/**
 * One interval of healthy FreshCart checkout.
 * Orders stay at 4 and units at 28, matching the demo basket run.
 * AOV wobbles around 3483 cents. `rand` is called exactly twice.
 */
export function sampleHealthy(t: number, rand: () => number): Sample {
  const r1 = rand();
  const r2 = rand();
  const wave = diurnal(t);
  const orders = 4;
  const aov = Math.round(HEALTHY_AOV_CENTS + (r1 - 0.5) * 36 + Math.sin(t / 3_600_000) * 18);
  return {
    [ORDERS]: orders,
    [UNITS]: orders * UNITS_PER_ORDER,
    [AOV_CENTS]: aov,
    [GMV_CENTS]: orders * aov,
    [LATENCY_P95_MS]: 90 + wave * 55 + r2 * 18,
    [ERROR_RATE]: Math.max(0, 0.003 + wave * 0.003 + (r1 - 0.5) * 0.001),
  };
}

export function healthyValue(metric: MetricId, t: number, rand: () => number): number {
  return sampleHealthy(t, rand)[metric];
}

export type ModeFlags = {
  anomaly: boolean;
  expected: boolean;
  /** Scales GMV and AOV. `1` is healthy. Omit it to follow `anomaly`. */
  priceFactor?: number;
};

/**
 * Anomaly: multi-quantity lines are charged at the catalog unit price, so GMV
 * and AOV fall by about 32% (AOV ~2356 cents) while orders and units stay flat.
 * Expected spike: a promo launch lifts order volume. It is annotated and not paged.
 */
export function applyMode(metric: MetricId, healthy: number, mode: ModeFlags): number {
  let value = healthy;
  const factor = mode.priceFactor !== undefined ? mode.priceFactor : mode.anomaly ? ANOMALY_PRICE_FACTOR : 1;
  if ((metric === GMV_CENTS || metric === AOV_CENTS) && factor !== 1) {
    value = Math.round(healthy * factor);
  }
  if (mode.expected) {
    if (metric === ORDERS || metric === UNITS || metric === GMV_CENTS) value = Math.round(value * PROMO_LIFT);
    else if (metric === LATENCY_P95_MS) value = healthy * 1.45;
  }
  return value;
}

export function applySample(sample: Sample, mode: ModeFlags): Sample {
  const next = { ...sample };
  for (const spec of METRICS) {
    next[spec.id] = applyMode(spec.id, sample[spec.id], mode);
  }
  return next;
}

export type MonitorStatus = "ok" | "warn" | "alert";

export function monitorStatus(metric: MetricId, latest: number, baseline: number, mode: ModeFlags): MonitorStatus {
  switch (metric) {
    case GMV_CENTS:
    case AOV_CENTS:
      if (mode.anomaly) return "alert";
      if (baseline > 0 && latest < baseline * 0.8) return "alert";
      return "ok";
    case ORDERS:
    case UNITS:
      if (mode.expected) return "warn";
      if (baseline > 0 && latest > baseline * 2.2) return "warn";
      return "ok";
    case ERROR_RATE:
      if (latest >= 0.05) return "alert";
      if (latest >= 0.02) return "warn";
      return "ok";
    case LATENCY_P95_MS:
      if (latest >= 400) return "alert";
      if (latest >= 220 || mode.expected) return "warn";
      return "ok";
  }
}

export function formatMetric(metric: string, value: number): string {
  const spec = metricById(metric);
  if (spec?.unit === "cents") return formatCents(value);
  const grouped = groupInteger(Math.round(value));
  if (!spec) return grouped;
  if (spec.unit === "ms") return `${grouped} ms`;
  if (spec.unit === "ratio") return `${(value * 100).toFixed(2)}%`;
  return grouped;
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${sign}$${groupInteger(dollars)}.${frac}`;
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
