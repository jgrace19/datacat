import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type Config = {
  port: number;
  host: string;
  botAlias: string;
  agentAliasToken: string;
  webhookSecret: string;
  hmacHeader: string;
  metricsPushEnabled: boolean;
  metricsPushIntervalMs: number;
  generatorIntervalMs: number;
  historyHours: number;
};

export const DEFAULT_CONFIG: Config = {
  port: 8787,
  host: "127.0.0.1",
  botAlias: "",
  agentAliasToken: "",
  webhookSecret: "",
  hmacHeader: "X-Datacat-Signature",
  metricsPushEnabled: false,
  metricsPushIntervalMs: 15_000,
  generatorIntervalMs: 5_000,
  historyHours: 24,
};

export function loadEnvFile(file = path.join(process.cwd(), ".env")): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max?: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || (max !== undefined && n > max)) {
    const ceiling = max === undefined ? "" : ` and <= ${max}`;
    throw new Error(`${key} must be a number >= ${min}${ceiling}`);
  }
  return Math.floor(n);
}

function boolEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`${key} must be true or false`);
}

export function normalizeBotAlias(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("BOT_ALIAS must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("BOT_ALIAS must be http or https");
  }
  return url.toString().replace(/\/+$/, "");
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const header = (env.DATACAT_HMAC_HEADER ?? DEFAULT_CONFIG.hmacHeader).trim() || DEFAULT_CONFIG.hmacHeader;
  if (!/^[A-Za-z0-9-]+$/.test(header)) {
    throw new Error("DATACAT_HMAC_HEADER must be a token of letters, digits, and hyphens");
  }
  return {
    port: intEnv(env, "PORT", DEFAULT_CONFIG.port, 0, 65535),
    host: (env.HOST ?? DEFAULT_CONFIG.host).trim() || DEFAULT_CONFIG.host,
    botAlias: normalizeBotAlias(env.BOT_ALIAS ?? ""),
    agentAliasToken: env.AGENT_ALIAS_TOKEN ?? "",
    webhookSecret: env.DATACAT_WEBHOOK_SECRET ?? "",
    hmacHeader: header,
    metricsPushEnabled: boolEnv(env, "METRICS_PUSH_ENABLED", DEFAULT_CONFIG.metricsPushEnabled),
    metricsPushIntervalMs: intEnv(env, "METRICS_PUSH_INTERVAL_MS", DEFAULT_CONFIG.metricsPushIntervalMs, 2000),
    generatorIntervalMs: intEnv(env, "GENERATOR_INTERVAL_MS", DEFAULT_CONFIG.generatorIntervalMs, 200),
    historyHours: intEnv(env, "HISTORY_HOURS", DEFAULT_CONFIG.historyHours, 0, 48),
  };
}
