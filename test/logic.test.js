import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { makeShape, pointAt, projectStops, toLonLat, toXY } from '../server/geo.js';
import {
  currentServiceDate,
  fillMissingTimes,
  inAlpesMaritimes,
  isShownRoute,
  isServiceActive,
  parseCsv,
  parseTime,
  serviceOrigin,
} from '../server/gtfs.js';
import { computeVehicles, createDelaySmoother, cruiseProfile, distanceAt, effectiveTimes } from '../server/positions.js';
import { createRealtime, delaysForTrip, impliedServiceDate, readVehicle } from '../server/realtime.js';
import { buildDay, buildHexes, buildPieces, CANCELLED_DELAY, passageTimes, score } from '../server/service.js';

import { deflateRawSync } from 'node:zlib';
import { nextDeparture } from '../public/replay.js';
import { readZip } from '../server/zip.js';

const { transit_realtime } = GtfsRealtimeBindings;
const straight = (length, y = 0) => makeShape([[0, y], [length, y]]);

function makeTrip(overrides) {
  return {
    net: 'n',
    serviceId: 's',
    line: 0,
    shape: 0,
    arr: Int32Array.from([1000, 1200]),
    dep: Int32Array.from([1000, 1200]),
    dist: Float64Array.from([0, 1000]),
    stops: Int32Array.from([0, 1]),
    seq: Int32Array.from([1, 2]),
    gtfsStops: ['a', 'b'],
    ...overrides,
  };
}

test('parseCsv handles BOM, quotes, CRLF and blank lines', () => {
  const rows = parseCsv('﻿a,b\r\n1,"x, ""y"""\r\n\r\n2,z\r\n');
  assert.deepEqual(rows, [{ a: '1', b: 'x, "y"' }, { a: '2', b: 'z' }]);
});

test('parseTime accepts times past midnight', () => {
  assert.equal(parseTime('25:10:30'), 25 * 3600 + 630);
  assert.equal(parseTime(''), null);
});

test('calendar honours weekdays, date range and exceptions', () => {
  const calendar = {
    rules: new Map([['s', { days: [false, true, false, false, false, false, false], start: '20261101', end: '20261130' }]]),
    exceptions: new Map([['s:20261116', 2], ['s:20261117', 1]]),
  };
  assert.equal(isServiceActive(calendar, 's', '20261109'), true, 'a Monday in range');
  assert.equal(isServiceActive(calendar, 's', '20261110'), false, 'a Tuesday');
  assert.equal(isServiceActive(calendar, 's', '20261116'), false, 'Monday removed by exception');
  assert.equal(isServiceActive(calendar, 's', '20261117'), true, 'Tuesday added by exception');
  assert.equal(isServiceActive(calendar, 's', '20261207'), false, 'Monday past the end date');
});

test('service day rolls over at 03:00 Paris time', () => {
  assert.equal(currentServiceDate(Date.UTC(2026, 10, 10, 1, 30)), '20261109', '02:30 local is still the previous day');
  assert.equal(currentServiceDate(Date.UTC(2026, 10, 10, 2, 30)), '20261110', '03:30 local is the new day');
});

test('serviceOrigin is local midnight on normal days and noon minus 12 h on DST days', () => {
  assert.equal(serviceOrigin('20261109'), Date.UTC(2026, 10, 8, 23));
  assert.equal(serviceOrigin('20260329'), Date.UTC(2026, 2, 29, 10) - 12 * 3600 * 1000, 'spring change');
});

test('fillMissingTimes interpolates by distance', () => {
  assert.deepEqual(fillMissingTimes([100, null, 300], [0, 750, 1000]), [100, 250, 300]);
});

