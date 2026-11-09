import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { NETWORKS, currentServiceDate, serviceOrigin } from './gtfs.js';

const { transit_realtime: rt } = GtfsRealtimeBindings;
const STALE_AFTER_SECONDS = 300;
const POSITION_MAX_AGE_SECONDS = 120;
const MAX_BELIEVABLE_DELAY_SECONDS = 12 * 3600;
const WAITING = 'Waiting for the first update';
// Provence-Alpes-Côte d'Azur with a margin; anything outside is a bad coordinate.
const REGION = { south: 42.5, north: 45.5, west: 4, east: 8 };
const CANCELED = rt.TripDescriptor.ScheduleRelationship.CANCELED;

function eventDelay(event, scheduled, origin) {
  if (!event) return null;
  if (Object.hasOwn(event, 'delay')) return event.delay;
  if (Object.hasOwn(event, 'time') && origin !== null) {
    const delay = Math.round(Number(event.time) - origin / 1000 - scheduled);
    return Math.abs(delay) > MAX_BELIEVABLE_DELAY_SECONDS ? null : delay;
  }
  return null;
}

/** For feeds that send predicted times but no trip date: the service day of the first prediction. */
export function impliedServiceDate(stopTimeUpdates) {
  for (const u of stopTimeUpdates) {
    const time = Number(u.arrival?.time ?? 0) || Number(u.departure?.time ?? 0);
    if (time) return currentServiceDate(time * 1000);
  }
  return null;
}

/** Turns a decoded TripUpdate into arrival and departure delays for every stop of the trip. */
export function delaysForTrip(trip, stopTimeUpdates, serviceDate) {
  const n = trip.arr.length;
  const arrDelay = new Array(n).fill(null);
  const depDelay = new Array(n).fill(null);
  const origin = serviceDate ? serviceOrigin(serviceDate) : null;
  for (const u of stopTimeUpdates) {
    let i = -1;
    if (Object.hasOwn(u, 'stopSequence')) i = trip.seq.indexOf(u.stopSequence);
    if (i < 0 && u.stopId) i = trip.gtfsStops.indexOf(u.stopId);
    if (i < 0) continue;
    arrDelay[i] = eventDelay(u.arrival, trip.arr[i], origin);
    depDelay[i] = eventDelay(u.departure, trip.dep[i], origin);
    if (arrDelay[i] === null) arrDelay[i] = depDelay[i];
    if (depDelay[i] === null) depDelay[i] = arrDelay[i];
  }

  const first = arrDelay.findIndex((v) => v !== null);
  if (first < 0) return null;
  let carry = arrDelay[first];
  for (let i = 0; i < n; i++) {
    if (arrDelay[i] === null) arrDelay[i] = carry;
    if (depDelay[i] === null) depDelay[i] = arrDelay[i];
    carry = depDelay[i];
  }
  return {
    arrDelay: Int32Array.from(arrDelay),
    depDelay: Int32Array.from(depDelay),
    hasReal: arrDelay.some((v) => v !== 0) || depDelay.some((v) => v !== 0),
    cancelled: false,
  };
}

/** Turns a decoded VehiclePosition into a usable fix, or null if it can't be tied to a known trip and place. */
export function readVehicle(vehicle, netId, tripsByKey, feedTimeMs) {
  const tripId = vehicle.trip?.tripId;
  const position = vehicle.position;
  if (!tripId || !position) return null;
  const trip = tripsByKey.get(`${netId}:${tripId}`);
  if (!trip) return null;
  const { latitude: lat, longitude: lon } = position;
  if (!(lat > REGION.south && lat < REGION.north && lon > REGION.west && lon < REGION.east)) return null;
  return {
    key: `${trip.key}@${vehicle.trip.startDate || ''}`,
    lat,
    lon,
    bearing: Object.hasOwn(position, 'bearing') ? position.bearing : null,
    at: Number(vehicle.timestamp) * 1000 || feedTimeMs,
  };
}

function makeFeed(net, url) {
  return { net, url, feedTime: null, lastModified: null, ok: false, error: WAITING, entities: 0 };
}

