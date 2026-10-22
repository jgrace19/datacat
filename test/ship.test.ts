import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AOV_CENTS, GMV_CENTS, ORDERS } from "../src/metrics.ts";
import { DatacatApp, withinBaseline } from "../src/app.ts";
import type { ShipConfig } from "../src/config.ts";
import { parseShipPulls, shipListArgs, ShipWatcher, type ShipPull } from "../src/ship.ts";
import { signBody } from "../src/sign.ts";
import { startMockBot, startTestServer } from "./helpers.ts";

const pull: ShipPull = {
  number: 41,
  title: "Checkout totals",
  url: "https://github.com/jgrace19/marketplace/pull/41",
  headRefName: "checkout-totals",
  sha: "abcdef1234567890",
};

function shipConfig(overrides: Partial<ShipConfig> = {}): ShipConfig {
  return {
    enabled: true,
    intervalMs: 5_000,
    repo: "jgrace19/marketplace",
    base: "demo/base",
    label: "ship",
    marketplaceDir: "/tmp/marketplace",
    backendPort: 8010,
    recoveryMs: 25_000,
    labelFallback: false,
    ...overrides,
  };
}

test("gh list args and parser keep open labeled pulls", () => {
  assert.deepEqual(shipListArgs(shipConfig()), [
    "pr",
    "list",
    "--repo",
    "jgrace19/marketplace",
    "--base",
    "demo/base",
    "--label",
    "ship",
    "--state",
    "open",
    "--limit",
    "50",
    "--json",
    "number,title,url,headRefName,headRefOid",
  ]);
  const parsed = parseShipPulls(
    JSON.stringify([
      { number: 41, title: "Checkout totals", url: "https://example/41", headRefName: "checkout-totals", headRefOid: pull.sha },
      { number: 0, title: "skip", headRefOid: pull.sha },
      { number: 8, title: "bad", headRefOid: "nope" },
    ]),
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.number, 41);
  assert.equal(parsed[0]?.sha, pull.sha);
  assert.throws(() => parseShipPulls("{"), /JSON/);
});

test("a ship pull deploys once until its head changes, and failures retry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "datacat-ship-"));
  const file = path.join(dir, "handled.json");
  const deployed: number[] = [];
  let fail = true;
  const watcher = new ShipWatcher({
    config: shipConfig({ labelFallback: true }),
    stateFile: file,
    listPulls: async () => [pull],
    deploy: async (item) => {
      deployed.push(item.pr);
      if (fail) throw new Error("health timeout");
      return { sha: item.sha };
    },
  });
  await watcher.poll();
  await watcher.poll();
  assert.deepEqual(deployed, [41, 41]);
  assert.equal(watcher.status().deploys[0]?.status, "failed");
  assert.equal(watcher.status().handled.length, 0);

  fail = false;
  await watcher.poll();
  await watcher.poll();
  assert.deepEqual(deployed, [41, 41, 41]);
  assert.deepEqual(watcher.status().handled, [`41:${pull.sha}`]);
  assert.equal(watcher.status().deploys[0]?.status, "healthy");
  assert.equal(watcher.status().backendPort, 8010);

  const again = new ShipWatcher({
    config: shipConfig({ labelFallback: true }),
    stateFile: file,
    listPulls: async () => [pull],
    deploy: async () => {
      throw new Error("should already be handled");
    },
  });
  await again.poll();
  assert.deepEqual(again.status().handled, [`41:${pull.sha}`]);

  const moved = { ...pull, sha: "bbbbbbb123456789" };
  let movedDeploys = 0;
  const third = new ShipWatcher({
    config: shipConfig({ labelFallback: true }),
    stateFile: file,
    listPulls: async () => [moved],
    deploy: async () => {
      movedDeploys += 1;
      return { sha: moved.sha };
    },
  });
  await third.poll();
  assert.equal(movedDeploys, 1);
});

test("a disabled watcher does not poll and a bad port is refused", async () => {
  let calls = 0;
  const watcher = new ShipWatcher({
    config: shipConfig({ enabled: false }),
    stateFile: false,
    listPulls: async () => {
      calls += 1;
      return [];
    },
  });
  watcher.start();
  await watcher.poll();
  watcher.stop();
  assert.equal(calls, 0);
  assert.throws(() => new ShipWatcher({ config: shipConfig({ backendPort: 8000 }), stateFile: false }), /8000/);
});