test('projectStops keeps stops in order on a route that doubles back', () => {
  const shape = makeShape([[0, 0], [1000, 0], [1000, 20], [0, 20]]);
  const dist = projectStops(shape, [[100, 0], [900, 0], [900, 20], [100, 20]]);
  assert.ok(Math.abs(dist[0] - 100) < 1);
  assert.ok(Math.abs(dist[1] - 900) < 1);
  assert.ok(Math.abs(dist[2] - 1120) < 1, 'third stop is on the way back');
  assert.ok(Math.abs(dist[3] - 1920) < 1);
});

test('distanceAt interpolates, dwells at stops, and is null off-trip', () => {
  const arr = Int32Array.from([100, 200, 400]);
  const dep = Int32Array.from([100, 250, 400]);
  const dist = Float64Array.from([0, 500, 1500]);
  assert.equal(distanceAt(arr, dep, dist, 150), 250);
  assert.equal(distanceAt(arr, dep, dist, 225), 500, 'waiting at the stop');
  assert.equal(distanceAt(arr, dep, dist, 325), 1000);
  assert.equal(distanceAt(arr, dep, dist, 99), null);
  assert.equal(distanceAt(arr, dep, dist, 401), null);
});

test('effectiveTimes applies delays and never runs time backwards', () => {
  const trip = makeTrip({ arr: Int32Array.from([100, 200, 300]), dep: Int32Array.from([100, 200, 300]) });
  const update = { arrDelay: Int32Array.from([50, -80, 0]), depDelay: Int32Array.from([50, -80, 0]) };
  const { arr, dep } = effectiveTimes(trip, update);
  assert.deepEqual([...arr], [150, 150, 300]);
  assert.deepEqual([...dep], [150, 150, 300]);
});

test('delaysForTrip carries the last known delay forward, matching by sequence or stop id', () => {
  const trip = makeTrip({
    arr: Int32Array.from([100, 200, 300, 400]),
    dep: Int32Array.from([100, 200, 300, 400]),
    seq: Int32Array.from([1, 2, 3, 4]),
    gtfsStops: ['a', 'b', 'c', 'd'],
  });
  const result = delaysForTrip(trip, [{ stopSequence: 2, arrival: { delay: 60 } }, { stopId: 'c', departure: { delay: 120 } }], null);
  assert.deepEqual([...result.arrDelay], [60, 60, 120, 120]);
  assert.equal(result.hasReal, true);
});

test('delaysForTrip treats explicit zeros as known but not live evidence', () => {
  const trip = makeTrip({});
  const result = delaysForTrip(trip, [{ stopSequence: 1, arrival: { delay: 0 } }], null);
  assert.equal(result.hasReal, false);
});

test('a feed with predicted times but no date still gives delays', () => {
  const origin = serviceOrigin('20261109') / 1000;
  const updates = [{ stopSequence: 1, departure: { time: origin + 36060 } }, { stopSequence: 2, arrival: { time: origin + 36290 } }];
  const date = impliedServiceDate(updates);
  assert.equal(date, '20261109');
  const morning = { arr: Int32Array.from([36000, 36200]), dep: Int32Array.from([36000, 36200]) };
  const result = delaysForTrip(makeTrip(morning), updates, date);
  assert.deepEqual([...result.depDelay], [60, 90]);
  assert.equal(result.hasReal, true);
});

test('impliedServiceDate needs a predicted time', () => {
  assert.equal(impliedServiceDate([{ stopSequence: 1, arrival: { delay: 60 } }]), null);
});

test('a predicted time a day away is ignored', () => {
  const origin = serviceOrigin('20261109') / 1000;
  const result = delaysForTrip(makeTrip({}), [{ stopSequence: 1, arrival: { time: origin + 1000 + 86400 } }], '20261109');
  assert.equal(result, null);
});

test('delaysForTrip returns null when no update matches the trip', () => {
  assert.equal(delaysForTrip(makeTrip({}), [{ stopSequence: 99, arrival: { delay: 10 } }], null), null);
});

const VALBONNE = { latitude: 43.64, longitude: 7.0 };

