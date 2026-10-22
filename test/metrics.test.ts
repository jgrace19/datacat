import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import {
  ANOMALY_AOV_CENTS,
  ANOMALY_PRICE_FACTOR,
  AOV_CENTS,
  ERROR_RATE,
  GMV_CENTS,
  HEALTHY_AOV_CENTS,
  LATENCY_P95_MS,
  ORDERS,
  UNITS,
  applySample,
  monitorStatus,
  sampleHealthy,
} from "../src/metrics.ts";
import { signBody } from "../src/sign.ts";

const half = () => 0.5;
const now = Date.UTC(2026, 9, 22, 16, 0, 0);

test("healthy freshcart checkout matches the GreenMart basket", () => {
  const sample = sampleHealthy(now, half);
  assert.equal(sample[ORDERS], 4);
  assert.equal(sample[UNITS], 28);
  assert.ok(Math.abs(sample[AOV_CENTS] - HEALTHY_AOV_CENTS) < 40);
  assert.equal(sample[GMV_CENTS], sample[ORDERS] * sample[AOV_CENTS]);
  assert.ok(sample[LATENCY_P95_MS] > 80 && sample[LATENCY_P95_MS] < 200);
  assert.ok(sample[ERROR_RATE] >= 0 && sample[ERROR_RATE] < 0.02);
  const calm = { anomaly: false, expected: false };
  assert.equal(monitorStatus(AOV_CENTS, sample[AOV_CENTS], sample[AOV_CENTS], calm), "ok");
  assert.equal(monitorStatus(ORDERS, sample[ORDERS], sample[ORDERS], calm), "ok");
});

test("anomaly drops GMV and AOV about 32% and a promo lifts volume only", () => {
  const healthy = sampleHealthy(now, half);
  const anomaly = applySample(healthy, { anomaly: true, expected: false });
  assert.equal(anomaly[ORDERS], healthy[ORDERS]);
  assert.equal(anomaly[UNITS], healthy[UNITS]);
  assert.equal(anomaly[AOV_CENTS], Math.round(healthy[AOV_CENTS] * ANOMALY_PRICE_FACTOR));
  assert.equal(anomaly[GMV_CENTS], Math.round(healthy[GMV_CENTS] * ANOMALY_PRICE_FACTOR));
  assert.ok(Math.abs(anomaly[AOV_CENTS] - ANOMALY_AOV_CENTS) < 40);
  assert.ok(anomaly[AOV_CENTS] < healthy[AOV_CENTS] * 0.75);
  const flags = { anomaly: true, expected: false };
  assert.equal(monitorStatus(AOV_CENTS, anomaly[AOV_CENTS], healthy[AOV_CENTS], flags), "alert");
  assert.equal(monitorStatus(GMV_CENTS, anomaly[GMV_CENTS], healthy[GMV_CENTS], flags), "alert");
  assert.equal(monitorStatus(ORDERS, anomaly[ORDERS], healthy[ORDERS], flags), "ok");

  const promo = applySample(healthy, { anomaly: false, expected: true });
  assert.equal(promo[ORDERS], 10);
  assert.equal(promo[UNITS], 67);
  assert.equal(promo[AOV_CENTS], healthy[AOV_CENTS]);
  assert.ok(promo[GMV_CENTS] > healthy[GMV_CENTS] * 2);
  assert.ok(promo[LATENCY_P95_MS] > healthy[LATENCY_P95_MS]);
  const halfway = (1 + ANOMALY_PRICE_FACTOR) / 2;
  const climbing = applySample(healthy, { anomaly: false, expected: false, priceFactor: halfway });
  assert.equal(climbing[ORDERS], healthy[ORDERS]);
  assert.ok(climbing[AOV_CENTS] > anomaly[AOV_CENTS] + 200);
  assert.ok(climbing[AOV_CENTS] < healthy[AOV_CENTS] - 200);
  assert.equal(climbing[GMV_CENTS], Math.round(healthy[GMV_CENTS] * halfway));

  const expected = { anomaly: false, expected: true };
  assert.equal(monitorStatus(ORDERS, promo[ORDERS], healthy[ORDERS], expected), "warn");
  assert.equal(monitorStatus(LATENCY_P95_MS, promo[LATENCY_P95_MS], healthy[LATENCY_P95_MS], expected), "warn");
  assert.equal(monitorStatus(AOV_CENTS, promo[AOV_CENTS], healthy[AOV_CENTS], expected), "ok");
});

test("signBody is sha256 of the raw body", () => {
  const body = JSON.stringify({ incidentId: "inc_1" });
  const expected = `sha256=${createHmac("sha256", "topsecret").update(body).digest("hex")}`;
  assert.equal(signBody("topsecret", body), expected);
});
