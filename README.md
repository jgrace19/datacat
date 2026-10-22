# datacat

Local mock observability for a Cursor BDK anomaly-triage demo. It keeps time series in memory, draws a console for them, and pushes alerts to a bot. Nothing here calls a third-party metrics service.

The monitored service in the demo is **budgetsphere**. `prod` is filled by a synthetic generator. A preview app reports into `preview-<pr>` through `POST /api/ingest`.

## Setup

Node.js 20 or newer.

```bash
cp .env.example .env
npm install
npm run dev
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). History for `prod` is synthesized on boot (24 hours by default), then a new sample is appended every 5 seconds.

`npm start` runs the same server without the file watcher. `npm test` runs the unit and HTTP tests.

The process binds to `127.0.0.1`. A hosted bot cannot dial this laptop; datacat pushes alerts and snapshots out to `BOT_ALIAS` instead.

## Demo

1. Leave the dashboard on `$env = prod` and **Past 1 Hour**. Category spend, budget-calc errors, latency, error rate, and request count should sit in the healthy band. Monitor pills read **OK**.
2. Click **Trigger anomaly**. Category spend drops: 1st-of-month expenses are missing from `spentByCategory` (about 42% of the total remains). Budget-calc errors jump at the same time, and the error rate lifts into **WARN**. A red banner names the incident. The incident row shows delivery:
   - **SKIPPED** when `BOT_ALIAS` is empty
   - **DELIVERED** with the HTTP status and response body when the bot accepts it
   - **FAILED** with the error, and a **Retry** control
3. Click **Trigger expected spike**. Request count and p95 latency rise, and the charts get a **feature flag** annotation. That path does not open an incident and does not POST an alert. The banner is amber.
4. Click **Resolve**. The affected window returns to the baseline and the incident moves to **RESOLVED**.
5. In another terminal, report a preview environment without building an app:

   ```bash
   ./scripts/preview-runner --pr 128 --simulate
   ```

   Choose `$env = preview-128`. Those series are healthy until you trigger an anomaly on that env. Ingested category spend is scaled while the anomaly is open, so a healthy runner still shows the drop.
6. On **Integrations**, set the bot alias if you did not put it in `.env`, turn **Snapshot push** on, or click **Push now**. The event stream records delivery changes.

Useful curls:

```bash
curl -s 'http://127.0.0.1:8787/api/query?metric=category_spend&env=prod&from=0&to=9999999999999'
curl -s -X POST http://127.0.0.1:8787/api/anomaly -H 'content-type: application/json' -d '{"env":"prod"}'
curl -s -X POST http://127.0.0.1:8787/api/expected-spike -H 'content-type: application/json' -d '{"env":"prod"}'
curl -s -X POST http://127.0.0.1:8787/api/resolve -H 'content-type: application/json' -d '{"env":"prod"}'
```

## Alert contract

On a new incident, datacat POSTs once to:

`$BOT_ALIAS/v1/channels/observability/alert`

```json
{
  "incidentId": "inc_…",
  "metric": "category_spend",
  "env": "prod",
  "baseline": 96840.12,
  "value": 40672.85,
  "window": "5m"
}
```

Headers:

| Header | When |
| --- | --- |
| `Content-Type: application/json` | always |
| `X-BDK-Session-Key: incident:<incidentId>` | always |
| `X-Agent-Alias-Token` | `AGENT_ALIAS_TOKEN` is non-empty |
| `X-Datacat-Signature: sha256=<hex>` | `DATACAT_WEBHOOK_SECRET` is non-empty. The header name is `DATACAT_HMAC_HEADER`. The hex is HMAC-SHA256 of the raw body. |

A 2xx is stored as delivered and is not sent again for that `incidentId`. Non-2xx responses retry up to 8 times with the same id. Treat `incidentId` as the idempotency key. The incident row in the UI keeps the status code and response body.

Verify a signature with the raw body, not a re-serialized object:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verified(secret, rawBody, header) {
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex"));
  const actual = Buffer.from(header ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
```

