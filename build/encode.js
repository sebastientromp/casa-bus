import { toLonLat } from '../public/geo.js';
import { isServiceActive, serviceOrigin, shiftDate } from './gtfs.js';
import { cruiseProfile } from './network.js';

// Everything is stored as differences between neighbouring whole numbers,
// which keeps the files small once gzipped.

export function delta(values) {
  let previous = 0;
  return Array.from(values, (v) => {
    const d = v - previous;
    previous = v;
    return d;
  });
}

const fixed = (degrees) => Math.round(degrees * 1e5);

export function encodeShapes(shapes) {
  return shapes.map((shape) => {
    const flat = [];
    let px = 0;
    let py = 0;
    for (let i = 0; i < shape.xs.length; i++) {
      const [lon, lat] = toLonLat(shape.xs[i], shape.ys[i]);
      flat.push(fixed(lon) - px, fixed(lat) - py);
      px = fixed(lon);
      py = fixed(lat);
    }
    return flat;
  });
}

/** Road pieces and area cells for drawing. Differences run on from one feature to the next. */
export function encodeMap(pieces, hexes) {
  let px = 0;
  let py = 0;
  const roads = pieces.map((piece) =>
    piece.line.flatMap(([x, y]) => {
      const [lon, lat] = toLonLat(x, y);
      const step = [fixed(lon) - px, fixed(lat) - py];
      px = fixed(lon);
      py = fixed(lat);
      return step;
    }),
  );
  return { roads, areas: { q: delta(hexes.map((h) => h.q)), r: delta(hexes.map((h) => h.r)) } };
}

export function encodeVisits(visits) {
  return visits.map((v) => [delta(v.pieces), delta(Array.from(v.dists, Math.round))]);
}

export function encodeAreas(hexes) {
  return hexes.map((h) => [delta(h.stops), Array.from(h.weights, (w) => Math.round(w * 1000))]);
}

/**
 * Trips that share a line, route, destination and rhythm become one profile,
 * so most trips shrink to just a profile number and a start time.
 */
export function encodeTimetable(model, { from, to }) {
  const headsigns = [];
  const headsignIndex = new Map();
  const services = [];
  const serviceIndex = new Map();
  const profiles = [];
  const profileIndex = new Map();
  const rows = [];

  for (const trip of model.trips) {
    if (!headsignIndex.has(trip.headsign)) {
      headsignIndex.set(trip.headsign, headsigns.length);
      headsigns.push(trip.headsign);
    }
    const serviceKey = `${trip.net}\n${trip.serviceId}`;
    if (!serviceIndex.has(serviceKey)) {
      serviceIndex.set(serviceKey, services.length);
      services.push({ net: trip.net, id: trip.serviceId });
    }
    const cruise = cruiseProfile(trip);
    const start = cruise.time[0];
    const halfSeconds = Array.from(cruise.time, (t) => Math.round((t - start) * 2));
    const metres = Array.from(cruise.dist, Math.round);
    const stops = Array.from(trip.stops);
    const departures = Array.from(trip.dep, (t) => t - start);
    const headsign = headsignIndex.get(trip.headsign);
    const key = [trip.line, trip.shape, headsign, halfSeconds, metres, stops, departures].join('|');
    if (!profileIndex.has(key)) {
      profileIndex.set(key, profiles.length);
      profiles.push([trip.line, trip.shape, headsign, delta(halfSeconds), delta(metres), delta(stops), delta(departures)]);
    }
    rows.push({ profile: profileIndex.get(key), start, service: serviceIndex.get(serviceKey) });
  }
  rows.sort((a, b) => a.profile - b.profile || a.start - b.start);

  const patterns = [];
  const patternIndex = new Map();
  const dayPattern = [];
  const origins = [];
  for (let date = from; date <= to; date = shiftDate(date, 1)) {
    const active = [];
    services.forEach((s, i) => {
      if (isServiceActive(model.calendars.get(s.net), s.id, date)) active.push(i);
    });
    const key = active.join(',');
    if (!patternIndex.has(key)) {
      patternIndex.set(key, patterns.length);
      patterns.push(delta(active));
    }
    dayPattern.push(patternIndex.get(key));
    origins.push(serviceOrigin(date) / 1000);
  }

  return {
    headsigns,
    profiles,
    trips: {
      profile: delta(rows.map((r) => r.profile)),
      start: delta(rows.map((r) => r.start)),
      service: delta(rows.map((r) => r.service)),
    },
    calendar: { first: from, serviceCount: services.length, patterns, dayPattern, origin: delta(origins) },
  };
}
