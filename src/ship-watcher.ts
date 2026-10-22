import { main } from "./server.ts";

process.env.SHIP_WATCH_ENABLED = "true";

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