test('readVehicle needs a known trip and a believable place', () => {
  const trips = new Map([['n:T', makeTrip({ key: 'n:T' })]]);
  const read = (v) => readVehicle(v, 'n', trips, 5000);
  assert.equal(read({ trip: { tripId: 'nope' }, position: VALBONNE }), null);
  assert.equal(read({ trip: { tripId: 'T' } }), null);
  assert.equal(read({ trip: { tripId: 'T' }, position: { latitude: 0, longitude: 0 } }), null);
  assert.deepEqual(read({ trip: { tripId: 'T', startDate: '20261109' }, position: VALBONNE, timestamp: 7 }), {
    key: 'n:T@20261109',
    lat: 43.64,
    lon: 7,
    bearing: null,
    at: 7000,
  });
  assert.equal(read({ trip: { tripId: 'T' }, position: VALBONNE }).at, 5000, 'falls back to the feed time');
});

test('createRealtime decodes vehicle positions and ignores stale ones', async () => {
  const nowS = Math.floor(Date.now() / 1000);
  const entity = (id, timestamp) => ({
    id,
    vehicle: { trip: { tripId: id, startDate: '20261109' }, position: VALBONNE, timestamp },
  });
  const body = transit_realtime.FeedMessage.encode({
    header: { gtfsRealtimeVersion: '2.0', timestamp: nowS },
    entity: [entity('fresh', nowS - 10), entity('old', nowS - 600)],
  }).finish();
  const server = createServer((req, res) => res.end(body));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const fresh = makeTrip({ key: 'zou-prox:fresh', net: 'zou-prox' });
    const old = makeTrip({ key: 'zou-prox:old', net: 'zou-prox' });
    const realtime = createRealtime({ trips: [fresh, old] }, { override: url, vehiclesOverride: url, log: () => {} });
    await realtime.poll();
    assert.ok(Math.abs(realtime.position(fresh, '20261109').lat - 43.64) < 1e-5);
    assert.equal(realtime.position(fresh, '20261110'), null, 'another day of the same trip');
    assert.equal(realtime.position(old, '20261109'), null);
    assert.equal(realtime.positionStatus().find((f) => f.id === 'zou-prox').received, 2);
  } finally {
    server.close();
  }
});

function vehicleScene(position, lookup = null) {
  const [x, y] = toXY(7.01, 43.63);
  const trip = makeTrip({ key: 'n:T', dist: Float64Array.from([0, 1000]) });
  const model = {
    trips: [trip],
    shapes: [makeShape([[x, y], [x + 1000, y]])],
    lines: [{ key: 'L', short: 'L', color: '#000000', text: '#ffffff' }],
  };
  const date = '20261109';
  const realtime = { lookup: () => lookup, position: () => position };
  const at = (t) => computeVehicles(model, realtime, serviceOrigin(date) + t * 1000, (d) => (d === date ? [trip] : []));
  return { at };
}

test('a reported position replaces the timetable position', () => {
  const nowT = 1100;
  const fix = { lon: 7.02, lat: 43.64, bearing: null, at: Date.UTC(2026, 10, 8, 23) + (nowT - 10) * 1000 };
  const [bus] = vehicleScene(fix).at(nowT).vehicles;
  assert.equal(bus.status, 'reported');
  assert.equal(bus.lon, 7.02);
  assert.equal(bus.lat, 43.64);
  assert.equal(bus.bearing, 90, 'direction taken from the route when the feed has none');
  assert.equal(bus.age, 10);
});

test('a reported position shows a bus the timetable says has not started', () => {
  const fix = { lon: 7.02, lat: 43.64, bearing: 45, at: 0 };
  assert.equal(vehicleScene(fix).at(500).vehicles[0].bearing, 45);
  assert.equal(vehicleScene(null).at(500).vehicles.length, 0);
});

test('without a reported position a bus keeps the timetable position', () => {
  const [bus] = vehicleScene(null).at(1100).vehicles;
  assert.equal(bus.status, 'scheduled');
  assert.equal(bus.age, null);
});

