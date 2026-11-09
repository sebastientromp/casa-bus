function undelta(values, Type) {
  const out = new Type(values.length);
  let current = 0;
  for (let i = 0; i < values.length; i++) {
    current += values[i];
    out[i] = current;
  }
  return out;
}

export function decodeVisits(raw) {
  return raw.map(([pieces, dists]) => ({ pieces: undelta(pieces, Int32Array), dists: undelta(dists, Float64Array) }));
}

export function decodeAreas(raw) {
  return raw.map(([stops, weights]) => ({ stops: undelta(stops, Int32Array), weights: Float64Array.from(weights, (w) => w / 1000) }));
}

/** The road pieces a profile crosses, with the seconds after departure at which it reaches each. */
export function passages(profile, visit) {
  const { time, dist } = profile;
  const n = dist.length;
  const pieces = [];
  const offsets = [];
  if (n < 2) return { pieces, offsets };
  let k = 0;
  for (let v = 0; v < visit.dists.length; v++) {
    const d = visit.dists[v];
    if (d < dist[0] || d > dist[n - 1]) continue;
    while (k < n - 2 && dist[k + 1] < d) k++;
    const span = dist[k + 1] - dist[k];
    const ratio = span > 0 ? (d - dist[k]) / span : 0;
    pieces.push(visit.pieces[v]);
    offsets.push(Math.round(time[k] + (time[k + 1] - time[k]) * ratio));
  }
  return { pieces, offsets };
}

/** Every road and stop passage of one service day, as flat arrays. */
export function buildDayEvents(timetable, visits, day, profileCache = new Map()) {
  const crossingsOf = (profile) => {
    if (!profileCache.has(profile)) profileCache.set(profile, passages(profile, visits[profile.shape]));
    return profileCache.get(profile);
  };
  const { profile: profileOf, start: startOf } = timetable.trips;
  let roadTotal = 0;
  let stopTotal = 0;
  for (const trip of day.trips) {
    const profile = timetable.profiles[profileOf[trip]];
    roadTotal += crossingsOf(profile).pieces.length;
    stopTotal += profile.stops.length;
  }
  const road = { piece: new Int32Array(roadTotal), time: new Int32Array(roadTotal), trip: new Int32Array(roadTotal) };
  const stop = { stop: new Int32Array(stopTotal), time: new Int32Array(stopTotal), trip: new Int32Array(stopTotal) };
  const lineOf = new Int32Array(day.trips.length);
  let ri = 0;
  let si = 0;
  day.trips.forEach((trip, position) => {
    const profile = timetable.profiles[profileOf[trip]];
    const start = startOf[trip];
    const { pieces, offsets } = crossingsOf(profile);
    lineOf[position] = profile.line;
    for (let v = 0; v < pieces.length; v++) {
      road.piece[ri] = pieces[v];
      road.time[ri] = start + offsets[v];
      road.trip[ri++] = position;
    }
    for (let i = 0; i < profile.stops.length; i++) {
      stop.stop[si] = profile.stops[i];
      stop.time[si] = start + profile.dep[i];
      stop.trip[si++] = position;
    }
  });
  return { road, stop, lineOf, origin: day.origin };
}

/** The range of timetable seconds a colour window covers at a moment. */
export function windowRange(window, seconds) {
  return { from: window === 'hour' ? seconds - 3600 : -Infinity, to: window === 'full' ? Infinity : seconds };
}

function counter(events, keys, size, lineOf, { from, to, lines }) {
  const counts = new Int32Array(size);
  const { time, trip } = events;
  for (let i = 0; i < time.length; i++) {
    if (time[i] < from || time[i] > to) continue;
    if (lines && !lines[lineOf[trip[i]]]) continue;
    counts[keys[i]]++;
  }
  return counts;
}

/** Passages per road piece and per area cell. `lines` flags the wanted lines, or null for all. */
export function score(events, areas, counts, options) {
  const roads = counter(events.road, events.road.piece, counts.pieces, events.lineOf, options);
  const stopCounts = counter(events.stop, events.stop.stop, counts.stops, events.lineOf, options);
  const areaScores = new Int32Array(areas.length);
  areas.forEach((area, a) => {
    let sum = 0;
    for (let i = 0; i < area.stops.length; i++) sum += stopCounts[area.stops[i]] * area.weights[i];
    areaScores[a] = Math.round(sum);
  });
  return { roads, areas: areaScores };
}

/** Which lines made the passages counted on one road piece. */
export function pieceDetail(events, pieceId, { from, to, lines }) {
  const { piece, time, trip } = events.road;
  const byLine = new Map();
  let total = 0;
  for (let i = 0; i < piece.length; i++) {
    if (piece[i] !== pieceId || time[i] < from || time[i] > to) continue;
    const line = events.lineOf[trip[i]];
    if (lines && !lines[line]) continue;
    byLine.set(line, (byLine.get(line) ?? 0) + 1);
    total++;
  }
  return { total, lines: [...byLine.entries()].sort((a, b) => b[1] - a[1]).map(([line, count]) => ({ line, count })) };
}
