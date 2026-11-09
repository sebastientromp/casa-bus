import { HEX_WIDTH, hexCenter, pointAt, slice } from '../public/geo.js';

const STEP = 40;
const MATCH_RADIUS = 25;
const MATCH_ANGLE = 35;
const CATCHMENT = 400;

function angleGap(a, b) {
  const d = Math.abs(a - b) % 180;
  return Math.min(d, 180 - d);
}

/**
 * Cuts shapes into road pieces. Walking each shape every STEP metres, a sample
 * reuses an existing piece if one lies within MATCH_RADIUS on a similar heading
 * (either direction), otherwise it founds a new one. Because samples look up
 * nearby pieces rather than computing a key, lines sharing a road land on the
 * same pieces even when their vertices differ.
 */
export function buildPieces(shapes, { step = STEP, radius = MATCH_RADIUS, angle = MATCH_ANGLE } = {}) {
  const pieces = [];
  const grid = new Map();
  const size = radius * 2;
  const cellKey = (i, j) => `${i},${j}`;

  const visits = shapes.map((shape) => {
    if (shape.synthetic) return { pieces: new Int32Array(0), dists: new Float64Array(0) };
    const pieceIds = [];
    const dists = [];
    for (let d = step / 2; d < shape.length; d += step) {
      const { x, y } = pointAt(shape, d);
      const before = pointAt(shape, d - step / 2);
      const after = pointAt(shape, d + step / 2);
      const bearing = ((Math.atan2(after.x - before.x, after.y - before.y) * 180) / Math.PI + 360) % 360;
      const ci = Math.floor(x / size);
      const cj = Math.floor(y / size);

      let match = null;
      let best = radius;
      for (let i = ci - 1; i <= ci + 1; i++) {
        for (let j = cj - 1; j <= cj + 1; j++) {
          for (const p of grid.get(cellKey(i, j)) ?? []) {
            const gap = Math.hypot(p.x - x, p.y - y);
            if (gap <= best && angleGap(p.bearing, bearing) <= angle) {
              best = gap;
              match = p;
            }
          }
        }
      }
      if (!match) {
        match = {
          id: pieces.length,
          x,
          y,
          bearing,
          line: slice(shape, d - step / 2 - 1, d + step / 2 + 1),
        };
        pieces.push(match);
        const key = cellKey(ci, cj);
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(match);
      }
      if (pieceIds[pieceIds.length - 1] !== match.id) {
        pieceIds.push(match.id);
        dists.push(d);
      }
    }
    return { pieces: Int32Array.from(pieceIds), dists: Float64Array.from(dists) };
  });
  return { pieces, visits };
}

/** Hexagons around stops, each listing nearby stops with a weight that fades with distance. */
export function buildHexes(stops, { catchment = CATCHMENT } = {}) {
  const s = HEX_WIDTH / Math.sqrt(3);
  const hexes = new Map();
  const reachR = Math.ceil(catchment / (s * 1.5)) + 1;
  const reachQ = Math.ceil(catchment / HEX_WIDTH) + 2;

  stops.forEach((stop, stopIndex) => {
    const r0 = Math.round(stop.y / (s * 1.5));
    const q0 = Math.round(stop.x / (s * Math.sqrt(3)) - r0 / 2);
    for (let r = r0 - reachR; r <= r0 + reachR; r++) {
      for (let q = q0 - reachQ - reachR; q <= q0 + reachQ + reachR; q++) {
        const [cx, cy] = hexCenter(q, r);
        const d = Math.hypot(cx - stop.x, cy - stop.y);
        if (d > catchment) continue;
        const key = `${q},${r}`;
        if (!hexes.has(key)) hexes.set(key, { q, r, stops: [], weights: [] });
        const hex = hexes.get(key);
        hex.stops.push(stopIndex);
        hex.weights.push(1 - (d / catchment) ** 2);
      }
    }
  });

  return [...hexes.values()].map((hex, id) => ({
    id,
    q: hex.q,
    r: hex.r,
    stops: Int32Array.from(hex.stops),
    weights: Float64Array.from(hex.weights),
  }));
}

/**
 * The trip as one continuous run for drawing. Timetables round to the minute and
 * add dwell at some stops, which would make a bus jump and then wait, so each
 * stop becomes a single moment and stops sharing a moment merge into one point.
 */
export function cruiseProfile(trip) {
  const n = trip.arr.length;
  const moments = [];
  for (let i = 0; i < n; i++) {
    const m = i === 0 ? trip.dep[0] : i === n - 1 ? trip.arr[n - 1] : (trip.arr[i] + trip.dep[i]) / 2;
    moments.push(Math.max(m, moments[i - 1] ?? -Infinity));
  }
  const time = [];
  const dist = [];
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && moments[j + 1] === moments[i]) j++;
    let d = (trip.dist[i] + trip.dist[j]) / 2;
    if (i === 0) d = trip.dist[0];
    if (j === n - 1) d = trip.dist[n - 1];
    time.push(moments[i]);
    dist.push(d);
    i = j + 1;
  }
  return { time: Float64Array.from(time), dist: Float64Array.from(dist) };
}
