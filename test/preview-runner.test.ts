import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
  assert.equal(body.points.length, 5);
  const spend = body.points.find((point) => point.metric === "category_spend");
  const errors = body.points.find((point) => point.metric === "budget_calc_errors");
  assert.ok(spend && spend.v > 50_000);
  assert.ok(errors && errors.v < 8);
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
  assert.match(failed.stderr, /next/i);
});

test("simulate --once reports preview-<pr> to datacat", { timeout: 20_000 }, async () => {
  const started = await startTestServer();
  try {
    const result = await run(["--pr", "128", "--simulate", "--once", "--datacat", started.url]);
    assert.equal(result.code, 0, result.stderr);
    const response = await fetch(
      `${started.url}/api/query?metric=category_spend&env=preview-128&from=0&to=${Date.now() + 60_000}`,
    );
    const body = (await response.json()) as { points: Array<{ v: number }> };
    assert.ok(body.points.length >= 1);
    assert.ok((body.points.at(-1)?.v ?? 0) > 50_000);
  } finally {
    await started.close();
  }
});
