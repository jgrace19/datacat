import { createReadStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatacatApp, HttpError, isRangeKey, type RangeKey } from "./app.ts";
import { configFromEnv, loadEnvFile } from "./config.ts";
import { EnvNameError } from "./metrics.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const publicDir = path.resolve(here, "../public");

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const ok = (value: unknown) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        fail(new HttpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return ok({});
      try {
        ok(JSON.parse(raw) as unknown);
      } catch {
        fail(new HttpError(400, "invalid JSON"));
      }
    });
    req.on("error", (error) => fail(error));
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "JSON body must be an object");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseTime(value: string | null, now: number): number {
  if (!value) return now;
  if (/^-?\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new HttpError(400, `invalid time ${JSON.stringify(value)}`);
  return parsed;
}

function serveStatic(res: http.ServerResponse, pathname: string): void {
  const entry = STATIC[pathname];
  if (!entry) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const filePath = path.join(publicDir, entry.file);
  res.writeHead(200, {
    "content-type": entry.type,
    "cache-control": "no-store",
  });
  createReadStream(filePath)
    .on("error", () => {
      if (!res.headersSent) sendJson(res, 404, { error: "not found" });
      else res.end();
    })
    .pipe(res);
}

export function createServer(app: DatacatApp): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;
      const method = req.method ?? "GET";

      if (method === "GET" && pathname === "/api/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && pathname === "/api/query") {
        const now = Date.now();
        const metric = url.searchParams.get("metric") ?? "";
        const env = url.searchParams.get("env") ?? "prod";
        const to = parseTime(url.searchParams.get("to"), now);
        const from = parseTime(url.searchParams.get("from"), to - 60 * 60 * 1000);
        const maxRaw = url.searchParams.get("max");
        const max = maxRaw ? Number(maxRaw) : 2000;
        if (!Number.isFinite(max) || max < 2) throw new HttpError(400, "max must be a number >= 2");
        sendJson(res, 200, app.query(metric, env, from, to, max));
        return;
      }

      if (method === "GET" && pathname === "/api/dashboard") {
        const env = url.searchParams.get("env") ?? "prod";
        const range = url.searchParams.get("range") ?? "1h";
        if (!isRangeKey(range)) throw new HttpError(400, "range must be 15m, 1h, 4h, or 1d");
        sendJson(res, 200, app.dashboard(env, range));
        return;
      }

      if (method === "GET" && pathname === "/api/incidents") {
        sendJson(res, 200, { incidents: app.listIncidents() });
        return;
      }

      if (method === "GET" && pathname === "/api/events") {
        sendJson(res, 200, { events: app.listEvents() });
        return;
      }

      if (method === "POST" && pathname === "/api/ingest") {
        const body = asRecord(await readJson(req));
        sendJson(res, 200, app.ingest(body as Parameters<DatacatApp["ingest"]>[0]));
        return;
      }

      if (method === "POST" && pathname === "/api/anomaly") {
        const body = asRecord(await readJson(req));
        const result = app.triggerAnomaly(asString(body.env, "prod"), asString(body.metric, "category_spend"));
        await app.flushAlerts();
        sendJson(res, 200, result);
        return;
      }

      if (method === "POST" && pathname === "/api/expected-spike") {
        const body = asRecord(await readJson(req));
        sendJson(
          res,
          200,
          app.triggerExpectedSpike(asString(body.env, "prod"), asString(body.label, "feature flag launch")),
        );
        return;
      }

      if (method === "POST" && pathname === "/api/resolve") {
        const body = asRecord(await readJson(req));
        const env = body.env === undefined ? undefined : asString(body.env);
        const incidentId = body.incidentId === undefined ? undefined : asString(body.incidentId);
        const resolved = app.resolve({ env: env || undefined, incidentId: incidentId || undefined });
        sendJson(res, 200, { resolved });
        return;
      }

      if (method === "POST" && pathname === "/api/settings") {
        const body = asRecord(await readJson(req));
        const patch: { botAlias?: string; pushEnabled?: boolean; pushIntervalMs?: number } = {};
        if (body.botAlias !== undefined) patch.botAlias = asString(body.botAlias);
        if (body.pushEnabled !== undefined) {
          if (typeof body.pushEnabled !== "boolean") throw new HttpError(400, "pushEnabled must be a boolean");
          patch.pushEnabled = body.pushEnabled;
        }
        if (body.pushIntervalMs !== undefined) {
          const interval = asNumber(body.pushIntervalMs);
          if (interval === undefined) throw new HttpError(400, "pushIntervalMs must be a number");
          patch.pushIntervalMs = interval;
        }
        sendJson(res, 200, app.updateSettings(patch));
        return;
      }

      if (method === "POST" && pathname === "/api/push-now") {
        const result = await app.pushMetricsOnce({ force: true });
        sendJson(res, 200, result);
        return;
      }

      const redeliver = pathname.match(/^\/api\/incidents\/([^/]+)\/redeliver$/);
      if (method === "POST" && redeliver) {
        const id = decodeURIComponent(redeliver[1] ?? "");
        const incident = app.redeliver(id);
        await app.flushAlerts();
        sendJson(res, 200, { incident });
        return;
      }

      if (method === "GET" && !pathname.startsWith("/api/")) {
        serveStatic(res, pathname);
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      if (error instanceof EnvNameError) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      console.error("[datacat] request failed", error);
      sendJson(res, 500, { error: "internal error" });
    }
  });
}

export function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else resolve(port);
    });
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

export async function main(): Promise<void> {
  loadEnvFile();
  const config = configFromEnv();
  const app = new DatacatApp({ config });
  if (config.historyHours > 0) app.backfill("prod", config.historyHours);
  app.startLoops();
  const server = createServer(app);
  const port = await listen(server, config.port, config.host);
  const origin = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${port}`;
  console.log(`[datacat] listening on ${origin}`);
  console.log(`[datacat] bot alias ${config.botAlias || "(not set)"}`);
  console.log(`[datacat] snapshot push ${config.metricsPushEnabled ? "on" : "off"} every ${config.metricsPushIntervalMs}ms`);
  const shutdown = () => {
    app.stopLoops();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

export type { RangeKey };