test("deploy recovery climbs for about 25s and then posts the recovered envelope", async () => {
  const bot = await startMockBot();
  let now = Date.UTC(2026, 0, 2, 15, 0, 0);
  const app = new DatacatApp({
    now: () => now,
    config: {
      historyHours: 0,
      generatorIntervalMs: 5_000,
      botAlias: bot.url,
      agentAliasToken: "alias-token",
      observabilitySharedSecret: "shared-secret",
      webhookSecret: "topsecret",
      hmacHeader: "X-Datacat-Signature",
      metricsPushEnabled: false,
    },
  });
  try {
    const opened = app.triggerAnomaly("prod");
    await app.flushAlerts();
    const dropped = app.store.latest("prod", AOV_CENTS);
    assert.ok(dropped && dropped.v < 2800);
    now += 1_000;
    const recovery = app.beginRecovery({ env: "prod", pr: 41, durationMs: 25_000 });
    assert.equal(app.store.latest("prod", AOV_CENTS)?.v, dropped.v);
    assert.equal(opened.incident.status, "resolved");
    const during = app.dashboard("prod", "1h");
    assert.equal(during.mode.anomaly, false);
    assert.equal(during.mode.recovery?.pr, 41);
    assert.ok(during.annotations.some((mark) => mark.kind === "deploy" && mark.label === "Deploy: PR #41"));

    const midAt = recovery.from + 12_500;
    app.tick(midAt);
    const mid = app.store.latest("prod", AOV_CENTS);
    assert.ok(mid && mid.v > dropped.v + 200);
    assert.ok(mid.v < 3300);
    assert.equal(app.store.latest("prod", ORDERS)?.v, 4);
    await app.whenIdle();
    assert.equal(bot.requests.filter((request) => JSON.parse(request.body).status === "recovered").length, 0);
    assert.equal(app.dashboard("prod", "1h").mode.recovery?.pr, 41);

    const earlyAt = recovery.from + 20_000;
    app.tick(earlyAt);
    await app.whenIdle();
    const posted = bot.requests.find((request) => JSON.parse(request.body).status === "recovered");
    assert.ok(posted);
    assert.ok(earlyAt < recovery.until);
    assert.equal(app.dashboard("prod", "1h").mode.recovery?.pr, 41);

    app.tick(recovery.until);
    const restored = app.store.latest("prod", AOV_CENTS);
    const restoredGmv = app.store.latest("prod", GMV_CENTS);
    assert.ok(restored && restored.v > 3200);
    assert.ok(restoredGmv && restoredGmv.v > 12_000);
    assert.equal(app.store.latest("prod", ORDERS)?.v, 4);
    const prior = app.store.query("prod", AOV_CENTS, recovery.from - 60_000, recovery.from);
    assert.ok(prior.some((point) => point.v < 2800));
    await app.whenIdle();
    assert.equal(bot.requests.filter((request) => JSON.parse(request.body).status === "recovered").length, 1);

    assert.equal(posted.url, "/v1/channels/observability/alert");
    assert.equal(posted.headers["x-agent-alias-token"], "alias-token");
    assert.equal(posted.headers["x-observability-token"], "shared-secret");
    assert.equal(posted.headers["x-bdk-session-key"], `incident:${opened.incident.id}`);
    assert.equal(posted.headers["x-datacat-signature"], signBody("topsecret", posted.body));
    const payload = JSON.parse(posted.body) as {
      incidentId: string;
      metric: string;
      env: string;
      baseline: number;
      value: number;
      window: string;
      status: string;
      gmv: { value: number; baseline: number; previous: number };
      aov: { value: number; baseline: number; previous: number };
    };
    assert.deepEqual(Object.keys(payload), [
      "incidentId",
      "metric",
      "env",
      "baseline",
      "value",
      "window",
      "status",
      "gmv",
      "aov",
    ]);
    assert.deepEqual(Object.keys(payload.gmv), ["value", "baseline", "previous"]);
    assert.deepEqual(Object.keys(payload.aov), ["value", "baseline", "previous"]);
    assert.equal(payload.status, "recovered");
    assert.equal(payload.env, "prod");
    assert.equal(payload.incidentId, opened.incident.id);
    assert.equal(payload.metric, AOV_CENTS);
    assert.equal(payload.window, "5m");
    assert.equal(payload.value, payload.aov.value);
    assert.equal(payload.baseline, payload.aov.baseline);
    assert.equal(typeof payload.gmv.value, "number");
    assert.equal(typeof payload.gmv.baseline, "number");
    assert.equal(typeof payload.gmv.previous, "number");
    assert.equal(typeof payload.aov.previous, "number");
    assert.ok(withinBaseline(payload.aov.value, payload.aov.baseline));
    assert.ok(withinBaseline(payload.gmv.value, payload.gmv.baseline));
    assert.ok(withinBaseline(payload.value, payload.baseline));
    assert.ok(payload.aov.previous < payload.aov.baseline * 0.9);
    assert.ok(payload.gmv.previous < payload.gmv.baseline * 0.9);
    assert.ok(Math.abs(payload.aov.previous - dropped.v) < 2);
    assert.equal("pr" in payload, false);
    const text = JSON.stringify(payload);
    assert.equal(/demo|root cause|bug/i.test(text), false);
    for (const event of app.listEvents()) {
      const line = `${event.kind} ${event.label ?? ""} ${event.message}`;
      assert.equal(/demo|root cause/i.test(line), false, line);
    }
    const after = app.dashboard("prod", "1h");
    assert.equal(after.mode.recovery, null);
    assert.ok(after.annotations.some((mark) => mark.label === "Deploy: PR #41"));
  } finally {
    await bot.close();
  }
});

