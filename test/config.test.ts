import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { configFromEnv, loadEnvFile, normalizeBotAlias, shipConfigFromEnv } from "../src/config.ts";

test("config reads defaults and overrides", () => {
  const config = configFromEnv({
    PORT: "9000",
    BOT_ALIAS: "http://bot.example/base/",
    METRICS_PUSH_ENABLED: "yes",
    OBSERVABILITY_SHARED_SECRET: "shared",
    DATACAT_WEBHOOK_SECRET: "s3cret",
  });
  assert.equal(config.port, 9000);
  assert.equal(config.botAlias, "http://bot.example/base");
  assert.equal(config.metricsPushEnabled, true);
  assert.equal(config.observabilitySharedSecret, "shared");
  assert.equal(config.webhookSecret, "s3cret");
  assert.equal(config.hmacHeader, "X-Datacat-Signature");
});

test("HMAC and the observability token are empty unless set", () => {
  const config = configFromEnv({});
  assert.equal(config.observabilitySharedSecret, "");
  assert.equal(config.webhookSecret, "");
});

test("config rejects a bad boolean and an oversized history", () => {
  assert.throws(() => configFromEnv({ METRICS_PUSH_ENABLED: "maybe" }), /true or false/);
  assert.throws(() => configFromEnv({ HISTORY_HOURS: "90" }), /HISTORY_HOURS/);
});

test("normalizeBotAlias requires http(s)", () => {
  assert.equal(normalizeBotAlias(""), "");
  assert.equal(normalizeBotAlias("https://alias.example/"), "https://alias.example");
  assert.throws(() => normalizeBotAlias("bot.example"), /absolute/);
  assert.throws(() => normalizeBotAlias("ftp://alias.example"), /http/);
});

test("ship watcher config defaults and refuses port 8000", () => {
  const config = shipConfigFromEnv({});
  assert.equal(config.enabled, true);
  assert.equal(config.intervalMs, 5000);
  assert.equal(config.repo, "jgrace19/marketplace");
  assert.equal(config.base, "demo/base");
  assert.equal(config.label, "ship");
  assert.equal(config.labelFallback, false);
  assert.equal(config.backendPort, 8010);
  assert.equal(config.recoveryMs, 25_000);
  assert.equal(config.marketplaceDir, path.join(homedir(), "cursor-dev", "marketplace"));
  const custom = shipConfigFromEnv({
    SHIP_WATCH_ENABLED: "false",
    MARKETPLACE_DIR: "~/checkouts/marketplace",
    MARKETPLACE_BACKEND_PORT: "8011",
    SHIP_LABEL: "ship",
    SHIP_LABEL_FALLBACK: "yes",
  });
  assert.equal(custom.enabled, false);
  assert.equal(custom.labelFallback, true);
  assert.equal(custom.backendPort, 8011);
  assert.equal(custom.marketplaceDir, path.join(homedir(), "checkouts", "marketplace"));
  assert.throws(() => shipConfigFromEnv({ MARKETPLACE_BACKEND_PORT: "8000" }), /8000/);
});

test("loadEnvFile fills missing keys and does not override", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "datacat-env-"));
  const file = path.join(dir, ".env");
  await writeFile(file, "BOT_ALIAS=http://from-file.example\n# comment\nAGENT_ALIAS_TOKEN=\"abc\"\n");
  const previousAlias = process.env.BOT_ALIAS;
  const previousToken = process.env.AGENT_ALIAS_TOKEN;
  process.env.BOT_ALIAS = "http://already.example";
  delete process.env.AGENT_ALIAS_TOKEN;
  try {
    loadEnvFile(file);
    assert.equal(process.env.BOT_ALIAS, "http://already.example");
    assert.equal(process.env.AGENT_ALIAS_TOKEN, "abc");
  } finally {
    if (previousAlias === undefined) delete process.env.BOT_ALIAS;
    else process.env.BOT_ALIAS = previousAlias;
    if (previousToken === undefined) delete process.env.AGENT_ALIAS_TOKEN;
    else process.env.AGENT_ALIAS_TOKEN = previousToken;
  }
});
