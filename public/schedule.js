import { makeShape, pointAt, toLonLat, toXY } from './geo.js';

function undelta(values, Type = Float64Array) {
  const out = new Type(values.length);
  let current = 0;
  for (let i = 0; i < values.length; i++) {
    current += values[i];
    out[i] = current;
  }
  return out;
}

/** Fetches a data file. A host may already have unpacked it, so this checks before unzipping. */
export async function loadGz(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = await res.arrayBuffer();
  const head = new Uint8Array(bytes, 0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) return JSON.parse(new TextDecoder().decode(bytes));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
}

export function decodeShapes(raw) {
  return raw.map((flat) => {
    const points = [];
    let lon = 0;
    let lat = 0;
    for (let i = 0; i < flat.length; i += 2) {
      lon += flat[i];
      lat += flat[i + 1];
      points.push(toXY(lon / 1e5, lat / 1e5));
    }
    return makeShape(points);
  });
}

export function decodeTimetable(raw) {
  const profiles = raw.profiles.map(([line, shape, headsign, halfSeconds, metres, stops, departures]) => ({
    line,
    shape,
    headsign: raw.headsigns[headsign],
    time: undelta(halfSeconds).map((t) => t / 2),
    dist: undelta(metres),
    stops: undelta(stops, Int32Array),
    dep: undelta(departures),
  }));
  const { first, serviceCount, patterns, dayPattern, origin } = raw.calendar;
  return {
    profiles,
    trips: {
      profile: undelta(raw.trips.profile, Int32Array),
      start: undelta(raw.trips.start, Int32Array),
      service: undelta(raw.trips.service, Int32Array),
    },
    calendar: {
      firstDay: dayNumber(first),
      serviceCount,
      patterns: patterns.map((p) => undelta(p, Int32Array)),
      dayPattern,
      origin: undelta(origin),
    },
  };
}

function dayNumber(ymd) {
  return Math.round(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) / 86400000);
}

export function shiftYmd(ymd, days) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + days));
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

const parisDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });

/** The service day a moment belongs to; it rolls over at 03:00, before the first buses. */
export function serviceDateOf(ms) {
  return parisDay.format(ms - 3 * 3600 * 1000).replaceAll('-', '');
}

/** The trips of one service day and the moment its timetable clock starts. */
export function dayOf(timetable, date) {
  const { calendar, trips } = timetable;
  const index = dayNumber(date) - calendar.firstDay;
  if (index < 0 || index >= calendar.dayPattern.length) return { date, origin: 0, trips: new Int32Array(0) };
  const running = new Uint8Array(calendar.serviceCount);
  for (const service of calendar.patterns[calendar.dayPattern[index]]) running[service] = 1;
  const ids = [];
  for (let i = 0; i < trips.service.length; i++) if (running[trips.service[i]]) ids.push(i);
  return { date, origin: calendar.origin[index] * 1000, trips: Int32Array.from(ids) };
}

/** Metres along the route at a time since the trip started, or null when it isn't running. */
export function distanceAt(time, dist, t) {
  const last = time.length - 1;
  if (last < 1 || t < time[0] || t > time[last]) return null;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (time[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = time[hi] - time[lo];
  return span > 0 ? dist[lo] + ((dist[hi] - dist[lo]) * (t - time[lo])) / span : dist[hi];
}

/** Every vehicle on the road at a moment, from the given service days. */
export function vehiclesAt(timetable, shapes, days, ms) {
  const vehicles = [];
  for (const day of days) {
    const seconds = (ms - day.origin) / 1000;
    for (const trip of day.trips) {
      const profile = timetable.profiles[timetable.trips.profile[trip]];
      const d = distanceAt(profile.time, profile.dist, seconds - timetable.trips.start[trip]);
      if (d === null) continue;
      const { x, y, bearing } = pointAt(shapes[profile.shape], d);
      const [lon, lat] = toLonLat(x, y);
      vehicles.push({ id: `${day.date}|${trip}`, profile, lon, lat, bearing: Math.round(bearing) });
    }
  }
  return vehicles;
}

/** The first moment after `after` that a wanted trip sets off, or null if none is loaded. */
export function nextDeparture(timetable, days, after, isWanted) {
  let best = null;
  for (const day of days) {
    for (const trip of day.trips) {
      const profile = timetable.profiles[timetable.trips.profile[trip]];
      if (profile.time.length < 2 || !isWanted(profile)) continue;
      const at = day.origin + timetable.trips.start[trip] * 1000;
      if (at > after && (best === null || at < best)) best = at;
    }
  }
  return best;
}