test("resolve during a climb snaps back and does not send recovery", async () => {
  const bot = await startMockBot();
  const app = new DatacatApp({
    config: {
      historyHours: 0,
      generatorIntervalMs: 60_000,
      botAlias: bot.url,
      metricsPushEnabled: false,
    },
  });
  try {
    app.triggerAnomaly("prod");
    await app.flushAlerts();
    app.beginRecovery({ env: "prod", pr: 9, durationMs: 25_000 });
    const resolved = app.resolve({ env: "prod" });
    assert.equal(resolved.length, 0);
    await app.whenIdle();
    assert.equal(bot.requests.some((request) => JSON.parse(request.body).status === "recovered"), false);
    assert.ok((app.store.latest("prod", AOV_CENTS)?.v ?? 0) > 3200);
  } finally {
    await bot.close();
  }
});

test("deploys and manual recovery are on the HTTP API", async () => {
  const bot = await startMockBot();
  const started = await startTestServer({
    config: {
      botAlias: bot.url,
      agentAliasToken: "alias-token",
      observabilitySharedSecret: "shared-secret",
      webhookSecret: "",
    },
  });
  try {
    const idle = await fetch(`${started.url}/api/deploys`);
    assert.equal(idle.status, 200);
    const idleBody = (await idle.json()) as { enabled: boolean; backendPort: number };
    assert.equal(idleBody.enabled, false);
    assert.equal(idleBody.backendPort, 8010);

    const missing = await fetch(`${started.url}/api/push-recovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: "prod" }),
    });
    assert.equal(missing.status, 400);

    const wrongEnv = await fetch(`${started.url}/api/push-recovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: "preview-1" }),
    });
    assert.equal(wrongEnv.status, 400);

    const anomaly = await fetch(`${started.url}/api/anomaly`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: "prod" }),
    });
    assert.equal(anomaly.status, 200);
    const anomalyBody = (await anomaly.json()) as { incident: { id: string } };

    const tooSoon = await fetch(`${started.url}/api/push-recovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: "prod" }),
    });
    assert.equal(tooSoon.status, 409);

    const watcher = new ShipWatcher({
      config: shipConfig({ recoveryMs: 1_000, labelFallback: true }),
      stateFile: false,
      listPulls: async () => [pull],
      deploy: async () => ({ sha: pull.sha }),
      onDeployed: ({ pr, incidentId }) => {
        started.app.beginRecovery({ env: "prod", pr, incidentId, durationMs: 1_000 });
      },
    });
    started.app.setRecoveryListener((notice) => watcher.noteRecovery(notice));
    started.app.setDeployStatus(() => watcher.status());
    await watcher.poll();
    const deploying = (await (await fetch(`${started.url}/api/deploys`)).json()) as {
      deploys: Array<{ pr: number; status: string; backendPort: number; recovery?: { status: string } }>;
      handled: string[];
    };
    assert.equal(deploying.deploys[0]?.pr, 41);
    assert.equal(deploying.deploys[0]?.status, "healthy");
    assert.equal(deploying.deploys[0]?.backendPort, 8010);
    assert.equal(deploying.deploys[0]?.recovery?.status, "pending");
    assert.deepEqual(deploying.handled, [`41:${pull.sha}`]);

    const view = (await (await fetch(`${started.url}/api/dashboard?env=prod&range=1h`)).json()) as {
      mode: { recovery: { pr: number } | null };
      annotations: Array<{ label: string }>;
    };
    assert.equal(view.mode.recovery?.pr, 41);
    assert.ok(view.annotations.some((mark) => mark.label === "Deploy: PR #41"));

    started.app.tick(Date.now() + 5_000);
    await started.app.whenIdle();
    const done = (await (await fetch(`${started.url}/api/deploys`)).json()) as {
      deploys: Array<{ recovery?: { status: string; statusCode?: number } }>;
    };
    assert.equal(done.deploys[0]?.recovery?.status, "delivered");
    assert.equal(done.deploys[0]?.recovery?.statusCode, 202);

    const manual = await fetch(`${started.url}/api/push-recovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: "prod", pr: 41 }),
    });
    assert.equal(manual.status, 200);
    const manualBody = (await manual.json()) as {
      payload: {
        status: string;
        env: string;
        incidentId: string;
        gmv: { value: number; baseline: number; previous: number };
        aov: { value: number; baseline: number; previous: number };
      };
    };
    assert.equal(manualBody.payload.status, "recovered");
    assert.equal(manualBody.payload.env, "prod");
    assert.equal(manualBody.payload.incidentId, anomalyBody.incident.id);
    assert.ok(withinBaseline(manualBody.payload.aov.value, manualBody.payload.aov.baseline));
    assert.ok(withinBaseline(manualBody.payload.gmv.value, manualBody.payload.gmv.baseline));
    assert.ok(manualBody.payload.aov.previous < manualBody.payload.aov.baseline * 0.9);
    const recovered = bot.requests.filter((request) => JSON.parse(request.body).status === "recovered");
    assert.equal(recovered.length, 2);
    assert.equal(recovered[0]?.headers["x-agent-alias-token"], "alias-token");
    assert.equal(recovered[0]?.headers["x-observability-token"], "shared-secret");
    assert.equal(recovered[0]?.headers["x-datacat-signature"], undefined);

    const script = await (await fetch(`${started.url}/app.js`)).text();
    const css = await (await fetch(`${started.url}/styles.css`)).text();
    assert.match(script, /Deploy: PR #/);
    assert.match(css, /\.banner\.deploy/);
    assert.equal(/root cause|\bdemo\b/i.test(script), false);
    assert.equal(/root cause|\bdemo\b/i.test(css), false);
  } finally {
    await started.close();
    await bot.close();
  }
});