test('a cancelled trip stays off the map even with a reported position', () => {
  const fix = { lon: 7.02, lat: 43.64, bearing: 0, at: 0 };
  const { vehicles, cancelled } = vehicleScene(fix, { cancelled: true }).at(1100);
  assert.equal(vehicles.length, 0);
  assert.equal(cancelled, 1);
});

const ON_TIME = { hasReal: true, arrDelay: Int32Array.from([0, 0]), depDelay: Int32Array.from([0, 0]) };
const eastOfRouteStart = (metres) => {
  const [x, y] = toXY(7.01, 43.63);
  return toLonLat(x + metres, y);
};
const nearly = (actual, expected) => assert.ok(Math.abs(actual - expected) < 2e-5, `${actual} vs ${expected}`);

test('a live bus trails the route it covered, stopping just behind the marker', () => {
  // 1000 m in 200 s, so 5 m/s: at t=1150 the window is 1025 s to 1145 s.
  const { trail } = vehicleScene(null, ON_TIME).at(1150).vehicles[0];
  nearly(trail[0][0], eastOfRouteStart(125)[0]);
  nearly(trail.at(-1)[0], eastOfRouteStart(725)[0]);
});

test('a trail starts at the first stop for a bus that has just left', () => {
  const { trail } = vehicleScene(null, ON_TIME).at(1050).vehicles[0];
  nearly(trail[0][0], eastOfRouteStart(0)[0]);
  nearly(trail.at(-1)[0], eastOfRouteStart(225)[0]);
});

test('a scheduled bus has no trail', () => {
  assert.equal(vehicleScene(null).at(1150).vehicles[0].trail, null);
});

test('a reported bus trails from where it was reported, not where the timetable puts it', () => {
  const [lon, lat] = eastOfRouteStart(300);
  const { trail } = vehicleScene({ lon, lat, bearing: null, at: 0 }).at(1150).vehicles[0];
  nearly(trail.at(-1)[0], eastOfRouteStart(150)[0]);
});

test('a reported bus far off its route has no trail', () => {
  const [lon] = eastOfRouteStart(300);
  const { trail, lon: shown } = vehicleScene({ lon, lat: 43.64, bearing: null, at: 0 }).at(1150).vehicles[0];
  assert.equal(trail, null);
  assert.equal(shown, Math.round(lon * 1e6) / 1e6);
});

test('cruiseProfile turns dwell into one moment per stop', () => {
  const trip = makeTrip({
    arr: Int32Array.from([0, 100, 300]),
    dep: Int32Array.from([0, 160, 300]),
    dist: Float64Array.from([0, 500, 1500]),
  });
  const { time, dist } = cruiseProfile(trip);
  assert.deepEqual([...time], [0, 130, 300]);
  assert.deepEqual([...dist], [0, 500, 1500]);
});

test('cruiseProfile merges stops rounded to the same minute', () => {
  const trip = makeTrip({
    arr: Int32Array.from([0, 60, 60, 180]),
    dep: Int32Array.from([0, 60, 60, 180]),
    dist: Float64Array.from([0, 400, 800, 1500]),
  });
  const { time, dist } = cruiseProfile(trip);
  assert.deepEqual([...time], [0, 60, 180]);
  assert.deepEqual([...dist], [0, 600, 1500]);
});

test('cruiseProfile keeps the ends of the route when the first or last stops share a minute', () => {
  const trip = makeTrip({
    arr: Int32Array.from([0, 0, 120, 120]),
    dep: Int32Array.from([0, 0, 120, 120]),
    dist: Float64Array.from([0, 200, 900, 1000]),
  });
  assert.deepEqual([...cruiseProfile(trip).dist], [0, 1000]);
});

