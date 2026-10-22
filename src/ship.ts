import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ShipConfig } from "./config.ts";
import { assertSafePort, deployPullRequest, runCommand } from "./deploy.ts";

export type ShipPull = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  sha: string;
};

export type DeployRecovery = {
  status: "pending" | "delivered" | "failed" | "skipped";
  statusCode?: number;
  error?: string;
};

export type DeployRecord = {
  pr: number;
  sha: string;
  title: string;
  url: string;
  status: "deploying" | "healthy" | "failed";
  startedAt: number;
  finishedAt?: number;
  error?: string;
  healthUrl: string;
  dir: string;
  backendPort: number;
  recovery?: DeployRecovery;
};

export type DeployStatus = {
  enabled: boolean;
  intervalMs: number;
  repo: string;
  base: string;
  label: string;
  marketplaceDir: string;
  backendPort: number;
  lastPollAt: number | null;
  lastError: string | null;
  handled: string[];
  deploys: DeployRecord[];
};

export type RecoveryNotice = {
  pr: number;
  status: "delivered" | "failed" | "skipped";
  statusCode?: number;
  error?: string;
};

const HANDLED_FILE = path.join(tmpdir(), "datacat-ship-handled.json");

export function shipListArgs(config: Pick<ShipConfig, "repo" | "base" | "label">): string[] {
  return [
    "pr",
    "list",
    "--repo",
    config.repo,
    "--base",
    config.base,
    "--label",
    config.label,
    "--state",
    "open",
    "--limit",
    "50",
    "--json",
    "number,title,url,headRefName,headRefOid",
  ];
}

export function parseShipPulls(stdout: string): ShipPull[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("gh pr list did not return JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("gh pr list did not return a JSON array");
  const pulls: ShipPull[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const number = row.number;
    const sha = row.headRefOid;
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) continue;
    if (typeof sha !== "string" || !/^[0-9a-f]{7,64}$/i.test(sha)) continue;
    const title = typeof row.title === "string" ? row.title.slice(0, 200) : "";
    const url = typeof row.url === "string" ? row.url : "";
    const headRefName = typeof row.headRefName === "string" ? row.headRefName : "";
    pulls.push({ number, title, url, headRefName, sha });
  }
  return pulls;
}

function loadHandled(file: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function saveHandled(file: string, handled: Set<string>): void {
  writeFileSync(file, JSON.stringify([...handled]), "utf8");
}

export type ShipWatcherOptions = {
  config: ShipConfig;
  listPulls?: () => Promise<ShipPull[]>;
  deploy?: (pull: ShipPull, config: ShipConfig) => Promise<{ sha: string }>;
  onDeployed?: (pr: number) => void;
  now?: () => number;
  /** `false` keeps the handled set in memory. Omit to use the temp file. */
  stateFile?: string | false;
};

export class ShipWatcher {
  private readonly config: ShipConfig;
  private readonly listPulls: () => Promise<ShipPull[]>;
  private readonly deploy: (pull: ShipPull, config: ShipConfig) => Promise<{ sha: string }>;
  private readonly onDeployed: ((pr: number) => void) | undefined;
  private readonly now: () => number;
  private readonly stateFile: string | undefined;
  private readonly handled: Set<string>;
  private readonly deploys: DeployRecord[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private inflight = false;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;

  constructor(options: ShipWatcherOptions) {
    assertSafePort(options.config.backendPort);
    this.config = options.config;
    this.now = options.now ?? (() => Date.now());
    this.onDeployed = options.onDeployed;
    this.listPulls =
      options.listPulls ??
      (async () => {
        const result = await runCommand("gh", shipListArgs(this.config), process.cwd());
        return parseShipPulls(result.stdout);
      });
    this.deploy =
      options.deploy ??
      (async (pull, config) =>
        deployPullRequest(pull.number, {
          marketplaceDir: config.marketplaceDir,
          port: config.backendPort,
        }));
    this.stateFile =
      options.stateFile === undefined ? HANDLED_FILE : options.stateFile === false ? undefined : options.stateFile;
    this.handled = this.stateFile ? loadHandled(this.stateFile) : new Set();
  }

  start(): void {
    if (this.timer || !this.config.enabled) return;
    console.log(
      `[datacat] ship watcher polling ${this.config.repo} base ${this.config.base} label ${this.config.label} every ${this.config.intervalMs}ms`,
    );
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.config.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async poll(): Promise<void> {
    if (!this.config.enabled || this.inflight) return;
    this.inflight = true;
    try {
      let pulls: ShipPull[];
      try {
        pulls = await this.listPulls();
        this.lastPollAt = this.now();
        this.lastError = null;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        console.error(`[datacat] ship poll failed: ${this.lastError}`);
        return;
      }
      for (const pull of pulls) {
        const key = `${pull.number}:${pull.sha}`;
        if (this.handled.has(key)) continue;
        await this.deployOne(pull);
      }
    } finally {
      this.inflight = false;
    }
  }

  noteRecovery(notice: RecoveryNotice): void {
    const record = this.deploys.find((item) => item.pr === notice.pr && item.recovery);
    if (!record?.recovery) return;
    record.recovery = {
      status: notice.status,
      statusCode: notice.statusCode,
      error: notice.error,
    };
  }

  status(): DeployStatus {
    return {
      enabled: this.config.enabled,
      intervalMs: this.config.intervalMs,
      repo: this.config.repo,
      base: this.config.base,
      label: this.config.label,
      marketplaceDir: this.config.marketplaceDir,
      backendPort: this.config.backendPort,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      handled: [...this.handled].sort(),
      deploys: this.deploys.map((record) => ({ ...record, recovery: record.recovery ? { ...record.recovery } : undefined })),
    };
  }

  private async deployOne(pull: ShipPull): Promise<void> {
    const record: DeployRecord = {
      pr: pull.number,
      sha: pull.sha,
      title: pull.title,
      url: pull.url,
      status: "deploying",
      startedAt: this.now(),
      healthUrl: `http://127.0.0.1:${this.config.backendPort}/api/health`,
      dir: this.config.marketplaceDir,
      backendPort: this.config.backendPort,
    };
    this.deploys.unshift(record);
    if (this.deploys.length > 50) this.deploys.pop();
    console.log(`[datacat] ship PR #${pull.number} ${pull.sha.slice(0, 12)} deploying`);
    try {
      const result = await this.deploy(pull, this.config);
      const sha = result.sha || pull.sha;
      record.sha = sha;
      record.status = "healthy";
      record.finishedAt = this.now();
      record.recovery = { status: "pending" };
      this.remember(`${pull.number}:${pull.sha}`);
      if (sha !== pull.sha) this.remember(`${pull.number}:${sha}`);
      console.log(`[datacat] ship PR #${pull.number} healthy (${sha.slice(0, 12)})`);
      this.onDeployed?.(pull.number);
    } catch (error) {
      record.status = "failed";
      record.finishedAt = this.now();
      record.error = error instanceof Error ? error.message : String(error);
      console.error(`[datacat] ship PR #${pull.number} failed: ${record.error}`);
    }
  }

  private remember(key: string): void {
    this.handled.add(key);
    if (this.stateFile) saveHandled(this.stateFile, this.handled);
  }
}
