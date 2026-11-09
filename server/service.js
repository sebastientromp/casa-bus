import { pointAt, slice, toLonLat } from './geo.js';
import { nextStopIndex } from './positions.js';
import { serviceOrigin, tripsOn } from './gtfs.js';

const STEP = 40;
const MATCH_RADIUS = 25;
const MATCH_ANGLE = 35;
const HEX_WIDTH = 250;
const CATCHMENT = 400;
export const CANCELLED_DELAY = 2 ** 31 - 1;

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
export function buildHexes(stops, { width = HEX_WIDTH, catchment = CATCHMENT } = {}) {
  const s = width / Math.sqrt(3);
  const center = (q, r) => [s * Math.sqrt(3) * (q + r / 2), s * 1.5 * r];
  const hexes = new Map();
  const reachR = Math.ceil(catchment / (s * 1.5)) + 1;
  const reachQ = Math.ceil(catchment / width) + 2;

  stops.forEach((stop, stopIndex) => {
    const r0 = Math.round(stop.y / (s * 1.5));
    const q0 = Math.round(stop.x / (s * Math.sqrt(3)) - r0 / 2);
    for (let r = r0 - reachR; r <= r0 + reachR; r++) {
      for (let q = q0 - reachQ - reachR; q <= q0 + reachQ + reachR; q++) {
        const [cx, cy] = center(q, r);
        const d = Math.hypot(cx - stop.x, cy - stop.y);
        if (d > catchment) continue;
        const key = `${q},${r}`;
        if (!hexes.has(key)) hexes.set(key, { x: cx, y: cy, stops: [], weights: [] });
        const hex = hexes.get(key);
        hex.stops.push(stopIndex);
        hex.weights.push(1 - (d / catchment) ** 2);
      }
    }
  });

  return [...hexes.values()].map((hex, id) => {
    const ring = [];
    for (let k = 0; k <= 6; k++) {
      const a = (Math.PI / 3) * k + Math.PI / 6;
      ring.push([hex.x + s * Math.cos(a), hex.y + s * Math.sin(a)]);
    }
    return { id, ring, stops: Int32Array.from(hex.stops), weights: Float64Array.from(hex.weights) };
  });
}

/** Timetable time at each distance, -1 where the trip doesn't cover that part of its shape. */
export function passageTimes(trip, dists) {
  const out = new Int32Array(dists.length);
  const n = trip.dist.length;
  let k = 0;
  for (let v = 0; v < dists.length; v++) {
    const d = dists[v];
    if (d < trip.dist[0] || d > trip.dist[n - 1]) {
      out[v] = -1;
      continue;
    }
    while (k < n - 2 && trip.dist[k + 1] < d) k++;
    const span = trip.dist[k + 1] - trip.dist[k];
    const ratio = span > 0 ? (d - trip.dist[k]) / span : 0;
    out[v] = Math.round(trip.dep[k] + (trip.arr[k + 1] - trip.dep[k]) * ratio);
  }
  return out;
}

/** Every road and stop passage of one service date, as flat arrays. */
export function buildDay(model, visits, date) {
  const trips = tripsOn(model, date);
  const roadTimes = [];
  let roadTotal = 0;
  let stopTotal = 0;
  for (const trip of trips) {
    const times = passageTimes(trip, visits[trip.shape].dists);
    roadTimes.push(times);
    for (const t of times) if (t >= 0) roadTotal++;
    stopTotal += trip.arr.length;
  }
  const road = { piece: new Int32Array(roadTotal), time: new Int32Array(roadTotal), trip: new Int32Array(roadTotal) };
  const stop = { stop: new Int32Array(stopTotal), time: new Int32Array(stopTotal), trip: new Int32Array(stopTotal) };
  let ri = 0;
  let si = 0;
  trips.forEach((trip, tripPos) => {
    const times = roadTimes[tripPos];
    const pieces = visits[trip.shape].pieces;
    for (let v = 0; v < times.length; v++) {
      if (times[v] < 0) continue;
      road.piece[ri] = pieces[v];
      road.time[ri] = times[v];
      road.trip[ri] = tripPos;
      ri++;
    }
    for (let i = 0; i < trip.arr.length; i++) {
      stop.stop[si] = trip.stops[i];
      stop.time[si] = trip.dep[i];
      stop.trip[si] = tripPos;
      si++;
    }
  });
  return { date, origin: serviceOrigin(date), trips, road, stop };
}

/** Current whole-trip delay for each trip of the day; cancelled trips get a sentinel. */
export function currentDelays(day, realtime, t) {
  const delays = new Int32Array(day.trips.length);
  day.trips.forEach((trip, pos) => {
    const update = realtime.lookup(trip, day.date);
    if (!update) return;
    if (update.cancelled) delays[pos] = CANCELLED_DELAY;
    else if (update.hasReal) delays[pos] = update.arrDelay[nextStopIndex(trip.arr, t)];
  });
  return delays;
}

function counter(events, keyField, size, { from, to, lines, delays, trips }) {
  const counts = new Int32Array(size);
  const n = events.time.length;
  const keys = events[keyField];
  for (let i = 0; i < n; i++) {
    const pos = events.trip[i];
    const delay = delays[pos];
    if (delay === CANCELLED_DELAY) continue;
    const t = events.time[i] + delay;
    if (t < from || t > to) continue;
    if (lines && !lines.has(trips[pos].line)) continue;
    counts[keys[i]]++;
  }
  return counts;
}

/** Passages per road piece and per hexagon within a time range. */
export function score(model, day, hexes, pieceCount, options) {
  const opts = { ...options, trips: day.trips };
  const roads = counter(day.road, 'piece', pieceCount, opts);
  const stopCounts = counter(day.stop, 'stop', model.stops.length, opts);
  const areas = new Int32Array(hexes.length);
  hexes.forEach((hex, h) => {
    let sum = 0;
    for (let i = 0; i < hex.stops.length; i++) sum += stopCounts[hex.stops[i]] * hex.weights[i];
    areas[h] = Math.round(sum);
  });
  return { roads, areas };
}

/** Which lines made the passages counted on one road piece. */
export function pieceDetail(model, day, pieceId, options) {
  const { from, to, lines, delays } = options;
  const byLine = new Map();
  let total = 0;
  for (let i = 0; i < day.road.piece.length; i++) {
    if (day.road.piece[i] !== pieceId) continue;
    const pos = day.road.trip[i];
    if (delays[pos] === CANCELLED_DELAY) continue;
    const t = day.road.time[i] + delays[pos];
    if (t < from || t > to) continue;
    const line = day.trips[pos].line;
    if (lines && !lines.has(line)) continue;
    byLine.set(line, (byLine.get(line) ?? 0) + 1);
    total++;
  }
  return {
    total,
    lines: [...byLine.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([line, count]) => ({
        short: model.lines[line].short,
        net: model.lines[line].net,
        color: model.lines[line].color,
        text: model.lines[line].text,
        count,
      })),
  };
}

const round = ([x, y]) => {
  const [lon, lat] = toLonLat(x, y);
  return [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
};

export function piecesGeoJson(pieces) {
  return {
    type: 'FeatureCollection',
    features: pieces.map((p) => ({
      type: 'Feature',
      id: p.id,
      properties: {},
      geometry: { type: 'LineString', coordinates: p.line.map(round) },
    })),
  };
}

export function hexesGeoJson(hexes) {
  return {
    type: 'FeatureCollection',
    features: hexes.map((h) => ({
      type: 'Feature',
      id: h.id,
      properties: {},
      geometry: { type: 'Polygon', coordinates: [h.ring.map(round)] },
    })),
  };
}
