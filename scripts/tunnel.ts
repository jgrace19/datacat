import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

export const TUNNEL_ORIGIN = "http://127.0.0.1:8787";
export const CLOUDFLARED_ARGS = ["tunnel", "--url", TUNNEL_ORIGIN];
export const LOCALTUNNEL_ARGS = ["--yes", "localtunnel", "--port", "8787"];
export const TUNNEL_URL_FILE = ".tunnel-url";

/** First public https URL once the following character shows the token is complete. */
export function findTunnelUrl(text: string): string | undefined {
  const match = text.match(/https:\/\/[^\s"'<>|]+(?=[\s|])/);
  if (!match) return undefined;
  return match[0].replace(/[),.;]+$/, "");
}

export function rememberTunnelUrl(url: string, file = TUNNEL_URL_FILE): void {
  writeFileSync(file, `${url}\n`);
  console.log(`[datacat] tunnel ${url}`);
}

type UrlWait = {
  url: Promise<string | null>;
  published: () => boolean;
};

function watchForUrl(child: ChildProcess, timeoutMs: number, file: string): UrlWait {
  let published = false;
  const url = new Promise<string | null>((resolve) => {
    let buffer = "";
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      buffer = (buffer + text).slice(-8192);
      const found = findTunnelUrl(buffer);
      if (!found) return;
      published = true;
      rememberTunnelUrl(found, file);
      finish(found);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", () => finish(null));
    child.on("exit", (code) => {
      if (published) process.exit(code ?? 0);
      else finish(null);
    });
  });
  return { url, published: () => published };
}

function spawnTunnel(command: string, args: string[]): ChildProcess | undefined {
  try {
    return spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return undefined;
  }
}

async function hold(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
  });
}

export async function openTunnel(file = path.join(process.cwd(), TUNNEL_URL_FILE)): Promise<void> {
  const cloudflared = spawnTunnel("cloudflared", CLOUDFLARED_ARGS);
  if (cloudflared) {
    const watched = watchForUrl(cloudflared, 20_000, file);
    const url = await watched.url;
    if (url) {
      await hold(cloudflared);
      return;
    }
    cloudflared.kill();
  }
  console.error("[datacat] cloudflared unavailable, trying localtunnel");
  const local = spawnTunnel("npx", LOCALTUNNEL_ARGS);
  if (!local) throw new Error("could not start a tunnel");
  const watched = watchForUrl(local, 60_000, file);
  const url = await watched.url;
  if (!url) {
    local.kill();
    throw new Error("tunnel did not publish an https URL");
  }
  await hold(local);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.endsWith(`${path.sep}tunnel.ts`) || entry.endsWith(`${path.sep}tunnel.js`);
}

if (isDirectRun()) {
  openTunnel().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
