import { nearestAlong, pointAt, slice, toLonLat, toXY } from './geo.js';
import { currentServiceDate, serviceOrigin, shiftDate, tripsOn } from './gtfs.js';

const TRAIL_SECONDS = 120;
// The browser glides each marker to its new position over one 5 s refresh, so the
// trail stops where the marker is when the data arrives.
const TRAIL_LAG_SECONDS = 5;
// Reported positions arrive every 30 s, and the browser glides between them.
const REPORTED_TRAIL_LAG_SECONDS = 30;
const MAX_TRAIL_GAP_METRES = 100;
// A bus can run at most 30% slower or faster than its timetable while catching up.
const MAX_DELAY_RATE = 0.3;
const DELAY_SNAP_SECONDS = 240;

/** Timetable shifted by per-stop delays, kept in non-decreasing order. */
export function effectiveTimes(trip, update) {
  const n = trip.arr.length;
  if (!update) return { arr: trip.arr, dep: trip.dep };
  const arr = new Int32Array(n);
  const dep = new Int32Array(n);
  let floor = -Infinity;
  for (let i = 0; i < n; i++) {
    arr[i] = Math.max(trip.arr[i] + update.arrDelay[i], floor);
    floor = arr[i];
    dep[i] = Math.max(trip.dep[i] + update.depDelay[i], floor);
    floor = dep[i];
  }
  return { arr, dep };
}

/** Distance along the shape at time t, or null when the trip isn't running. */
export function distanceAt(arr, dep, dist, t) {
  const last = arr.length - 1;
  if (t < dep[0] || t > arr[last]) return null;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) lo = mid;
    else hi = mid;
  }
  if (t <= dep[lo]) return dist[lo];
  const span = arr[hi] - dep[lo];
  if (span <= 0) return dist[hi];
  return dist[lo] + ((dist[hi] - dist[lo]) * (t - dep[lo])) / span;
}

/** Index of the first stop not yet reached at time t. */
export function nextStopIndex(arr, t) {
  for (let i = 0; i < arr.length; i++) if (arr[i] > t) return i;
  return arr.length - 1;
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

export function cruiseOf(trip) {
  trip.cruise ??= cruiseProfile(trip);
  return trip.cruise;
}

/**
 * Eases each bus towards its latest delay so a feed update changes its speed
 * instead of making it lurch or stop. Only very large corrections jump.
 */
export function createDelaySmoother({ maxRate = MAX_DELAY_RATE, snapSeconds = DELAY_SNAP_SECONDS } = {}) {
  const buses = new Map();
  return (id, target, nowMs) => {
    if (buses.size > 30000) buses.clear();
    const bus = buses.get(id);
    if (!bus || Math.abs(target - bus.delay) > snapSeconds) {
      buses.set(id, { delay: target, at: nowMs });
      return target;
    }
    const gap = target - bus.delay;
    const room = maxRate * Math.max(0, (nowMs - bus.at) / 1000);
    bus.delay += Math.sign(gap) * Math.min(Math.abs(gap), room);
    bus.at = nowMs;
    return bus.delay;
  };
}

function travelled(arr, dep, dist, t) {
  if (t < dep[0]) return dist[0];
  return distanceAt(arr, dep, dist, t) ?? dist[dist.length - 1];
}

/** The stretch of route a bus covered recently, ending behind `head` metres along the route. */
export function trailBehind(shape, arr, dep, dist, t, head, lag = TRAIL_LAG_SECONDS) {
  if (head === null) return null;
  const now = travelled(arr, dep, dist, t);
  const from = head - (now - travelled(arr, dep, dist, t - TRAIL_SECONDS - lag));
  const to = head - (now - travelled(arr, dep, dist, t - lag));
  if (to <= from) return null;
  return slice(shape, from, to).map(([x, y]) => toLonLat(x, y).map((v) => Math.round(v * 1e5) / 1e5));
}

/** Whether a trip's feed entry says anything beyond "exactly on time at every stop". */
function isLive(update) {
  return !!update && update.hasReal;
}

/** Computes every bus on the road at a moment. */
export function computeVehicles(model, realtime, nowMs, dayCache, smooth = (id, target) => target) {
  const today = currentServiceDate(nowMs);
  const vehicles = [];
  let cancelled = 0;
  for (const date of [shiftDate(today, -1), today, shiftDate(today, 1)]) {
    const origin = serviceOrigin(date);
    const t = (nowMs - origin) / 1000;
    if (t < -3600) continue;
    for (const trip of dayCache(date)) {
      const n = trip.arr.length;
      if (t < trip.dep[0] - 3600 || t > trip.arr[n - 1] + 7200) continue;
      const update = realtime.lookup(trip, date);
      if (update?.cancelled) {
        if (t >= trip.dep[0] && t <= trip.arr[n - 1]) cancelled++;
        continue;
      }
      const live = isLive(update);
      const { arr, dep } = effectiveTimes(trip, live ? update : null);
      const next = nextStopIndex(arr, t);
      const id = `${date}|${trip.key}`;
      const running = t - smooth(id, live ? update.arrDelay[next] : 0, nowMs);
      const cruise = cruiseOf(trip);
      const d = distanceAt(cruise.time, cruise.time, cruise.dist, running);
      const fix = realtime.position(trip, date);
      if (d === null && !fix) continue;
      const shape = model.shapes[trip.shape];
      let place;
      let head = d;
      if (fix) {
        const expected = d ?? (t < dep[0] ? trip.dist[0] : trip.dist[n - 1]);
        const { along, gap } = nearestAlong(shape, ...toXY(fix.lon, fix.lat), expected);
        head = gap <= MAX_TRAIL_GAP_METRES ? along : null;
        place = { lon: fix.lon, lat: fix.lat, bearing: fix.bearing ?? pointAt(shape, along).bearing };
      } else {
        const { x, y, bearing } = pointAt(shape, d);
        const [lon, lat] = toLonLat(x, y);
        place = { lon, lat, bearing };
      }
      const { lon, lat, bearing } = place;
      const line = model.lines[trip.line];
      vehicles.push({
        id,
        net: trip.net,
        line: line.key,
        short: line.short,
        color: line.color,
        text: line.text,
        headsign: trip.headsign,
        lon: Math.round(lon * 1e6) / 1e6,
        lat: Math.round(lat * 1e6) / 1e6,
        bearing: Math.round(bearing),
        status: fix ? 'reported' : live ? 'live' : 'scheduled',
        delay: live ? update.arrDelay[next] : null,
        age: fix ? Math.max(0, Math.round((nowMs - fix.at) / 1000)) : null,
        trail: fix || live ? trailBehind(shape, cruise.time, cruise.time, cruise.dist, running, head, fix ? REPORTED_TRAIL_LAG_SECONDS : TRAIL_LAG_SECONDS) : null,
      });
    }
  }
  return { vehicles, cancelled };
}

export function makeDayCache(model) {
  const cache = new Map();
  return (date) => {
    if (!cache.has(date)) {
      if (cache.size > 6) cache.delete(cache.keys().next().value);
      cache.set(date, tripsOn(model, date));
    }
    return cache.get(date);
  };
}
