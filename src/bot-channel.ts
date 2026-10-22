import type { Config } from "./config.ts";
import { signBody } from "./sign.ts";

export const RESET_PATH = "/v1/channels/observability/reset";

type ChannelConfig = Pick<Config, "agentAliasToken" | "observabilitySharedSecret" | "webhookSecret" | "hmacHeader">;

/** Token and HMAC headers shared with the alert push. No session key. */
export function channelHeaders(config: ChannelConfig, body: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "datacat",
  };
  if (config.agentAliasToken) headers["X-Agent-Alias-Token"] = config.agentAliasToken;
  if (config.observabilitySharedSecret) headers["X-Observability-Token"] = config.observabilitySharedSecret;
  if (config.webhookSecret) headers[config.hmacHeader] = signBody(config.webhookSecret, body);
  return headers;
}

export function joinBot(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}${suffix}`;
}

export type BotResetResult = {
  status: number;
  ok: boolean;
  body: unknown;
};

/** POST the bot reset route. A 202, like any other 2xx, is success. */
export async function postBotReset(
  botAlias: string,
  config: ChannelConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<BotResetResult> {
  if (!botAlias) throw new Error("BOT_ALIAS is not set");
  const body = "{}";
  const response = await fetchImpl(joinBot(botAlias, RESET_PATH), {
    method: "POST",
    headers: channelHeaders(config, body),
    body,
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = { raw: text };
    }
  }
  const ok = response.status >= 200 && response.status < 300;
  return { status: response.status, ok, body: parsed };
}
