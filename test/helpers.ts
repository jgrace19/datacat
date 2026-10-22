import http from "node:http";
import { DatacatApp, type CreateAppOptions } from "../src/app.ts";
import { createServer, listen } from "../src/server.ts";

export async function startTestServer(options: CreateAppOptions = {}) {
  const app = new DatacatApp({
    ...options,
    config: {
      historyHours: 0,
      generatorIntervalMs: 60_000,
      metricsPushEnabled: false,
      metricsPushIntervalMs: 15_000,
      botAlias: "",
      agentAliasToken: "",
      webhookSecret: "",
      hmacHeader: "X-Datacat-Signature",
      port: 0,
      host: "127.0.0.1",
      ...options.config,
    },
  });
  const server = createServer(app);
  const port = await listen(server, 0, "127.0.0.1");
  return {
    app,
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      app.stopLoops();
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export async function startMockBot() {
  const requests: Array<{
    url: string;
    method: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }> = [];
  let status = 202;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: status < 300 }));
    });
  });
  const port = await listen(server, 0, "127.0.0.1");
  return {
    requests,
    url: `http://127.0.0.1:${port}`,
    setStatus(code: number) {
      status = code;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
