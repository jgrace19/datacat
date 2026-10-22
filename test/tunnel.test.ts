import assert from "node:assert/strict";
import test from "node:test";
import { CLOUDFLARED_ARGS, findTunnelUrl, LOCALTUNNEL_ARGS, TUNNEL_ORIGIN } from "../scripts/tunnel.ts";

test("tunnel commands target datacat and urls are read from tool output", () => {
  assert.deepEqual(CLOUDFLARED_ARGS, ["tunnel", "--url", TUNNEL_ORIGIN]);
  assert.deepEqual(LOCALTUNNEL_ARGS, ["--yes", "localtunnel", "--port", "8787"]);
  assert.equal(TUNNEL_ORIGIN, "http://127.0.0.1:8787");

  const cloudflared = "2026-10-22 INF |  https://fresh-cart.trycloudflare.com  |";
  assert.equal(findTunnelUrl(cloudflared), "https://fresh-cart.trycloudflare.com");
  assert.equal(findTunnelUrl("your url is: https://fresh-cart.loca.lt\n"), "https://fresh-cart.loca.lt");
  assert.equal(findTunnelUrl("https://partial.trycloudflare.com"), undefined);
});