test('a bus keeps moving through a timetable with rounded times', () => {
  const trip = makeTrip({
    arr: Int32Array.from([0, 60, 60, 60, 180]),
    dep: Int32Array.from([0, 60, 60, 60, 180]),
    dist: Float64Array.from([0, 300, 600, 900, 1500]),
  });
  const { time, dist } = cruiseProfile(trip);
  for (let t = 0; t < 175; t += 5) {
    const step = distanceAt(time, time, dist, t + 5) - distanceAt(time, time, dist, t);
    assert.ok(step > 0 && step < 100, `${step} m in 5 s at t=${t}`);
  }
});

test('the delay smoother eases towards a new delay at a limited rate', () => {
  const smooth = createDelaySmoother({ maxRate: 0.3, snapSeconds: 240 });
  assert.equal(smooth('a', 100, 0), 100, 'a new bus starts at its delay');
  assert.equal(smooth('a', 160, 10_000), 103);
  assert.equal(smooth('a', 160, 20_000), 106);
  assert.equal(smooth('a', 106, 30_000), 106, 'stays once it has arrived');
  assert.equal(smooth('a', 100, 40_000), 103 , 'also eases down');
});

test('the delay smoother jumps only for very large changes', () => {
  const smooth = createDelaySmoother({ maxRate: 0.3, snapSeconds: 240 });
  smooth('a', 0, 0);
  assert.equal(smooth('a', 900, 5000), 900);
});

test('a delay update never stops or reverses a bus', () => {
  const trip = makeTrip({ key: 'n:T', dist: Float64Array.from([0, 1000]) });
  const [x, y] = toXY(7.01, 43.63);
  const model = {
    trips: [trip],
    shapes: [makeShape([[x, y], [x + 1000, y]])],
    lines: [{ key: 'L', short: 'L', color: '#000000', text: '#ffffff' }],
  };
  const date = '20261109';
  const origin = serviceOrigin(date);
  let delay = 0;
  const realtime = {
    lookup: () => ({ hasReal: true, arrDelay: Int32Array.from([delay, delay]), depDelay: Int32Array.from([delay, delay]) }),
    position: () => null,
  };
  const smooth = createDelaySmoother();
  const lonAt = (t) => computeVehicles(model, realtime, origin + t * 1000, (d) => (d === date ? [trip] : []), smooth).vehicles[0].lon;
  let previous = lonAt(1020);
  for (let t = 1025; t <= 1120; t += 5) {
    delay = t >= 1050 ? 60 : 0;
    const lon = lonAt(t);
    assert.ok(lon > previous, `moved forward at t=${t}`);
    previous = lon;
  }
});

test('nextDeparture finds the earliest wanted trip across days', () => {
  const days = [
    { origin: 1000, trips: [{ l: 0, t: [10, 20] }, { l: 1, t: [50, 60] }] },
    { origin: 200_000, trips: [{ l: 0, t: [1, 20] }] },
  ];
  const all = () => true;
  assert.equal(nextDeparture(days, 0, all), 11_000);
  assert.equal(nextDeparture(days, 11_000, all), 51_000, 'strictly after the moment given');
  assert.equal(nextDeparture(days, 60_000, all), 201_000, 'carries into the next day');
  assert.equal(nextDeparture(days, 0, (trip) => trip.l === 1), 51_000, 'honours the line filter');
  assert.equal(nextDeparture(days, 300_000, all), null);
});

test('nextDeparture ignores trips that never appear on the map', () => {
  assert.equal(nextDeparture([{ origin: 0, trips: [{ l: 0, t: [5] }] }], 0, () => true), null);
});

test('the department boundary keeps the 06 and leaves out its neighbours', () => {
  for (const [name, lon, lat] of [['Valbonne', 7.0086, 43.6417], ['Nice', 7.262, 43.71], ['Menton', 7.5, 43.776], ['Grasse', 6.92, 43.658], ['Cannes', 7.01, 43.552], ['Tende', 7.594, 44.088]]) {
    assert.ok(inAlpesMaritimes(lon, lat), `${name} is in the 06`);
  }
  for (const [name, lon, lat] of [['Fréjus', 6.737, 43.433], ['Toulon', 5.93, 43.125], ['Ventimiglia', 7.61, 43.79], ['Barcelonnette', 6.65, 44.387]]) {
    assert.ok(!inAlpesMaritimes(lon, lat), `${name} is outside the 06`);
  }
});

