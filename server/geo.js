// Flat-earth projection in metres, accurate enough at the scale of the Alpes-Maritimes.
const LAT0 = 43.62;
const LON0 = 7.0;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110574;

export const toXY = (lon, lat) => [(lon - LON0) * KX, (lat - LAT0) * KY];
export const toLonLat = (x, y) => [x / KX + LON0, y / KY + LAT0];

/** Builds a polyline with cumulative distance from [[x, y], ...]. */
export function makeShape(points) {
  const clean = points.filter(
    (p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1],
  );
  const n = clean.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const cum = new Float64Array(n);
  clean.forEach(([x, y], i) => {
    xs[i] = x;
    ys[i] = y;
    if (i > 0) cum[i] = cum[i - 1] + Math.hypot(x - xs[i - 1], y - ys[i - 1]);
  });
  return { xs, ys, cum, length: n ? cum[n - 1] : 0 };
}

function segmentIndex(shape, d) {
  let lo = 0;
  let hi = shape.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (shape.cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Position and compass bearing (degrees) at distance d along the shape. */
export function pointAt(shape, d) {
  const { xs, ys, cum } = shape;
  if (xs.length === 1) return { x: xs[0], y: ys[0], bearing: 0 };
  const clamped = Math.min(Math.max(d, 0), shape.length);
  const i = segmentIndex(shape, clamped);
  const span = cum[i + 1] - cum[i] || 1;
  const r = (clamped - cum[i]) / span;
  const dx = xs[i + 1] - xs[i];
  const dy = ys[i + 1] - ys[i];
  return {
    x: xs[i] + dx * r,
    y: ys[i] + dy * r,
    bearing: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360,
  };
}

/** The part of the shape between two distances, as [[x, y], ...]. */
export function slice(shape, d0, d1) {
  const a = Math.max(d0, 0);
  const b = Math.min(d1, shape.length);
  const start = pointAt(shape, a);
  const out = [[start.x, start.y]];
  for (let i = segmentIndex(shape, a) + 1; i < shape.cum.length && shape.cum[i] < b; i++) {
    if (shape.cum[i] > a) out.push([shape.xs[i], shape.ys[i]]);
  }
  const end = pointAt(shape, b);
  out.push([end.x, end.y]);
  return out;
}

function projectOnSegment(shape, j, x, y) {
  const ax = shape.xs[j];
  const ay = shape.ys[j];
  const dx = shape.xs[j + 1] - ax;
  const dy = shape.ys[j + 1] - ay;
  const len2 = dx * dx + dy * dy || 1;
  const r = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2));
  return { r, dist: Math.hypot(x - ax - dx * r, y - ay - dy * r) };
}

/** Nearest place on the route to (x, y), favouring the pass closest to `expected` metres along a route that doubles back. */
export function nearestAlong(shape, x, y, expected) {
  let best = { along: 0, gap: Infinity };
  let bestScore = Infinity;
  for (let j = 0; j < shape.xs.length - 1; j++) {
    const { r, dist } = projectOnSegment(shape, j, x, y);
    const along = shape.cum[j] + (shape.cum[j + 1] - shape.cum[j]) * r;
    const score = dist + Math.abs(along - expected) * 0.02;
    if (score < bestScore) {
      bestScore = score;
      best = { along, gap: dist };
    }
  }
  return best;
}

/**
 * Places an ordered list of stops along a shape. Dynamic programming finds the
 * in-order assignment closest to the line overall, so a route that loops or
 * doubles back past the same road doesn't send a stop to the wrong pass.
 */
export function projectStops(shape, stops) {
  const nSeg = shape.xs.length - 1;
  const n = stops.length;
  const result = new Float64Array(n);
  if (nSeg < 1 || n === 0) return result;

  const back = new Int32Array(n * nSeg);
  let prev = new Float64Array(nSeg);
  let cur = new Float64Array(nSeg);
  for (let i = 0; i < n; i++) {
    const [x, y] = stops[i];
    let bestPrev = Infinity;
    let bestJ = -1;
    for (let j = 0; j < nSeg; j++) {
      if (i > 0 && prev[j] < bestPrev) {
        bestPrev = prev[j];
        bestJ = j;
      }
      cur[j] = (i > 0 ? bestPrev : 0) + projectOnSegment(shape, j, x, y).dist;
      back[i * nSeg + j] = bestJ;
    }
    [prev, cur] = [cur, prev];
  }

  let j = 0;
  for (let k = 1; k < nSeg; k++) if (prev[k] < prev[j]) j = k;
  for (let i = n - 1; i >= 0; i--) {
    const { r } = projectOnSegment(shape, j, stops[i][0], stops[i][1]);
    result[i] = shape.cum[j] + (shape.cum[j + 1] - shape.cum[j]) * r;
    j = back[i * nSeg + j];
  }
  for (let i = 1; i < n; i++) result[i] = Math.max(result[i], result[i - 1]);
  return result;
}
