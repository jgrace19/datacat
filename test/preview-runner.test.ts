import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AOV_CENTS, ORDERS } from "../src/metrics.ts";
import { buildIngestBody, parseArgs, previewEnv } from "../scripts/preview-runner.ts";
import { startTestServer } from "./helpers.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(root, "node_modules", ".bin", "tsx");

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, ["scripts/preview-runner.ts", ...args], { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

test("parseArgs requires a numeric PR and a mode", () => {
  assert.throws(() => parseArgs(["--simulate"]), /--pr/);
  assert.throws(() => parseArgs(["--pr", "abc", "--simulate"]), /pull request number/);
  assert.throws(() => parseArgs(["--pr", "8"]), /--simulate/);
  const options = parseArgs(["--pr=8", "--simulate", "--once", "--datacat", "http://127.0.0.1:8787/"]);
  assert.notEqual(options, "help");
  if (options === "help") return;
  assert.equal(options.pr, "8");
  assert.equal(options.simulate, true);
  assert.equal(options.once, true);
  assert.equal(options.datacat, "http://127.0.0.1:8787");
  assert.equal(previewEnv("8"), "preview-8");
});

test("a simulated sample is healthy and addressed to preview-<pr>", () => {
  const body = buildIngestBody("8", Date.UTC(2026, 9, 22, 12, 0, 0));
  assert.equal(body.env, "preview-8");
  const aov = body.points.find((point) => point.metric === AOV_CENTS);
  const orders = body.points.find((point) => point.metric === ORDERS);
  assert.ok(aov && Math.abs(aov.v - 3483) < 40);
  assert.equal(orders?.v, 4);
  assert.equal(body.points.length, 6);
});

test("help and a non-Next repo exit with a useful status", { timeout: 20_000 }, async () => {
  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--simulate/);

  const dir = await mkdtemp(path.join(tmpdir(), "datacat-repo-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "not-next", dependencies: { react: "1.0.0" } }),
  );
  const failed = await run(["--pr", "4", "--repo", dir]);
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /freshcart|demo-checkout-metrics/i);
});

test("simulate --once reports preview-<pr> to datacat", { timeout: 20_000 }, async () => {
  const started = await startTestServer();
  try {
    const result = await run(["--pr", "128", "--simulate", "--once", "--datacat", started.url]);
    assert.equal(result.code, 0, result.stderr);
    const response = await fetch(
      `${started.url}/api/query?metric=${encodeURIComponent(AOV_CENTS)}&env=preview-128&from=0&to=${Date.now() + 60_000}`,
    );
    const body = (await response.json()) as { points: Array<{ v: number }> };
    assert.ok(body.points.length >= 1);
    assert.ok(Math.abs((body.points.at(-1)?.v ?? 0) - 3483) < 80);
  } finally {
    await started.close();
  }
});
