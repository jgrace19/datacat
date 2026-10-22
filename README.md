# datacat

Local mock observability for a Cursor BDK anomaly-triage demo. It keeps time series in memory, draws a console for them, and pushes alerts to a bot. Nothing here calls a third-party metrics service.

The monitored service is **freshcart**, the grocery checkout in [jgrace19/marketplace](https://github.com/jgrace19/marketplace) (`demo/base`). `prod` is filled by a synthetic generator. A preview of that app reports into `preview-<pr>` through `POST /api/ingest`.

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
2. Click **Trigger anomaly**. GMV and average order value drop about 32% (AOV from about $34.83 to about $23.56). Orders stay at 4 and units stay at 28. A red banner names the incident. The incident row shows delivery:
   - **SKIPPED** when `BOT_ALIAS` is empty
   - **DELIVERED** with the HTTP status and response body when the bot accepts it
   - **FAILED** with the error, and a **Retry** control
3. Click **Trigger expected spike**. Orders, units, and GMV rise for a promo launch, and the charts get a **promo** annotation. AOV stays put. That path does not open an incident and does not POST an alert. The banner is amber.
4. Click **Resolve**. The affected window returns to the baseline and the incident moves to **RESOLVED**.
5. In another terminal, report a preview environment without building an app:

   ```bash
   ./scripts/preview-runner --pr 128 --simulate
   ```

   Choose `$env = preview-128`. Those series are healthy until you trigger an anomaly on that env. Ingested category spend is scaled while the anomaly is open, so a healthy runner still shows the drop.
6. On **Integrations**, set the bot alias if you did not put it in `.env`, turn **Snapshot push** on, or click **Push now**. The event stream records delivery changes.

Useful curls:

```bash
curl -s 'http://127.0.0.1:8787/api/query?metric=freshcart.checkout.average_order_value_cents&env=prod&from=0&to=9999999999999'
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
  "metric": "freshcart.checkout.average_order_value_cents",
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
| `X-Observability-Token` | `OBSERVABILITY_SHARED_SECRET` is non-empty. This is the shared secret `jgrace19/spike-detector` checks on `/alert` and `/metrics`. |
| `X-Datacat-Signature: sha256=<hex>` | Off unless `DATACAT_WEBHOOK_SECRET` is set. The header name is `DATACAT_HMAC_HEADER`. The hex is HMAC-SHA256 of the raw body. |

HMAC is off by default. Hosted bots reject `X-BDK-Session-Key` when the request is also HMAC-signed, so leave `DATACAT_WEBHOOK_SECRET` empty for spike-detector and send `X-Observability-Token` instead. The same headers are used for snapshot push, with `X-BDK-Session-Key: metrics:snapshot`.

A 2xx is stored as delivered and is not sent again for that `incidentId`. Non-2xx responses retry up to 8 times with the same id. Treat `incidentId` as the idempotency key. The incident row in the UI keeps the status code and response body.

A recovery uses that same URL, the same headers, and the same envelope, then adds the fields below. It is one POST, not the alert retry loop. `X-BDK-Session-Key` stays `incident:<incidentId>` so the event lands on the incident that opened.

```json
{
  "incidentId": "inc_…",
  "metric": "freshcart.checkout.average_order_value_cents",
  "env": "prod",
  "baseline": 3483,
  "value": 3470,
  "window": "5m",
  "status": "recovered",
  "gmv": { "value": 13880, "baseline": 13932, "previous": 9424 },
  "aov": { "value": 3470, "baseline": 3483, "previous": 2356 }
}
```

| Field | Meaning |
| --- | --- |
| `incidentId` | The anomaly incident id. It is not a new id. |
| `metric`, `env`, `baseline`, `value`, `window` | Same fields as the anomaly alert. `env` is `prod`. `baseline` and `value` are cents for `metric`. On recovery, `value` is the restored reading. |
| `status` | Always `recovered`. |
| `gmv.value`, `aov.value` | Current GMV and average order value, cents. |
| `gmv.baseline`, `aov.baseline` | Baselines, cents, from the 5 minutes before the drop. |
| `gmv.previous`, `aov.previous` | Readings from the anomaly, cents. |

`value`, `gmv.value`, and `aov.value` are all within 10% of their baselines. Datacat holds the POST until the climb has settled or those readings are inside that band, whichever comes first. `POST /api/push-recovery` uses the same body and returns 409 while the readings are still outside the band. It returns 400 when there is no anomaly incident, or when `env` is not `prod`.

If you do turn HMAC on, verify it with the raw body, not a re-serialized object:

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

The JSON body is `{ sentAt, snapshots, openIncidents }`. Each snapshot has `env`, `metric`, `unit`, `latest`, `baseline`, `status`, and up to 30 points from the last 5 minutes. Auth headers match the alert, including `X-Observability-Token` when `OBSERVABILITY_SHARED_SECRET` is set, with `X-BDK-Session-Key: metrics:snapshot`.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/query?metric&env&from&to` | Points in the window. `from` and `to` are epoch ms or ISO-8601. Defaults to the past hour. Optional `max` downsamples. |
| `POST` | `/api/ingest` | `{ "env": "preview-128", "source": "preview-runner", "points": [{ "metric", "v", "t"? }] }`. `prod` is rejected. A single `{ env, metric, v, t? }` body is also accepted. |
| `POST` | `/api/anomaly` | `{ "env": "prod", "metric": "freshcart.checkout.average_order_value_cents" }`. Opens one incident per open env+metric pair. |
| `POST` | `/api/resolve` | `{ "env": "prod", "incidentId": "optional" }`. Clears anomaly mode and an expected spike for that env. |
| `POST` | `/api/expected-spike` | `{ "env": "prod", "label": "promo launch" }`. Does not page. |
| `GET` | `/api/dashboard?env&range` | `range` is `15m`, `1h`, `4h`, or `1d`. |
| `POST` | `/api/settings` | `{ "botAlias", "pushEnabled", "pushIntervalMs" }`. The alias token, observability secret, and HMAC secret stay in the environment. |
| `POST` | `/api/push-now` | Send one snapshot. |
| `GET` | `/api/deploys` | Ship watcher status: last poll, handled heads, and each deploy. |
| `POST` | `/api/push-recovery` | `{ "env": "prod" }`. Send one recovery event once GMV and AOV are within 10% of baseline. |
| `POST` | `/api/incidents/:id/redeliver` | Retry a delivery that has not succeeded. |

`env` is `prod` or `preview-<name>` (letters, digits, `.`, `_`, `-`).

## Preview runner

```bash
./scripts/preview-runner --pr 128 --simulate
./scripts/preview-runner --pr 128 --repo ../marketplace --branch demo/base
./scripts/preview-runner --pr 128 --simulate --once --datacat http://127.0.0.1:8787
```

`--pr` is required and becomes the env name `preview-<pr>`.

`--simulate` does not start the app. It posts a healthy GreenMart basket (4 orders, 28 units, AOV about 3483 cents). Use it when the checkout cannot be installed.

Without `--simulate`, `--repo` must be a freshcart checkout: `backend/main.py`, `frontend/`, and `scripts/demo-checkout-metrics.py` (see `DEMO.md` on `demo/base`). The runner checks out `--branch` only when the worktree is clean and the branch exists locally, creates `backend/.venv` and installs requirements if uvicorn is missing, installs frontend dependencies if needed, and starts:

- `uvicorn main:app` on `--port` (default 8000), with `STRIPE_SECRET_KEY` removed so checkout stays mock
- `npm run dev` on `--frontend-port` (default 5173), with `VITE_API_BASE` pointed at the API

Each sample runs `scripts/demo-checkout-metrics.py --api <backend>` (the fixed 4-order GreenMart basket) and reports `GET /api/metrics` plus probed latency and error rate.

`--once` sends a single sample and exits. Otherwise it loops until SIGINT and stops both processes on the way out.

## Ship watcher

`npm run dev` and `npm start` poll GitHub every 5 seconds (`SHIP_WATCH_INTERVAL_MS`) with the local `gh` CLI. `npm run ship-watcher` starts the same server with the watcher forced on. The watch is `gh pr list` for open pull requests on `SHIP_REPO` (default `jgrace19/marketplace`) whose base is `SHIP_BASE` (default `demo/base`) and whose label is `SHIP_LABEL` (default `ship`).

Each new head is deployed with the pull request left open. In `MARKETPLACE_DIR` (default `~/cursor-dev/marketplace`) it runs `git fetch origin pull/<n>/head` and `git checkout --detach FETCH_HEAD`. It then restarts only the API, from `backend/`:

```bash
env -u STRIPE_SECRET_KEY nohup .venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8010 > /tmp/mp-backend.log 2>&1 &
```

The port is `MARKETPLACE_BACKEND_PORT` (default `8010`). Port `8000` is refused, so a preview runner is left alone. The Vite process is not restarted. The watcher waits until `http://127.0.0.1:<port>/api/health` returns 200.

On success it closes the `prod` incident the way **Resolve** does, draws a chart marker `Deploy: PR #<n>`, and lets GMV and average order value climb back over about 25 seconds. Orders and units stay flat. Once those readings are within 10% of baseline, or when the climb settles, datacat POSTs the recovery event described above. Handled `<pr>:<sha>` keys are stored in the temp file `datacat-ship-handled.json`, so a restart does not deploy the same head again. A failed deploy is retried on the next poll. `GET /api/deploys` returns the watcher status. Set `SHIP_WATCH_ENABLED=false` to keep polling off.

```bash
curl -s http://127.0.0.1:8787/api/deploys
curl -s -X POST http://127.0.0.1:8787/api/push-recovery -H 'content-type: application/json' -d '{"env":"prod"}'
```

## Metrics

| Metric | Healthy shape | Anomaly | Expected spike |
| --- | --- | --- | --- |
| `freshcart.checkout.orders` | 4 per interval | unchanged | × 2.4 (warn) |
| `freshcart.checkout.units` | 28 per interval (7 per order) | unchanged | × 2.4 (warn) |
| `freshcart.checkout.gmv_cents` | 4 × AOV, about 13932 cents | × 2356/3483, about 9424 cents | scales with orders |
| `freshcart.checkout.average_order_value_cents` | about 3483 cents ($34.83) | about 2356 cents ($23.56) | unchanged |
| `freshcart.http.error_rate` | Under 1% | unchanged | unchanged |
| `freshcart.http.latency_p95_ms` | About 90–170 ms | unchanged | × 1.45 (warn) |

The alert metric is average order value. The 32% gap is the marketplace baseline basket: bananas ×3, milk ×2, chicken ×1, and spinach ×1 are charged as four unit prices instead of unit price × quantity. `GET /api/metrics` on a preview of `demo/base` already returns the low AOV; a fixed branch returns about 3483.

Baseline on an incident is the mean of the 5 minutes before the anomaly. The window field is `5m`.

## Layout

`src/server.ts` is the HTTP server. `src/app.ts` owns incidents, the generator, and outbound delivery. `src/ship.ts` polls for pull requests and `src/deploy.ts` checks out a head and restarts the backend. `src/store.ts` is the in-memory series. `public/` is the freshcart console: dark navigation, purple accent, time-range picker, env template variable, timeseries widgets, status pills, incident list, and event stream. The cat mark is original.

Data lives in memory and is rebuilt on restart.
