import assert from "node:assert/strict";
import test from "node:test";
import { startMockBot, startTestServer } from "./helpers.ts";

test("query, ingest, anomaly, and resolve round-trip", async () => {
  const started = await startTestServer();
  try {
    const health = await fetch(`${started.url}/api/health`);
    assert.equal(health.status, 200);

    const rejected = await fetch(`${started.url}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: "prod", points: [{ metric: "category_spend", v: 1 }] }),
    });
    assert.equal(rejected.status, 400);

    const ingested = await fetch(`${started.url}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        env: "preview-42",
        source: "preview-runner",
        points: [
          { metric: "request_latency_p95_ms", t: 1_700_000_000_000, v: 120 },
          { metric: "error_rate", t: 1_700_000_000_000, v: 0.01 },
        ],
      }),
    });
    assert.equal(ingested.status, 200);
    const ingestBody = (await ingested.json()) as { accepted: number };
    assert.equal(ingestBody.accepted, 2);

    const queried = await fetch(
      `${started.url}/api/query?metric=request_latency_p95_ms&env=preview-42&from=0&to=2000000000000`,
    );
    assert.equal(queried.status, 200);
    const series = (await queried.json()) as { points: Array<{ v: number }> };
    assert.equal(series.points.at(-1)?.v, 120);

    const badWindow = await fetch(`${started.url}/api/query?metric=category_spend&env=prod&from=10&to=1`);
    assert.equal(badWindow.status, 400);

    const anomaly = await fetch(`${started.url}/api/anomaly`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: "prod" }),
    });
    assert.equal(anomaly.status, 200);
    const first = (await anomaly.json()) as { created: boolean; incident: { id: string; delivery: { status: string } } };
    assert.equal(first.created, true);
    assert.equal(first.incident.delivery.status, "skipped");

    const duplicate = await fetch(`${started.url}/api/anomaly`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: "prod" }),
    });
    const second = (await duplicate.json()) as { created: boolean; incident: { id: string } };
    assert.equal(second.created, false);
    assert.equal(second.incident.id, first.incident.id);

    const spike = await fetch(`${started.url}/api/expected-spike`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: "prod" }),
    });
    assert.equal(spike.status, 200);

    const resolved = await fetch(`${started.url}/api/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: "prod" }),
    });
    const resolvedBody = (await resolved.json()) as { resolved: Array<{ status: string }> };
    assert.equal(resolvedBody.resolved.length, 1);
    assert.equal(resolvedBody.resolved[0]?.status, "resolved");

    const dashboard = await fetch(`${started.url}/api/dashboard?env=prod&range=1h`);
    const view = (await dashboard.json()) as { metrics: unknown[]; envs: string[]; mode: { anomaly: boolean } };
    assert.equal(view.metrics.length, 5);
    assert.ok(view.envs.includes("preview-42"));
    assert.equal(view.mode.anomaly, false);
  } finally {
    await started.close();
  }
});

test("the console is served without another vendor's name", async () => {
  const started = await startTestServer();
  try {
    const pages = ["/", "/styles.css", "/app.js", "/favicon.svg"];
    for (const page of pages) {
      const response = await fetch(`${started.url}${page}`);
      assert.equal(response.status, 200, page);
      const text = await response.text();
      assert.equal(/datadog/i.test(text), false, page);
    }
    const script = await (await fetch(`${started.url}/app.js`)).text();
    assert.match(script, /Trigger anomaly/);
    assert.match(script, /Trigger expected spike/);
    assert.match(script, /Resolve/);
    const html = await (await fetch(`${started.url}/`)).text();
    assert.match(html, /datacat/);
    const css = await (await fetch(`${started.url}/styles.css`)).text();
    assert.match(css, /\.status\.alert/);
    assert.match(css, /#15171e/);
  } finally {
    await started.close();
  }
});

test("anomaly delivery status is returned on the HTTP response", async () => {
  const bot = await startMockBot();
  const started = await startTestServer({
    config: { botAlias: bot.url, agentAliasToken: "token-1", webhookSecret: "" },
  });
  try {
    const response = await fetch(`${started.url}/api/anomaly`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: "prod", metric: "category_spend" }),
    });
    const body = (await response.json()) as { incident: { delivery: { status: string; statusCode?: number } } };
    assert.equal(body.incident.delivery.status, "delivered");
    assert.equal(body.incident.delivery.statusCode, 202);
    assert.equal(bot.requests[0]?.headers["x-agent-alias-token"], "token-1");
    assert.equal(bot.requests[0]?.headers["x-datacat-signature"], undefined);
  } finally {
    await started.close();
    await bot.close();
  }
});