test('the map shows regular buses and trams only', () => {
  assert.ok(isShownRoute('3'));
  assert.ok(isShownRoute(' 3'));
  assert.ok(isShownRoute('700'));
  assert.ok(isShownRoute('0'), 'tram');
  assert.ok(!isShownRoute('2'), 'train');
  assert.ok(!isShownRoute('4'), 'ferry');
  assert.ok(!isShownRoute('715'), 'on demand');
});

test('routes made by joining stops leave the road colouring alone', () => {
  const synthetic = Object.assign(makeShape([[0, 0], [1000, 0]]), { synthetic: true });
  const { pieces, visits } = buildPieces([synthetic, makeShape([[0, 500], [1000, 500]])]);
  assert.equal(visits[0].pieces.length, 0);
  assert.ok(visits[1].pieces.length > 0);
  assert.equal(pieces.length, visits[1].pieces.length);
});

function zipEntry(name, content, { deflate = true, zip64 = false } = {}) {
  const data = deflate ? deflateRawSync(content) : content;
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt16LE(nameBytes.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(deflate ? 8 : 0, 10);
  directory.writeUInt32LE(zip64 ? 0xffffffff : data.length, 20);
  directory.writeUInt32LE(zip64 ? 0xffffffff : content.length, 24);
  directory.writeUInt16LE(nameBytes.length, 28);
  let extra = Buffer.alloc(0);
  if (zip64) {
    extra = Buffer.alloc(20);
    extra.writeUInt16LE(1, 0);
    extra.writeUInt16LE(16, 2);
    extra.writeBigUInt64LE(BigInt(content.length), 4);
    extra.writeBigUInt64LE(BigInt(data.length), 12);
    directory.writeUInt16LE(extra.length, 30);
  }
  return { local: Buffer.concat([local, nameBytes, data]), directory, nameBytes, extra };
}

function zipOf(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    e.directory.writeUInt32LE(offset, 42);
    parts.push(e.local);
    offset += e.local.length;
    central.push(e.directory, e.nameBytes, e.extra);
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, dir, end]));
}

test('readZip reads deflated, stored and zip64 entries and only the ones asked for', () => {
  const zip = zipOf([
    zipEntry('routes.txt', Buffer.from('a,b\n1,2\n')),
    zipEntry('trips.txt', Buffer.from('stored'), { deflate: false }),
    zipEntry('stops.txt', Buffer.from('zip64 sized'), { zip64: true }),
    zipEntry('other.txt', Buffer.from('skip me')),
  ]);
  const files = readZip(zip, ['routes.txt', 'trips.txt', 'stops.txt']);
  assert.equal(files['routes.txt'].toString(), 'a,b\n1,2\n');
  assert.equal(files['trips.txt'].toString(), 'stored');
  assert.equal(files['stops.txt'].toString(), 'zip64 sized');
  assert.equal(files['other.txt'], undefined);
});

test('readZip rejects something that is not a zip', () => {
  assert.throws(() => readZip(new Uint8Array(100), ['a']), /Not a zip/);
});

test('pointAt gives a compass bearing', () => {
  assert.equal(pointAt(straight(100), 50).bearing, 90);
});

test('overlapping lines merge onto the same road pieces, in either direction', () => {
  const a = makeShape([[0, 0], [2000, 0]]);
  const b = makeShape([[1990, 4], [13, 4]]);
  const { pieces, visits } = buildPieces([a, b]);
  assert.equal(pieces.length, visits[0].pieces.length, 'second line adds no new pieces');
  const shared = new Set(visits[0].pieces);
  const matched = [...visits[1].pieces].filter((p) => shared.has(p)).length;
  assert.equal(matched, visits[1].pieces.length);
});