test("label polling stays off unless the fallback is enabled", async () => {
  let calls = 0;
  const watcher = new ShipWatcher({
    config: shipConfig(),
    stateFile: false,
    listPulls: async () => {
      calls += 1;
      return [pull];
    },
  });
  watcher.start();
  await watcher.poll();
  watcher.stop();
  assert.equal(calls, 0);
  assert.equal(watcher.status().labelFallback, false);
});

test("ship hook is authorized, idempotent per incident, and cleared on resolve", async () => {
  const started = await startTestServer({
    config: { observabilitySharedSecret: "shared-secret", botAlias: "" },
  });
  try {
    const hook = {
      incidentId: "inc_bot_1",
      prNumber: 19,
      branch: "checkout-totals",
      headSha: "abc1234def",
    };
    let deploys = 0;
    const watcher = new ShipWatcher({
      config: shipConfig(),
      stateFile: false,
      deploy: async (target) => {
        deploys += 1;
        assert.equal(target.pr, 19);
        assert.equal(target.branch, "checkout-totals");
        assert.equal(target.source, "hook");
        if (deploys === 1) assert.equal(target.sha, "abc1234def");
        return { sha: target.sha || "abc1234def" };
      },
      onDeployed: ({ pr, incidentId }) => {
        started.app.beginRecovery({ env: "prod", pr, incidentId, durationMs: 25_000 });
      },
    });
    started.app.setShipAccept((body) => watcher.accept(body));
    started.app.setAfterResolve(() => watcher.clearHandled());
    started.app.setDeployStatus(() => watcher.status());

    const denied = await fetch(`${started.url}/api/ship-hook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-observability-token": "nope" },
      body: JSON.stringify(hook),
    });
    assert.equal(denied.status, 401);
    assert.equal(deploys, 0);

    const accepted = await fetch(`${started.url}/api/ship-hook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-observability-token": "shared-secret" },
      body: JSON.stringify(hook),
    });
    assert.equal(accepted.status, 200);
    const first = (await accepted.json()) as { duplicate: boolean; deploy: { incidentId?: string; status: string } };
    assert.equal(first.duplicate, false);
    assert.equal(first.deploy.status, "healthy");
    assert.equal(first.deploy.incidentId, "inc_bot_1");
    assert.equal(deploys, 1);
    assert.deepEqual(watcher.status().handled, ["incident:inc_bot_1"]);

    const again = await fetch(`${started.url}/api/ship-hook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-observability-token": "shared-secret" },
      body: JSON.stringify(hook),
    });
    const second = (await again.json()) as { duplicate: boolean };
    assert.equal(second.duplicate, true);
    assert.equal(deploys, 1);

    const resolved = await fetch(`${started.url}/api/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: "prod" }),
    });
    assert.equal(resolved.status, 200);
    assert.deepEqual(watcher.status().handled, []);

    const retried = await fetch(`${started.url}/api/ship-hook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-observability-token": "shared-secret" },
      body: JSON.stringify({ ...hook, headSha: "" }),
    });
    assert.equal(retried.status, 200);
    assert.equal(deploys, 2);
  } finally {
    await started.close();
  }
});

test("recovery uses the ship hook incident id", async () => {
  const bot = await startMockBot();
  let now = Date.UTC(2026, 0, 3, 12, 0, 0);
  const app = new DatacatApp({
    now: () => now,
    config: {
      historyHours: 0,
      generatorIntervalMs: 5_000,
      botAlias: bot.url,
      observabilitySharedSecret: "shared-secret",
      metricsPushEnabled: false,
    },
  });
  try {
    const opened = app.triggerAnomaly("prod");
    await app.flushAlerts();
    now += 1_000;
    const recovery = app.beginRecovery({
      env: "prod",
      pr: 19,
      incidentId: "inc_from_bot",
      durationMs: 25_000,
    });
    app.tick(recovery.from + 20_000);
    await app.whenIdle();
    const posted = bot.requests.find((request) => JSON.parse(request.body).status === "recovered");
    assert.ok(posted);
    const payload = JSON.parse(posted.body) as { incidentId: string; env: string };
    assert.equal(payload.incidentId, "inc_from_bot");
    assert.notEqual(payload.incidentId, opened.incident.id);
    assert.equal(payload.env, "prod");
    assert.equal(posted.headers["x-observability-token"], "shared-secret");
    assert.equal(posted.headers["x-bdk-session-key"], "incident:inc_from_bot");
  } finally {
    await bot.close();
  }
});

test("reset bot posts to the reset route and treats 202 as success", async () => {
  const bot = await startMockBot();
  bot.setStatus(202);
  const app = new DatacatApp({
    config: {
      botAlias: bot.url,
      agentAliasToken: "alias-token",
      observabilitySharedSecret: "shared-secret",
      webhookSecret: "topsecret",
      hmacHeader: "X-Datacat-Signature",
      metricsPushEnabled: false,
    },
  });
  try {
    const result = await app.resetBot();
    assert.equal(result.ok, true);
    assert.equal(result.status, 202);
    const posted = bot.requests[0];
    assert.ok(posted);
    assert.equal(posted.method, "POST");
    assert.equal(posted.url, "/v1/channels/observability/reset");
    assert.equal(posted.body, "{}");
    assert.equal(posted.headers["x-agent-alias-token"], "alias-token");
    assert.equal(posted.headers["x-observability-token"], "shared-secret");
    assert.equal(posted.headers["x-datacat-signature"], signBody("topsecret", "{}"));
    assert.equal(posted.headers["x-bdk-session-key"], undefined);
  } finally {
    await bot.close();
  }
});
