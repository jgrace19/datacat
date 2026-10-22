import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AOV_CENTS,
  ERROR_RATE,
  GMV_CENTS,
  LATENCY_P95_MS,
  ORDERS,
  UNITS,
  sampleHealthy,
  type MetricId,
} from "../src/metrics.ts";

const execFileAsync = promisify(execFile);

export type PreviewOptions = {
  pr: string;
  simulate: boolean;
  repo?: string;
  branch?: string;
  port: number;
  frontendPort: number;
  datacat: string;
  intervalMs: number;
  once: boolean;
};

type Measurement = {
  latencyMs: number;
  errorRate: number;
  checkout?: Partial<Record<MetricId, number>>;
};

const CHECKOUT_METRICS = [ORDERS, UNITS, GMV_CENTS, AOV_CENTS] as const;

function mulberry32(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseArgs(argv: string[]): PreviewOptions | "help" {
  const options: PreviewOptions = {
    pr: "",
    simulate: false,
    port: 8000,
    frontendPort: 5173,
    datacat: "http://127.0.0.1:8787",
    intervalMs: 5000,
    once: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const take = (name: string): string => {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
      i += 1;
      return next;
    };
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--simulate") {
      options.simulate = true;
      continue;
    }
    if (arg === "--once") {
      options.once = true;
      continue;
    }
    if (arg.startsWith("--pr=")) options.pr = arg.slice("--pr=".length);
    else if (arg === "--pr") options.pr = take("--pr");
    else if (arg.startsWith("--repo=")) options.repo = arg.slice("--repo=".length);
    else if (arg === "--repo") options.repo = take("--repo");
    else if (arg.startsWith("--branch=")) options.branch = arg.slice("--branch=".length);
    else if (arg === "--branch") options.branch = take("--branch");
    else if (arg.startsWith("--port=")) options.port = Number(arg.slice("--port=".length));
    else if (arg === "--port") options.port = Number(take("--port"));
    else if (arg.startsWith("--frontend-port=")) options.frontendPort = Number(arg.slice("--frontend-port=".length));
    else if (arg === "--frontend-port") options.frontendPort = Number(take("--frontend-port"));
    else if (arg.startsWith("--datacat=")) options.datacat = arg.slice("--datacat=".length);
    else if (arg === "--datacat") options.datacat = take("--datacat");
    else if (arg.startsWith("--interval=")) options.intervalMs = Number(arg.slice("--interval=".length));
    else if (arg === "--interval") options.intervalMs = Number(take("--interval"));
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!/^\d+$/.test(options.pr)) throw new Error("--pr is required and must be a pull request number");
  if (!options.simulate && !options.repo) throw new Error("pass --repo <marketplace> or --simulate");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("--port must be an integer from 0 to 65535");
  }
  if (!Number.isInteger(options.frontendPort) || options.frontendPort < 0 || options.frontendPort > 65535) {
    throw new Error("--frontend-port must be an integer from 0 to 65535");
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 200) {
    throw new Error("--interval must be a number >= 200");
  }
  let datacat: URL;
  try {
    datacat = new URL(options.datacat);
  } catch {
    throw new Error("--datacat must be an absolute http(s) URL");
  }
  if (datacat.protocol !== "http:" && datacat.protocol !== "https:") {
    throw new Error("--datacat must be http or https");
  }
  options.datacat = datacat.toString().replace(/\/+$/, "");
  return options;
}

export function previewEnv(pr: string): string {
  return `preview-${pr}`;
}

export function buildIngestBody(pr: string, now: number, measured?: Measurement) {
  const env = previewEnv(pr);
  const rand = mulberry32((now ^ Number(pr) ^ 0x9e3779b9) >>> 0);
  const healthy = sampleHealthy(now, rand);
  const checkout = measured?.checkout;
  const value = (metric: MetricId): number => {
    if (checkout && checkout[metric] !== undefined) return checkout[metric] as number;
    if (measured && metric === LATENCY_P95_MS) return measured.latencyMs;
    if (measured && metric === ERROR_RATE) return measured.errorRate;
    return healthy[metric];
  };
  return {
    env,
    source: "preview-runner",
    points: (Object.keys(healthy) as MetricId[]).map((metric) => ({ metric, v: value(metric), t: now })),
  };
}