/** Polls the GTFS-RT feeds and answers "what's the latest for this trip?". */
export function createRealtime(
  model,
  { override = process.env.RT_URL_OVERRIDE, vehiclesOverride = process.env.VEHICLES_URL_OVERRIDE, log = console.log } = {},
) {
  const tripsByKey = new Map(model.trips.map((t) => [t.key, t]));
  const feeds = new Map(
    NETWORKS.filter((n) => n.realtime).map((n) => [n.id, { ...makeFeed(n, override || n.realtime), updates: new Map() }]),
  );
  const vehicleFeeds = new Map(
    NETWORKS.filter((n) => n.vehicles).map((n) => [n.id, { ...makeFeed(n, vehiclesOverride || n.vehicles), fixes: new Map() }]),
  );

  async function pollOne(feed, kind, read) {
    try {
      const headers = { 'user-agent': 'valbonne-bus-map' };
      if (feed.lastModified && feed.ok) headers['if-modified-since'] = feed.lastModified;
      const res = await fetch(feed.url, { headers, signal: AbortSignal.timeout(25_000) });
      if (res.status === 304) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const message = rt.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
      feed.feedTime = Number(message.header.timestamp) * 1000 || Date.now();
      read(feed, message);
      feed.lastModified = res.headers.get('last-modified');
      feed.ok = true;
      feed.error = null;
    } catch (err) {
      if (feed.ok || feed.error === WAITING) log(`${feed.net.label} ${kind} feed failed: ${err.message}`);
      feed.ok = false;
      feed.error = err.message;
    }
  }

  function readTripUpdates(feed, message) {
    const updates = new Map();
    for (const entity of message.entity) {
      const tu = entity.tripUpdate;
      if (!tu?.trip?.tripId) continue;
      const trip = tripsByKey.get(`${feed.net.id}:${tu.trip.tripId}`);
      if (!trip) continue;
      const date = tu.trip.startDate || '';
      const key = `${trip.key}@${date}`;
      if (tu.trip.scheduleRelationship === CANCELED) {
        updates.set(key, { cancelled: true, hasReal: false });
        continue;
      }
      const stopUpdates = tu.stopTimeUpdate ?? [];
      const delays = delaysForTrip(trip, stopUpdates, date || impliedServiceDate(stopUpdates));
      if (delays) updates.set(key, delays);
    }
    feed.updates = updates;
    feed.entities = updates.size;
  }

  function readVehicles(feed, message) {
    const fixes = new Map();
    let received = 0;
    for (const entity of message.entity) {
      if (!entity.vehicle) continue;
      received++;
      const fix = readVehicle(entity.vehicle, feed.net.id, tripsByKey, feed.feedTime);
      if (fix && !(fixes.get(fix.key)?.at > fix.at)) fixes.set(fix.key, fix);
    }
    feed.fixes = fixes;
    feed.entities = fixes.size;
    feed.received = received;
  }

  const usable = (feed) =>
    feed.ok && feed.feedTime !== null && Date.now() - feed.feedTime < STALE_AFTER_SECONDS * 1000;

  return {
    poll: () =>
      Promise.all([
        ...[...feeds.values()].map((f) => pollOne(f, 'live', readTripUpdates)),
        ...[...vehicleFeeds.values()].map((f) => pollOne(f, 'position', readVehicles)),
      ]),
    lookup(trip, date) {
      const feed = feeds.get(trip.net);
      if (!feed || !usable(feed)) return null;
      return feed.updates.get(`${trip.key}@${date}`) ?? feed.updates.get(`${trip.key}@`) ?? null;
    },
    /** The latest reported position for this trip, if it's recent enough to trust. */
    position(trip, date) {
      const feed = vehicleFeeds.get(trip.net);
      if (!feed) return null;
      const fix = feed.fixes.get(`${trip.key}@${date}`) ?? feed.fixes.get(`${trip.key}@`);
      if (!fix || Date.now() - fix.at >= POSITION_MAX_AGE_SECONDS * 1000) return null;
      return fix;
    },
    status: () =>
      [...feeds.values()].map((f) => ({
        id: f.net.id,
        label: f.net.label,
        ok: usable(f),
        ageSeconds: f.feedTime ? Math.round((Date.now() - f.feedTime) / 1000) : null,
        trips: f.entities,
        error: f.error,
      })),
    positionStatus: () =>
      [...vehicleFeeds.values()].map((f) => ({
        id: f.net.id,
        label: f.net.label,
        ok: f.ok,
        received: f.received ?? 0,
        matched: f.entities,
        error: f.error,
      })),
  };
}