## Snapshot push

When snapshot push is on, datacat POSTs to `$BOT_ALIAS/v1/channels/observability/metrics` on `METRICS_PUSH_INTERVAL_MS` (minimum 2000). The dashboard toggle overrides the enabled flag until restart. **Push now** sends one snapshot even if the toggle is off.

The JSON body is `{ sentAt, snapshots, openIncidents }`. Each snapshot has `env`, `metric`, `unit`, `latest`, `baseline`, `status`, and up to 30 points from the last 5 minutes. Auth headers match the alert, with `X-BDK-Session-Key: metrics:snapshot`.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/query?metric&env&from&to` | Points in the window. `from` and `to` are epoch ms or ISO-8601. Defaults to the past hour. Optional `max` downsamples. |
| `POST` | `/api/ingest` | `{ "env": "preview-128", "source": "preview-runner", "points": [{ "metric", "v", "t"? }] }`. `prod` is rejected. A single `{ env, metric, v, t? }` body is also accepted. |
| `POST` | `/api/anomaly` | `{ "env": "prod", "metric": "category_spend" }`. Opens one incident per open env+metric pair. |
| `POST` | `/api/resolve` | `{ "env": "prod", "incidentId": "optional" }`. Clears anomaly mode and an expected spike for that env. |
| `POST` | `/api/expected-spike` | `{ "env": "prod", "label": "feature flag launch" }`. Does not page. |
| `GET` | `/api/dashboard?env&range` | `range` is `15m`, `1h`, `4h`, or `1d`. |
| `POST` | `/api/settings` | `{ "botAlias", "pushEnabled", "pushIntervalMs" }`. Token and HMAC secret stay in the environment. |
| `POST` | `/api/push-now` | Send one snapshot. |
| `POST` | `/api/incidents/:id/redeliver` | Retry a delivery that has not succeeded. |

`env` is `prod` or `preview-<name>` (letters, digits, `.`, `_`, `-`).

## Preview runner

```bash
./scripts/preview-runner --pr 128 --simulate
./scripts/preview-runner --pr 128 --repo ../budgetsphere --branch feature/spend-fix --port 4100
./scripts/preview-runner --pr 128 --simulate --once --datacat http://127.0.0.1:8787
```

`--pr` is required and becomes the env name `preview-<pr>`.

`--simulate` does not build anything. It posts healthy samples for all five metrics. Use it when the Next.js app is not buildable.

Without `--simulate`, `--repo` must be a Next.js app that already has `node_modules`. The runner checks out `--branch` only when the worktree is clean and the branch exists locally, runs `npm run build`, then `npx next start`. It sends a few requests at `/` and `/api/health` and reports:

- `request_latency_p95_ms`, `error_rate`, and `request_count` from that traffic
- `category_spend` and `budget_calc_errors` as healthy synthetic companions (the preview app is not required to expose budget totals)

`--once` sends a single sample and exits. Otherwise it loops until SIGINT and stops the Next process on the way out.

## Metrics

| Metric | Healthy shape | Anomaly | Expected spike |
| --- | --- | --- | --- |
| `category_spend` | Month-to-date dollars, slow wobble | × 0.42 (1st-of-month expenses missing) | unchanged |
| `budget_calc_errors` | About 0–3 per interval | + 38 | unchanged |
| `error_rate` | Under 1% | + 2.1 percentage points (warn) | unchanged |
| `request_latency_p95_ms` | About 90–170 ms | unchanged | × 1.85 (warn) |
| `request_count` | About 40–90 per interval | unchanged | × 2.7 (warn) |

Baseline on an incident is the mean of the 5 minutes before the anomaly. The window field is `5m`.

## Layout

`src/server.ts` is the HTTP server. `src/app.ts` owns incidents, the generator, and outbound delivery. `src/store.ts` is the in-memory series. `public/` is the console: dark navigation, purple accent, time-range picker, env template variable, timeseries widgets, status pills, incident list, and event stream. The cat mark is original.

Data lives in memory and is rebuilt on restart.
