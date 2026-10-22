import assert from "node:assert/strict";
import test from "node:test";
import { DatacatApp } from "../src/app.ts";
import { signBody } from "../src/sign.ts";
import { startMockBot } from "./helpers.ts";

function appWith(bot?: { url: string; token?: string; secret?: string; observability?: string }) {
  return new DatacatApp({
    config: {
      historyHours: 0,
      generatorIntervalMs: 60_000,
      botAlias: bot?.url ?? "",
      agentAliasToken: bot?.token ?? "",
      observabilitySharedSecret: bot?.observability ?? "",
      webhookSecret: bot?.secret ?? "",
      hmacHeader: "X-Datacat-Signature",
      metricsPushEnabled: false,
    },
  });
}

test("anomaly drops spend, pages once, and resolve restores baseline", async () => {
  const bot = await startMockBot();
  const app = appWith({ url: bot.url, token: "alias-token", secret: "topsecret" });
  try {
    const first = app.triggerAnomaly("prod");
    assert.equal(first.created, true);
    assert.ok(first.incident.value < first.incident.baseline * 0.6);
    assert.equal(first.incident.window, "5m");
    assert.equal(first.incident.metric, "category_spend");
    assert.match(first.incident.summary, /spentByCategory/);
    const errors = app.store.latest("prod", "budget_calc_errors");
    assert.ok(errors && errors.v >= 20);

    await app.flushAlerts();
    assert.equal(bot.requests.length, 1);
    const posted = bot.requests[0];
    assert.ok(posted);
    assert.equal(posted.url, "/v1/channels/observability/alert");
    assert.equal(posted.headers["x-agent-alias-token"], "alias-token");
    assert.equal(posted.headers["x-bdk-session-key"], `incident:${first.incident.id}`);
    assert.equal(posted.headers["x-datacat-signature"], signBody("topsecret", posted.body));
    const payload = JSON.parse(posted.body) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload), ["incidentId", "metric", "env", "baseline", "value", "window"]);
    assert.equal(payload.incidentId, first.incident.id);
    assert.equal(payload.env, "prod");
    assert.equal(first.incident.delivery.status, "delivered");

    const again = app.triggerAnomaly("prod");
    assert.equal(again.created, false);
    assert.equal(again.incident.id, first.incident.id);
    await app.flushAlerts();
    assert.equal(bot.requests.length, 1);

    const resolved = app.resolve({ env: "prod" });
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.status, "resolved");
    const restored = app.store.latest("prod", "category_spend");
    assert.ok(restored && restored.v > first.incident.baseline * 0.8);
    assert.equal(app.resolve({ env: "prod" }).length, 0);
  } finally {
    await bot.close();
  }
});

test("a failed alert retries with the same incident id and then stops", async () => {
  const bot = await startMockBot();
  bot.setStatus(500);
  const app = appWith({ url: bot.url });
  try {
    const { incident } = app.triggerAnomaly("prod");
    await app.flushAlerts();
    assert.equal(incident.delivery.status, "failed");
    bot.setStatus(202);
    await app.flushAlerts();
    assert.equal(incident.delivery.status, "delivered");
    assert.equal(bot.requests.length, 2);
    const first = JSON.parse(bot.requests[0]?.body ?? "{}") as { incidentId: string };
    const second = JSON.parse(bot.requests[1]?.body ?? "{}") as { incidentId: string };
    assert.equal(first.incidentId, second.incidentId);
    await app.flushAlerts();
    assert.equal(bot.requests.length, 2);
  } finally {
    await bot.close();
  }
});

test("expected spike annotates traffic and does not page", async () => {
  const bot = await startMockBot();
  const app = appWith({ url: bot.url });
  try {
    app.backfill("prod", 1);
    const result = app.triggerExpectedSpike("prod", "feature flag launch");
    assert.equal(result.label, "feature flag launch");
    const after = app.store.latest("prod", "request_count");
    assert.ok(after && after.v > 100);
    assert.equal(app.listIncidents().length, 0);
    await app.flushAlerts();
    assert.equal(bot.requests.length, 0);
    const events = app.listEvents();
    assert.ok(events.some((event) => event.kind === "expected_spike"));
  } finally {
    await bot.close();
  }
});

test("ingest is rejected for prod and transformed while a preview anomaly is open", () => {
  const app = appWith();
  assert.throws(() => app.ingest({ env: "prod", points: [{ metric: "category_spend", v: 10 }] }), /preview-<pr>/);
  const opened = app.triggerAnomaly("preview-15");
  assert.equal(opened.incident.env, "preview-15");
  const stamp = Date.now() + 60_000;
  app.ingest({
    env: "preview-15",
    source: "preview-runner",
    points: [{ metric: "category_spend", v: 100_000, t: stamp }],
  });
  const latest = app.store.latest("preview-15", "category_spend");
  assert.ok(latest);
  assert.equal(latest.t, stamp);
  assert.ok(Math.abs(latest.v - 42_000) < 1);
});

test("alert and metrics send the observability token and leave HMAC off by default", async () => {
  const bot = await startMockBot();
  const app = appWith({ url: bot.url, token: "alias-token", observability: "shared-secret" });
  try {
    const { incident } = app.triggerAnomaly("prod");
    await app.flushAlerts();
    const alert = bot.requests[0];
    assert.ok(alert);
    assert.equal(alert.url, "/v1/channels/observability/alert");
    assert.equal(alert.headers["x-observability-token"], "shared-secret");
    assert.equal(alert.headers["x-agent-alias-token"], "alias-token");
    assert.equal(alert.headers["x-bdk-session-key"], `incident:${incident.id}`);
    assert.equal(alert.headers["x-datacat-signature"], undefined);

    app.backfill("preview-7", 1);
    await app.pushMetricsOnce({ force: true });
    const metrics = bot.requests[1];
    assert.ok(metrics);
    assert.equal(metrics.url, "/v1/channels/observability/metrics");
    assert.equal(metrics.headers["x-observability-token"], "shared-secret");
    assert.equal(metrics.headers["x-agent-alias-token"], "alias-token");
    assert.equal(metrics.headers["x-bdk-session-key"], "metrics:snapshot");
    assert.equal(metrics.headers["x-datacat-signature"], undefined);
  } finally {
    await bot.close();
  }
});

test("skipped delivery is retried after a bot alias is saved", async () => {
  const bot = await startMockBot();
  const app = appWith();
  try {
    const { incident } = app.triggerAnomaly("prod");
    await app.flushAlerts();
    assert.equal(incident.delivery.status, "skipped");
    app.updateSettings({ botAlias: bot.url });
    await app.flushAlerts();
    assert.equal(incident.delivery.status, "delivered");
    assert.equal(bot.requests.length, 1);
  } finally {
    await bot.close();
  }
});