export async function postIngest(datacat: string, body: ReturnType<typeof buildIngestBody>): Promise<void> {
  const response = await fetch(new URL("/api/ingest", datacat), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ingest failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code ?? "signal"}`));
    });
  });
}

async function ensureBranch(repo: string, branch: string): Promise<void> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", branch], { cwd: repo });
  } catch {
    throw new Error(`Branch ${branch} is not in ${repo}. Fetch it locally, then retry.`);
  }
  const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: repo });
  if (status.stdout.trim()) {
    throw new Error(`Refusing to checkout ${branch}: ${repo} has uncommitted changes.`);
  }
  await run("git", ["checkout", branch], repo);
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[index] ?? 0;
}

async function probe(url: string): Promise<{ ok: boolean; ms: number }> {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return { ok: response.status < 500, ms: Date.now() - started };
  } catch {
    return { ok: false, ms: Date.now() - started };
  }
}

async function measureLatency(api: string): Promise<{ latencyMs: number; errorRate: number }> {
  const paths = ["/api/metrics", "/api/metrics", "/api/products?store_id=greenmart&limit=1", "/api/stores"];
  const results = await Promise.all(paths.map((suffix) => probe(`${api}${suffix}`)));
  const failures = results.filter((result) => !result.ok).length;
  return {
    latencyMs: p95(results.map((result) => result.ms)),
    errorRate: failures / results.length,
  };
}

async function readCheckoutMetrics(api: string): Promise<Partial<Record<MetricId, number>>> {
  const response = await fetch(`${api}/api/metrics`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`GET /api/metrics failed (HTTP ${response.status})`);
  const body = (await response.json()) as { metrics?: Record<string, number> };
  const metrics = body.metrics ?? {};
  const checkout: Partial<Record<MetricId, number>> = {};
  for (const metric of CHECKOUT_METRICS) {
    const value = metrics[metric];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`GET /api/metrics is missing ${metric}`);
    }
    checkout[metric] = value;
  }
  return checkout;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.status < 500) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}: ${last}`);
}

function isMarketplace(repo: string): boolean {
  return (
    existsSync(path.join(repo, "backend", "main.py")) &&
    existsSync(path.join(repo, "scripts", "demo-checkout-metrics.py"))
  );
}

async function commandOk(command: string, args: string[], cwd: string): Promise<boolean> {
  try {
    await execFileAsync(command, args, { cwd });
    return true;
  } catch {
    return false;
  }
}

async function ensureBackend(repo: string): Promise<string> {
  const backend = path.join(repo, "backend");
  const python = path.join(backend, ".venv", "bin", "python");
  if (!existsSync(python)) {
    console.log("[preview-runner] creating backend/.venv");
    await run("python3", ["-m", "venv", ".venv"], backend);
  }
  const ready = await commandOk(python, ["-c", "import uvicorn, fastapi"], backend);
  if (!ready) {
    console.log("[preview-runner] installing backend requirements");
    await run(python, ["-m", "pip", "install", "-r", "requirements.txt"], backend);
  }
  return python;
}

async function ensureFrontend(repo: string): Promise<void> {
  const frontend = path.join(repo, "frontend");
  if (!existsSync(path.join(frontend, "package.json"))) {
    throw new Error(`No frontend/package.json in ${repo}. Re-run with --simulate.`);
  }
  if (!existsSync(path.join(frontend, "node_modules"))) {
    console.log("[preview-runner] installing frontend dependencies");
    await run("npm", ["install"], frontend);
  }
}

function startBackend(repo: string, python: string, port: number, frontendPort: number): ReturnType<typeof spawn> {
  const env = { ...process.env };
  delete env.STRIPE_SECRET_KEY;
  const ui = `http://127.0.0.1:${frontendPort}`;
  env.FRONTEND_URL = ui;
  if (frontendPort !== 5173) {
    env.CORS_ORIGINS = `${ui},http://localhost:${frontendPort}`;
  }
  return spawn(python, ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: path.join(repo, "backend"),
    stdio: "inherit",
    env,
  });
}

