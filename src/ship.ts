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
  source: "hook" | "label";
  incidentId?: string;
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
  labelFallback: boolean;
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

export type ShipTarget = {
  pr: number;
  sha: string;
  branch: string;
  incidentId?: string;
  title: string;
  url: string;
  source: "hook" | "label";
};

export type ShipHookBody = {
  incidentId: string;
  prNumber: number;
  branch: string;
  headSha: string;
};

export type ShipAcceptResult = {
  duplicate: boolean;
  deploy: DeployRecord;
};

export type ShipWatcherOptions = {
  config: ShipConfig;
  listPulls?: () => Promise<ShipPull[]>;
  deploy?: (target: ShipTarget, config: ShipConfig) => Promise<{ sha: string }>;
  onDeployed?: (event: { pr: number; incidentId?: string }) => void;
  now?: () => number;
  /** `false` keeps the handled set in memory. Omit to use the temp file. */
  stateFile?: string | false;
};

export class ShipWatcher {
  private readonly config: ShipConfig;
  private readonly listPulls: () => Promise<ShipPull[]>;
  private readonly deploy: (target: ShipTarget, config: ShipConfig) => Promise<{ sha: string }>;
  private readonly onDeployed: ((event: { pr: number; incidentId?: string }) => void) | undefined;
  private readonly now: () => number;
  private readonly stateFile: string | undefined;
  private readonly handled: Set<string>;
  private readonly deploys: DeployRecord[] = [];
  private readonly inflightHooks = new Map<string, Promise<DeployRecord>>();
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
        deployPullRequest(pull.pr, {
          marketplaceDir: config.marketplaceDir,
          port: config.backendPort,
          branch: pull.branch,
          headSha: pull.sha,
        }));
    this.stateFile =
      options.stateFile === undefined ? HANDLED_FILE : options.stateFile === false ? undefined : options.stateFile;
    this.handled = this.stateFile ? loadHandled(this.stateFile) : new Set();
  }

  start(): void {
    if (this.timer || !this.config.enabled || !this.config.labelFallback) return;
    console.log(
      `[datacat] ship label fallback polling ${this.config.repo} base ${this.config.base} label ${this.config.label} every ${this.config.intervalMs}ms`,
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
    if (!this.config.enabled || !this.config.labelFallback || this.inflight) return;
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
      labelFallback: this.config.labelFallback,
      marketplaceDir: this.config.marketplaceDir,
      backendPort: this.config.backendPort,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      handled: [...this.handled].sort(),
      deploys: this.deploys.map((record) => ({ ...record, recovery: record.recovery ? { ...record.recovery } : undefined })),
    };
  }

  clearHandled(): void {
    this.handled.clear();
    if (this.stateFile) saveHandled(this.stateFile, this.handled);
  }

  /** Deploy a pushed ship hook. A repeated incidentId does not deploy again. */
  async accept(hook: ShipHookBody): Promise<ShipAcceptResult> {
    const incidentId = hook.incidentId.trim();
    if (!incidentId) throw new Error("incidentId is required");
    if (!Number.isInteger(hook.prNumber) || hook.prNumber < 1) throw new Error("prNumber must be a positive integer");
    const key = `incident:${incidentId}`;
    if (this.handled.has(key)) {
      return { duplicate: true, deploy: this.recordFor(incidentId, hook.prNumber) };
    }
    const pending = this.inflightHooks.get(key);
    if (pending) {
      return { duplicate: true, deploy: await pending };
    }
    const work = this.deployHook(hook, key);
    this.inflightHooks.set(key, work);
    try {
      const deploy = await work;
      return { duplicate: false, deploy };
    } finally {
      this.inflightHooks.delete(key);
    }
  }

  private recordFor(incidentId: string, pr: number): DeployRecord {
    const found = this.deploys.find((item) => item.incidentId === incidentId);
    if (found) return { ...found, recovery: found.recovery ? { ...found.recovery } : undefined };
    return {
      pr,
      sha: "",
      title: "",
      url: "",
      source: "hook",
      incidentId,
      status: "healthy",
      startedAt: this.now(),
      healthUrl: `http://127.0.0.1:${this.config.backendPort}/api/health`,
      dir: this.config.marketplaceDir,
      backendPort: this.config.backendPort,
    };
  }

  private async deployHook(hook: ShipHookBody, key: string): Promise<DeployRecord> {
    const target: ShipTarget = {
      pr: hook.prNumber,
      sha: hook.headSha.trim(),
      branch: hook.branch.trim(),
      incidentId: hook.incidentId.trim(),
      title: hook.branch.trim(),
      url: "",
      source: "hook",
    };
    const record = await this.deployTarget(target);
    if (record.status === "healthy") {
      this.remember(key);
      console.log(`[datacat] ship hook ${target.incidentId} PR #${target.pr} healthy (${record.sha.slice(0, 12)})`);
      this.onDeployed?.({ pr: target.pr, incidentId: target.incidentId });
    }
    return record;
  }

  private async deployOne(pull: ShipPull): Promise<void> {
    const record = await this.deployTarget({
      pr: pull.number,
      sha: pull.sha,
      branch: "",
      title: pull.title,
      url: pull.url,
      source: "label",
    });
    if (record.status !== "healthy") return;
    this.remember(`${pull.number}:${pull.sha}`);
    if (record.sha !== pull.sha) this.remember(`${pull.number}:${record.sha}`);
    console.log(`[datacat] ship PR #${pull.number} healthy (${record.sha.slice(0, 12)})`);
    this.onDeployed?.({ pr: pull.number });
  }

  private async deployTarget(target: ShipTarget): Promise<DeployRecord> {
    const record: DeployRecord = {
      pr: target.pr,
      sha: target.sha,
      title: target.title,
      url: target.url,
      source: target.source,
      incidentId: target.incidentId,
      status: "deploying",
      startedAt: this.now(),
      healthUrl: `http://127.0.0.1:${this.config.backendPort}/api/health`,
      dir: this.config.marketplaceDir,
      backendPort: this.config.backendPort,
    };
    this.deploys.unshift(record);
    if (this.deploys.length > 50) this.deploys.pop();
    const label = target.incidentId ? `${target.incidentId} PR #${target.pr}` : `PR #${target.pr}`;
    console.log(`[datacat] ship ${label} ${(target.sha || "head").slice(0, 12)} deploying`);
    try {
      const result = await this.deploy(target, this.config);
      record.sha = result.sha || target.sha;
      record.status = "healthy";
      record.finishedAt = this.now();
      record.recovery = { status: "pending" };
    } catch (error) {
      record.status = "failed";
      record.finishedAt = this.now();
      record.error = error instanceof Error ? error.message : String(error);
      console.error(`[datacat] ship ${label} failed: ${record.error}`);
    }
    return record;
  }

  private remember(key: string): void {
    this.handled.add(key);
    if (this.stateFile) saveHandled(this.stateFile, this.handled);
  }
}
