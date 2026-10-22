import assert from "node:assert/strict";
import test from "node:test";
import { SeriesStore, downsample } from "../src/store.ts";

test("store keeps order, replaces a duplicate timestamp, and queries a window", () => {
  const store = new SeriesStore(10);
  store.append("prod", "category_spend", 3_000, 3);
  store.append("prod", "category_spend", 1_000, 1);
  store.append("prod", "category_spend", 2_000, 2);
  store.append("prod", "category_spend", 2_000, 2.5);
  assert.deepEqual(store.query("prod", "category_spend", 1_000, 2_500), [
    { t: 1_000, v: 1 },
    { t: 2_000, v: 2.5 },
  ]);
  assert.deepEqual(store.latest("prod", "category_spend"), { t: 3_000, v: 3 });
  assert.deepEqual(store.envs(), ["prod"]);
});

test("store trims to the newest points", () => {
  const store = new SeriesStore(3);
  for (let i = 1; i <= 5; i += 1) store.append("preview-1", "error_rate", i, i);
  assert.deepEqual(
    store.query("preview-1", "error_rate", 0, 10).map((point) => point.t),
    [3, 4, 5],
  );
});

test("downsample averages buckets and keeps the short series intact", () => {
  const points = [
    { t: 1, v: 1 },
    { t: 2, v: 3 },
    { t: 3, v: 5 },
    { t: 4, v: 7 },
  ];
  assert.equal(downsample(points, 10).length, 4);
  const compact = downsample(points, 2);
  assert.equal(compact.length, 2);
  assert.equal(compact[0]?.v, 2);
  assert.equal(compact[1]?.v, 6);
});