function startFrontend(repo: string, api: string, port: number): ReturnType<typeof spawn> {
  return spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: path.join(repo, "frontend"),
    stdio: "inherit",
    env: { ...process.env, VITE_API_BASE: api },
  });
}

async function prepareRepo(options: PreviewOptions): Promise<string> {
  if (!options.repo) throw new Error("--repo is required when not simulating");
  const repo = path.resolve(options.repo);
  if (!isMarketplace(repo)) {
    throw new Error(
      `${repo} is not a freshcart marketplace checkout (need backend/main.py and scripts/demo-checkout-metrics.py). Re-run with --simulate.`,
    );
  }
  if (options.branch) await ensureBranch(repo, options.branch);
  return repo;
}

async function reportLoop(options: PreviewOptions, api?: string, repo?: string): Promise<void> {
  const env = previewEnv(options.pr);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  do {
    const now = Date.now();
    let measured: Measurement | undefined;
    if (api && repo) {
      await run("python3", ["scripts/demo-checkout-metrics.py", "--api", api], repo);
      const traffic = await measureLatency(api);
      measured = { ...traffic, checkout: await readCheckoutMetrics(api) };
    }
    const body = buildIngestBody(options.pr, now, measured);
    await postIngest(options.datacat, body);
    const aov = body.points.find((point) => point.metric === AOV_CENTS);
    console.log(
      `[preview-runner] ${env} ${measured ? "live" : "simulated"} aov ${Math.round(aov?.v ?? 0)} cents`,
    );
    if (options.once || stopping) return;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  } while (!stopping);
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed === "help") {
    console.log(`Usage: scripts/preview-runner --pr <number> [--simulate | --repo <path>] [options]

  --pr <number>         Pull request number. Metrics are stored as preview-<number>.
  --simulate            Report healthy FreshCart metrics without starting the app.
  --repo <path>         jgrace19/marketplace checkout (backend + frontend).
  --branch <name>       Checkout this local branch first. Refuses a dirty tree.
  --port <number>       Backend port (default 8000).
  --frontend-port <n>   Vite port (default 5173).
  --datacat <url>       datacat base URL (default http://127.0.0.1:8787).
  --interval <ms>       Delay between reports (default 5000).
  --once                Send a single sample and exit.
  --help                Show this help.

Live mode starts uvicorn without STRIPE_SECRET_KEY, starts the Vite frontend,
and each sample runs scripts/demo-checkout-metrics.py then reads GET /api/metrics.
Pass --simulate when the app cannot be installed.`);
    return;
  }
  if (parsed.simulate) {
    console.log(`[preview-runner] simulating healthy metrics for ${previewEnv(parsed.pr)}`);
    await reportLoop(parsed);
    return;
  }
  const repo = await prepareRepo(parsed);
  const python = await ensureBackend(repo);
  await ensureFrontend(repo);
  const api = `http://127.0.0.1:${parsed.port}`;
  const backend = startBackend(repo, python, parsed.port, parsed.frontendPort);
  const frontend = startFrontend(repo, api, parsed.frontendPort);
  const kill = () => {
    if (!backend.killed) backend.kill("SIGTERM");
    if (!frontend.killed) frontend.kill("SIGTERM");
  };
  process.on("SIGINT", kill);
  process.on("SIGTERM", kill);
  try {
    await waitForHttp(`${api}/api/metrics`, 90_000);
    await waitForHttp(`http://127.0.0.1:${parsed.frontendPort}/`, 90_000);
    console.log(`[preview-runner] freshcart API ${api}`);
    console.log(`[preview-runner] freshcart UI http://127.0.0.1:${parsed.frontendPort}`);
    await reportLoop(parsed, api, repo);
  } finally {
    kill();
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`[preview-runner] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
