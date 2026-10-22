import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Preview runner binds here. A production deploy must never signal it. */
export const PROTECTED_PORT = 8000;

export const BACKEND_LOG = "/tmp/mp-backend.log";

export type CommandResult = { stdout: string; stderr: string };

export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<CommandResult>;

export function assertSafePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("backend port must be an integer from 1 to 65535");
  }
  if (port === PROTECTED_PORT) {
    throw new Error("refusing to restart port 8000");
  }
}

/** Exact restart line, with the port substituted after it has been checked. */
export function backendRestartCommand(port: number): string {
  assertSafePort(port);
  return `env -u STRIPE_SECRET_KEY nohup .venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port ${port} > ${BACKEND_LOG} 2>&1 &`;
}

export async function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 2_000_000,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
    const stderr = typeof failed.stderr === "string" ? failed.stderr.trim() : "";
    const wrapped = new Error(stderr || failed.message || `${command} failed`);
    (wrapped as Error & { code?: unknown; stdout?: string }).code = failed.code;
    (wrapped as Error & { stdout?: string }).stdout = typeof failed.stdout === "string" ? failed.stdout : "";
    throw wrapped;
  }
}

export type CheckoutSpec = {
  /** When set, `git fetch origin <branch>` instead of `pull/<pr>/head`. */
  branch?: string;
  /** When set, detach at this commit instead of FETCH_HEAD. */
  headSha?: string;
};

function isSafeRef(ref: string): boolean {
  if (!ref || ref.startsWith("-") || ref.includes("..") || ref.includes("@{") || ref.includes("//")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(ref);
}

export async function checkoutPullRequest(
  dir: string,
  pr: number,
  run: CommandRunner = runCommand,
  spec: CheckoutSpec = {},
): Promise<string> {
  if (!Number.isInteger(pr) || pr < 1) throw new Error("pull request number must be a positive integer");
  const branch = spec.branch?.trim() ?? "";
  const headSha = spec.headSha?.trim() ?? "";
  if (branch && !isSafeRef(branch)) throw new Error("branch is not a safe git ref");
  if (headSha && !/^[0-9a-f]{7,64}$/i.test(headSha)) throw new Error("headSha must be a hex git id");
  const ref = branch || `pull/${pr}/head`;
  await run("git", ["fetch", "origin", ref], dir);
  await run("git", ["checkout", "--detach", headSha || "FETCH_HEAD"], dir);
  const head = await run("git", ["rev-parse", "HEAD"], dir);
  return head.stdout.trim();
}

function parsePids(stdout: string): number[] {
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

async function listListeners(port: number, run: CommandRunner): Promise<number[]> {
  assertSafePort(port);
  try {
    const result = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], process.cwd());
    return parsePids(result.stdout);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 1) return [];
    if (code === "ENOENT") throw new Error("lsof is required to restart the marketplace backend");
    throw error;
  }
}

export async function stopListeners(
  port: number,
  deps: {
    run?: CommandRunner;
    signal?: (pid: number, signal: NodeJS.Signals) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  assertSafePort(port);
  const run = deps.run ?? runCommand;
  const signal = deps.signal ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pids = await listListeners(port, run);
  for (const pid of pids) {
    if (pid === process.pid) continue;
    signal(pid, "SIGTERM");
  }
  if (pids.length === 0) return;
  await sleep(400);
  const left = await listListeners(port, run);
  for (const pid of left) {
    if (pid === process.pid) continue;
    signal(pid, "SIGKILL");
  }
}

async function defaultSpawnShell(command: string, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      detached: true,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`backend restart exited ${code ?? "signal"}`));
    });
    child.unref();
  });
}

export async function restartMarketplaceBackend(options: {
  marketplaceDir: string;
  port: number;
  stopListeners?: (port: number) => Promise<void>;
  spawnShell?: (command: string, cwd: string) => Promise<void>;
}): Promise<void> {
  const command = backendRestartCommand(options.port);
  const stop = options.stopListeners ?? ((port: number) => stopListeners(port));
  await stop(options.port);
  const cwd = `${options.marketplaceDir.replace(/\/+$/, "")}/backend`;
  const spawnShell = options.spawnShell ?? defaultSpawnShell;
  await spawnShell(command, cwd);
}

export async function waitForHttpOk(
  url: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 500;
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  let last = "no response";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(2_000) });
      await response.arrayBuffer().catch(() => undefined);
      if (response.status === 200) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts - 1) await sleep(intervalMs);
  }
  throw new Error(`${url} did not return 200: ${last}`);
}

export async function deployPullRequest(
  pr: number,
  options: {
    marketplaceDir: string;
    port: number;
    run?: CommandRunner;
    stopListeners?: (port: number) => Promise<void>;
    spawnShell?: (command: string, cwd: string) => Promise<void>;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    sleep?: (ms: number) => Promise<void>;
    healthTimeoutMs?: number;
    branch?: string;
    headSha?: string;
  },
): Promise<{ sha: string }> {
  assertSafePort(options.port);
  console.log(`[datacat] ship PR #${pr} fetching head in ${options.marketplaceDir}`);
  const sha = await checkoutPullRequest(options.marketplaceDir, pr, options.run, {
    branch: options.branch,
    headSha: options.headSha,
  });
  console.log(`[datacat] ship PR #${pr} checked out ${sha}`);
  console.log(`[datacat] ship PR #${pr} restarting backend on ${options.port}`);
  await restartMarketplaceBackend({
    marketplaceDir: options.marketplaceDir,
    port: options.port,
    stopListeners: options.stopListeners,
    spawnShell: options.spawnShell,
  });
  const healthUrl = `http://127.0.0.1:${options.port}/api/health`;
  console.log(`[datacat] ship PR #${pr} waiting for ${healthUrl}`);
  await waitForHttpOk(healthUrl, {
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    timeoutMs: options.healthTimeoutMs,
  });
  return { sha };
}
