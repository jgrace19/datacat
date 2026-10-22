export type Point = {
  t: number;
  v: number;
};

function keyOf(env: string, metric: string): string {
  return `${env}\0${metric}`;
}

function lowerBound(points: Point[], t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const point = points[mid];
    if (point && point.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function downsample(points: Point[], max: number): Point[] {
  if (max < 2 || points.length <= max) return points.slice();
  const bucket = Math.ceil(points.length / max);
  const out: Point[] = [];
  for (let i = 0; i < points.length; i += bucket) {
    const slice = points.slice(i, i + bucket);
    let sum = 0;
    for (const point of slice) sum += point.v;
    const last = slice[slice.length - 1];
    if (!last || slice.length === 0) continue;
    out.push({ t: last.t, v: sum / slice.length });
  }
  return out;
}

export class SeriesStore {
  private readonly series = new Map<string, Point[]>();

  constructor(private readonly maxPoints: number) {}

  append(env: string, metric: string, t: number, v: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(v)) {
      throw new Error("point t and v must be finite numbers");
    }
    const key = keyOf(env, metric);
    let points = this.series.get(key);
    if (!points) {
      points = [];
      this.series.set(key, points);
    }
    const last = points[points.length - 1];
    if (!last || t > last.t) {
      points.push({ t, v });
    } else if (t === last.t) {
      last.v = v;
    } else {
      const index = lowerBound(points, t);
      const existing = points[index];
      if (existing && existing.t === t) existing.v = v;
      else points.splice(index, 0, { t, v });
    }
    if (points.length > this.maxPoints) {
      points.splice(0, points.length - this.maxPoints);
    }
  }

  query(env: string, metric: string, from: number, to: number): Point[] {
    const points = this.series.get(keyOf(env, metric));
    if (!points || points.length === 0) return [];
    const start = lowerBound(points, from);
    const out: Point[] = [];
    for (let i = start; i < points.length; i += 1) {
      const point = points[i];
      if (!point || point.t > to) break;
      out.push({ t: point.t, v: point.v });
    }
    return out;
  }

  latest(env: string, metric: string): Point | undefined {
    const points = this.series.get(keyOf(env, metric));
    return points?.[points.length - 1];
  }

  envs(): string[] {
    const found = new Set<string>();
    for (const key of this.series.keys()) {
      const env = key.split("\0")[0];
      if (env) found.add(env);
    }
    return [...found];
  }
}
