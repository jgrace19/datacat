import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { healthyValue, type MetricId } from "../src/metrics.ts";

const execFileAsync = promisify(execFile);

export type PreviewOptions = {
  pr: string;
  simulate: boolean;
  repo?: string;
  branch?: string;
  port: number;
  datacat: string;
  intervalMs: number;
  once: boolean;
};

type Measurement = {
  latencyMs: number;
  errorRate: number;
  requestCount: number;
};

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
    port: 4100,
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
    else if (arg.startsWith("--datacat=")) options.datacat = arg.slice("--datacat=".length);
    else if (arg === "--datacat") options.datacat = take("--datacat");
    else if (arg.startsWith("--interval=")) options.intervalMs = Number(arg.slice("--interval=".length));
    else if (arg === "--interval") options.intervalMs = Number(take("--interval"));
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!/^\d+$/.test(options.pr)) throw new Error("--pr is required and must be a pull request number");
  if (!options.simulate && !options.repo) throw new Error("pass --repo <next-app> or --simulate");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("--port must be an integer from 0 to 65535");
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
  const point = (metric: MetricId, v: number) => ({ metric, v, t: now });
  return {
    env,
    source: "preview-runner",
    points: [
      point("category_spend", healthyValue("category_spend", now, rand)),
      point("budget_calc_errors", healthyValue("budget_calc_errors", now, rand)),
      point(
        "request_latency_p95_ms",
        measured ? measured.latencyMs : healthyValue("request_latency_p95_ms", now, rand),
      ),
      point("error_rate", measured ? measured.errorRate : healthyValue("error_rate", now, rand)),
      point("request_count", measured ? measured.requestCount : healthyValue("request_count", now, rand)),
    ],
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

async function measure(base: string): Promise<Measurement> {
  const paths = ["/", "/", "/", "/", "/api/health", "/api/health"];
  const results = await Promise.all(paths.map((suffix) => probe(`${base}${suffix}`)));
  const failures = results.filter((result) => !result.ok).length;
  return {
    latencyMs: p95(results.map((result) => result.ms)),
    errorRate: failures / results.length,
    requestCount: results.length,
  };
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

function startNext(repo: string, port: number): { child: ReturnType<typeof spawn>; url: string } {
  const child = spawn("npx", ["next", "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: repo,
    stdio: "inherit",
  });
  return { child, url: `http://127.0.0.1:${port}` };
}

async function prepareRepo(options: PreviewOptions): Promise<string> {
  if (!options.repo) throw new Error("--repo is required when not simulating");
  const repo = path.resolve(options.repo);
  const packagePath = path.join(repo, "package.json");
  if (!existsSync(packagePath)) throw new Error(`No package.json at ${repo}`);
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps.next) {
    throw new Error(`No next dependency in ${repo}. Re-run with --simulate to report healthy preview metrics.`);
  }
  if (!existsSync(path.join(repo, "node_modules"))) {
    throw new Error(`node_modules is missing in ${repo}. Run npm install there, or pass --simulate.`);
  }
  if (options.branch) await ensureBranch(repo, options.branch);
  console.log(`[preview-runner] building ${repo}`);
  await run("npm", ["run", "build"], repo);
  return repo;
}

async function reportLoop(options: PreviewOptions, measureBase?: string): Promise<void> {
  const env = previewEnv(options.pr);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  do {
    const now = Date.now();
    const measured = measureBase ? await measure(measureBase) : undefined;
    const body = buildIngestBody(options.pr, now, measured);
    await postIngest(options.datacat, body);
    const latency = body.points.find((point) => point.metric === "request_latency_p95_ms");
    console.log(
      `[preview-runner] ${env} ${measured ? "live" : "simulated"} latency ${Math.round(latency?.v ?? 0)}ms`,
    );
    if (options.once || stopping) return;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  } while (!stopping);
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed === "help") {
    console.log(`Usage: scripts/preview-runner --pr <number> [--simulate | --repo <path>] [options]

  --pr <number>       Pull request number. Metrics are stored as preview-<number>.
  --simulate          Report healthy metrics without building an app.
  --repo <path>       Next.js app to build and run.
  --branch <name>     Checkout this local branch before building. Refuses a dirty tree.
  --port <number>     Port for \`next start\` (default 4100).
  --datacat <url>     datacat base URL (default http://127.0.0.1:8787).
  --interval <ms>     Delay between reports (default 5000).
  --once              Send a single sample and exit.
  --help              Show this help.

Budget totals are synthetic and healthy. With a real app, latency, error rate,
and request count come from traffic sent at the app. Pass --simulate when the
app cannot be built.`);
    return;
  }
  if (parsed.simulate) {
    console.log(`[preview-runner] simulating healthy metrics for ${previewEnv(parsed.pr)}`);
    await reportLoop(parsed);
    return;
  }
  const repo = await prepareRepo(parsed);
  const started = startNext(repo, parsed.port);
  const kill = () => {
    if (!started.child.killed) started.child.kill("SIGTERM");
  };
  process.on("SIGINT", kill);
  process.on("SIGTERM", kill);
  try {
    await waitForHttp(`${started.url}/`, 90_000);
    console.log(`[preview-runner] next app is up at ${started.url}`);
    await reportLoop(parsed, started.url);
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