test('a crossing road and a distant parallel road stay separate', () => {
  const main = makeShape([[0, 0], [1000, 0]]);
  const crossing = makeShape([[500, -500], [500, 500]]);
  const parallel = makeShape([[0, 200], [1000, 200]]);
  const { visits } = buildPieces([main, crossing, parallel]);
  const mainSet = new Set(visits[0].pieces);
  assert.ok([...visits[1].pieces].every((p) => !mainSet.has(p)));
  assert.ok([...visits[2].pieces].every((p) => !mainSet.has(p)));
});

test('passageTimes ignores the parts of a shape outside the trip', () => {
  const trip = makeTrip({ dist: Float64Array.from([100, 300]), arr: Int32Array.from([0, 200]), dep: Int32Array.from([0, 200]) });
  assert.deepEqual([...passageTimes(trip, Float64Array.from([50, 200, 400]))], [-1, 100, -1]);
});

function miniNetwork() {
  const shapes = [straight(400)];
  const { pieces, visits } = buildPieces(shapes);
  const calendars = new Map([['n', { rules: new Map(), exceptions: new Map([['s:20261109', 1]]) }]]);
  const stops = [{ x: 0, y: 0 }, { x: 400, y: 0 }];
  const trip = (start) =>
    makeTrip({
      arr: Int32Array.from([start, start + 400]),
      dep: Int32Array.from([start, start + 400]),
      dist: Float64Array.from([0, 400]),
    });
  const model = { shapes, stops, calendars, lines: [{}], trips: [trip(1000), trip(5000)] };
  return { model, day: buildDay(model, visits, '20261109'), pieces };
}

test('passage counts follow the time window and skip cancelled trips', () => {
  const { model, day, pieces } = miniNetwork();
  const hexes = buildHexes(model.stops);
  const run = (from, to, delays = new Int32Array(2)) =>
    score(model, day, hexes, pieces.length, { from, to, lines: null, delays }).roads;

  assert.ok(run(-Infinity, Infinity).every((n) => n === 2), 'both trips over the full day');
  assert.ok(run(-Infinity, 2000).every((n) => n === 1), 'only the first trip so far');
  assert.ok(run(-Infinity, 900).every((n) => n === 0), 'nothing yet');
  assert.ok(run(-Infinity, Infinity, Int32Array.from([CANCELLED_DELAY, 0])).every((n) => n === 1));
  assert.ok(run(-Infinity, 2000, Int32Array.from([3000, 0])).every((n) => n === 0), 'a late bus has not passed yet');
});

test('a bus crossing half the route has counted only the road behind it', () => {
  const { model, day, pieces } = miniNetwork();
  const counts = score(model, day, buildHexes(model.stops), pieces.length, {
    from: -Infinity,
    to: 1200,
    lines: null,
    delays: new Int32Array(2),
  }).roads;
  const passed = pieces.filter((p, i) => counts[i] === 1);
  assert.ok(passed.length > 0 && passed.length < pieces.length);
  assert.ok(passed.every((p) => p.x <= 201));
});

test('line filter restricts the counts', () => {
  const { model, day, pieces } = miniNetwork();
  const counts = score(model, day, buildHexes(model.stops), pieces.length, {
    from: -Infinity,
    to: Infinity,
    lines: new Set([7]),
    delays: new Int32Array(2),
  }).roads;
  assert.ok(counts.every((n) => n === 0));
});

test('area scores favour hexagons closer to a stop', () => {
  const stops = [{ x: 0, y: 0 }];
  const hexes = buildHexes(stops);
  const nearest = hexes.reduce((a, b) => (a.weights[0] > b.weights[0] ? a : b));
  const farthest = hexes.reduce((a, b) => (a.weights[0] < b.weights[0] ? a : b));
  assert.ok(hexes.length > 3);
  assert.ok(nearest.weights[0] > 0.9);
  assert.ok(farthest.weights[0] < nearest.weights[0]);
});
