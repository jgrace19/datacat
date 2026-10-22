import { configFromEnv, loadEnvFile } from "./config.ts";
import { postBotReset } from "./bot-channel.ts";

export async function main(): Promise<void> {
  loadEnvFile();
  const config = configFromEnv();
  const result = await postBotReset(config.botAlias, config);
  console.log(JSON.stringify(result.body, null, 2));
  if (!result.ok) {
    console.error(`[datacat] bot reset failed (HTTP ${result.status})`);
    process.exitCode = 1;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return entry.endsWith("reset-bot.ts") || entry.endsWith("reset-bot.js");
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
