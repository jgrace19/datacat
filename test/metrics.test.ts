import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import {
  ANOMALY_ERROR_ADD,
  ANOMALY_SPEND_FACTOR,
  applyMode,
  healthyValue,
  monitorStatus,
} from "../src/metrics.ts";
import { signBody } from "../src/sign.ts";

const half = () => 0.5;
const now = Date.UTC(2026, 9, 22, 16, 0, 0);

test("healthy budgetsphere series stay inside the ok band", () => {
  const spend = healthyValue("category_spend", now, half);
  const errors = healthyValue("budget_calc_errors", now, half);
  const latency = healthyValue("request_latency_p95_ms", now, half);
  const errorRate = healthyValue("error_rate", now, half);
  const count = healthyValue("request_count", now, half);
  assert.ok(spend > 50_000 && spend < 150_000, String(spend));
  assert.ok(errors >= 0 && errors < 8);
  assert.ok(latency > 80 && latency < 200);
  assert.ok(errorRate >= 0 && errorRate < 0.02);
  assert.ok(count > 20 && count < 120);
  assert.equal(monitorStatus("category_spend", spend, spend, { anomaly: false, expected: false }), "ok");
  assert.equal(monitorStatus("budget_calc_errors", errors, errors, { anomaly: false, expected: false }), "ok");
});

test("anomaly drops category spend and spikes calc errors; expected spike raises traffic", () => {
  const spend = healthyValue("category_spend", now, half);
  const errors = healthyValue("budget_calc_errors", now, half);
  const dropped = applyMode("category_spend", spend, { anomaly: true, expected: false });
  const spiked = applyMode("budget_calc_errors", errors, { anomaly: true, expected: false });
  assert.equal(dropped, spend * ANOMALY_SPEND_FACTOR);
  assert.ok(dropped < spend * 0.6);
  assert.equal(spiked, errors + ANOMALY_ERROR_ADD);
  assert.equal(monitorStatus("category_spend", dropped, spend, { anomaly: true, expected: false }), "alert");
  assert.equal(monitorStatus("budget_calc_errors", spiked, errors, { anomaly: true, expected: false }), "alert");

  const count = healthyValue("request_count", now, half);
  const latency = healthyValue("request_latency_p95_ms", now, half);
  const busy = applyMode("request_count", count, { anomaly: false, expected: true });
  const slower = applyMode("request_latency_p95_ms", latency, { anomaly: false, expected: true });
  assert.ok(busy > count * 2);
  assert.ok(slower > latency * 1.5);
  assert.equal(monitorStatus("request_count", busy, count, { anomaly: false, expected: true }), "warn");
  assert.equal(monitorStatus("request_latency_p95_ms", slower, latency, { anomaly: false, expected: true }), "warn");
});

test("signBody is sha256 of the raw body", () => {
  const body = JSON.stringify({ incidentId: "inc_1" });
  const expected = `sha256=${createHmac("sha256", "topsecret").update(body).digest("hex")}`;
  assert.equal(signBody("topsecret", body), expected);
});
