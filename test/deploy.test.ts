import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  backendRestartCommand,
  checkoutPullRequest,
  deployPullRequest,
  stopListeners,
  waitForHttpOk,
  type CommandRunner,
} from "../src/deploy.ts";
import { listen } from "../src/server.ts";

const RESTART =
  "env -u STRIPE_SECRET_KEY nohup .venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8010 > /tmp/mp-backend.log 2>&1 &";

test("the backend restart command is the production line and never targets port 8000", () => {
  assert.equal(backendRestartCommand(8010), RESTART);
  assert.equal(RESTART.includes("8000"), false);
  assert.throws(() => backendRestartCommand(8000), /refusing to restart port 8000/);
  assert.throws(() => backendRestartCommand(0), /integer/);
});

test("checkout fetches the pull request head and detaches", async () => {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args, cwd) => {
    calls.push(`${command} ${args.join(" ")} ${cwd}`);
    if (args[0] === "rev-parse") return { stdout: "abc1234def\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const sha = await checkoutPullRequest("/work/marketplace", 19, run);
  assert.equal(sha, "abc1234def");
  assert.deepEqual(calls, [
    "git fetch origin pull/19/head /work/marketplace",
    "git checkout --detach FETCH_HEAD /work/marketplace",
    "git rev-parse HEAD /work/marketplace",
  ]);
});

test("stopping listeners only signals the requested port", async () => {
  const signals: string[] = [];
  let lookups = 0;
  const run: CommandRunner = async (command, args) => {
    assert.equal(command, "lsof");
    assert.ok(args.includes("-iTCP:8010"));
    lookups += 1;
    if (lookups === 1) return { stdout: "4321\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  await stopListeners(8010, {
    run,
    signal: (pid, sig) => signals.push(`${pid}:${sig}`),
    sleep: async () => {},
  });
  assert.deepEqual(signals, ["4321:SIGTERM"]);

  const blocked: string[] = [];
  await assert.rejects(
    () =>
      stopListeners(8000, {
        run: async () => {
          throw new Error("lsof should not run");
        },
        signal: (pid, sig) => blocked.push(`${pid}:${sig}`),
      }),
    /refusing to restart port 8000/,
  );
  assert.deepEqual(blocked, []);
});

test("a quiet lsof exit means nothing is listening", async () => {
  const run: CommandRunner = async () => {
    const error = new Error("no matches") as Error & { code?: number };
    error.code = 1;
    throw error;
  };
  await stopListeners(8010, { run, sleep: async () => {} });
});

test("health waits until the status is 200", async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    const status = req.url === "/api/health" && hits >= 2 ? 200 : 503;
    res.writeHead(status);
    res.end(status === 200 ? "ok" : "no");
  });
  const port = await listen(server, 0, "127.0.0.1");
  try {
    await waitForHttpOk(`http://127.0.0.1:${port}/api/health`, {
      timeoutMs: 2_000,
      intervalMs: 10,
    });
    assert.ok(hits >= 2);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("deploy checks out, restarts only the backend port, and waits for health", async () => {
  const order: string[] = [];
  const sha = await deployPullRequest(12, {
    marketplaceDir: "/market",
    port: 8010,
    run: async (command, args, cwd) => {
      order.push(`${command} ${args.join(" ")} @ ${cwd}`);
      if (args[0] === "rev-parse") return { stdout: "deadbeef\n", stderr: "" };
      return { stdout: "", stderr: "" };
    },
    stopListeners: async (port) => {
      order.push(`stop ${port}`);
    },
    spawnShell: async (command, cwd) => {
      order.push(`spawn ${command} @ ${cwd}`);
    },
    fetchImpl: async (url) => {
      order.push(`health ${String(url)}`);
      return new Response("ok", { status: 200 });
    },
    sleep: async () => {},
    healthTimeoutMs: 1_000,
  });
  assert.equal(sha.sha, "deadbeef");
  assert.deepEqual(order, [
    "git fetch origin pull/12/head @ /market",
    "git checkout --detach FETCH_HEAD @ /market",
    "git rev-parse HEAD @ /market",
    "stop 8010",
    `spawn ${RESTART} @ /market/backend`,
    "health http://127.0.0.1:8010/api/health",
  ]);
  await assert.rejects(
    () =>
      deployPullRequest(1, {
        marketplaceDir: "/market",
        port: 8000,
        run: async () => {
          throw new Error("git should not run");
        },
      }),
    /8000/,
  );
});
