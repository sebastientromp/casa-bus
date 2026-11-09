import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { encodeAreas, encodeMap, encodeShapes, encodeTimetable, encodeVisits } from '../build/encode.js';
import { fillMissingTimes, inAlpesMaritimes, isServiceActive, isShownRoute, newestArchiveUrl, parseCsv, parseTime, serviceOrigin, timetableRange } from '../build/gtfs.js';
import { buildHexes, buildPieces, cruiseProfile } from '../build/network.js';
import { readZip } from '../build/zip.js';
import { buildDayEvents, decodeAreas, decodeVisits, pieceDetail, score, windowRange } from '../public/colouring.js';
import { hexRing, makeShape, pointAt, projectStops, toXY } from '../public/geo.js';
import { dayOf, decodeShapes, decodeTimetable, distanceAt, nextDeparture, serviceDateOf, shiftYmd, vehiclesAt } from '../public/schedule.js';

const straight = (length, y = 0) => makeShape([[0, y], [length, y]]);
const viaJson = (value) => JSON.parse(JSON.stringify(value));

function makeTrip(overrides) {
  return {
    net: 'n',
    serviceId: 's',
    line: 0,
    shape: 0,
    headsign: 'Town',
    arr: Int32Array.from([1000, 1200]),
    dep: Int32Array.from([1000, 1200]),
    dist: Float64Array.from([0, 1000]),
    stops: Int32Array.from([0, 1]),
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
  assert.equal(serviceDateOf(Date.UTC(2026, 10, 10, 1, 30)), '20261109', '02:30 local is still the previous day');
  assert.equal(serviceDateOf(Date.UTC(2026, 10, 10, 2, 30)), '20261110', '03:30 local is the new day');
});

test('shiftYmd crosses months and years', () => {
  assert.equal(shiftYmd('20261231', 1), '20270101');
  assert.equal(shiftYmd('20261101', -1), '20261031');
});

test('serviceOrigin is local midnight on normal days and noon minus 12 h on DST days', () => {
  assert.equal(serviceOrigin('20261109'), Date.UTC(2026, 10, 8, 23));
  assert.equal(serviceOrigin('20260329'), Date.UTC(2026, 2, 29, 10) - 12 * 3600 * 1000, 'spring change');
});

test('timetableRange spans rules and added dates', () => {
  const calendars = new Map([
    ['a', { rules: new Map([['s', { start: '20261101', end: '20261201' }]]), exceptions: new Map([['x:20270105', 1], ['x:20200101', 2]]) }],
  ]);
  assert.deepEqual(timetableRange({ calendars }), { from: '20261101', to: '20270105' });
});

test('newestArchiveUrl picks the latest copy of the right file', () => {
  const entry = (when, permanent_url, resource_url = 'source', format = 'GTFS') => ({ payload: { format, resource_url, permanent_url, download_datetime: when } });
  const history = [
    entry('2026-10-01T06:00:00Z', 'old'),
    entry('2026-11-03T06:00:00Z', 'new'),
    entry('2026-11-05T06:00:00Z', 'other file', 'elsewhere'),
    entry('2026-11-06T06:00:00Z', 'not gtfs', 'source', 'NeTEx'),
    { payload: {} },
  ];
  assert.equal(newestArchiveUrl(history, 'source'), 'new');
  assert.equal(newestArchiveUrl(history, 'unknown'), null);
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

test('pointAt gives a compass bearing', () => {
  assert.equal(pointAt(straight(100), 50).bearing, 90);
});

test('distanceAt interpolates and is null off-trip', () => {
  const time = [0, 100, 300];
  const dist = [0, 500, 1500];
  assert.equal(distanceAt(time, dist, 50), 250);
  assert.equal(distanceAt(time, dist, 200), 1000);
  assert.equal(distanceAt(time, dist, -1), null);
  assert.equal(distanceAt(time, dist, 301), null);
  assert.equal(distanceAt([5], [0], 5), null, 'a single point is never a journey');
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

test('a vehicle keeps moving through a timetable with rounded times', () => {
  const trip = makeTrip({
    arr: Int32Array.from([0, 60, 60, 60, 180]),
    dep: Int32Array.from([0, 60, 60, 60, 180]),
    dist: Float64Array.from([0, 300, 600, 900, 1500]),
  });
  const { time, dist } = cruiseProfile(trip);
  for (let t = 0; t < 175; t += 5) {
    const step = distanceAt(time, dist, t + 5) - distanceAt(time, dist, t);
    assert.ok(step > 0 && step < 100, `${step} m in 5 s at t=${t}`);
  }
});

test('overlapping lines merge onto the same road pieces, in either direction', () => {
  const a = makeShape([[0, 0], [2000, 0]]);
  const b = makeShape([[1990, 4], [13, 4]]);
  const { pieces, visits } = buildPieces([a, b]);
  assert.equal(pieces.length, visits[0].pieces.length, 'second line adds no new pieces');
  const shared = new Set(visits[0].pieces);
  assert.ok([...visits[1].pieces].every((p) => shared.has(p)));
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

test('routes made by joining stops leave the road colouring alone', () => {
  const synthetic = Object.assign(makeShape([[0, 0], [1000, 0]]), { synthetic: true });
  const { pieces, visits } = buildPieces([synthetic, makeShape([[0, 500], [1000, 500]])]);
  assert.equal(visits[0].pieces.length, 0);
  assert.equal(pieces.length, visits[1].pieces.length);
});

// A small network, sent through the real encoding as the browser would receive it.
function miniNetwork() {
  const [x, y] = toXY(7.01, 43.63);
  const shapes = decodeShapes(viaJson(encodeShapes([makeShape([[x, y], [x + 400, y]])])));
  const { pieces, visits } = buildPieces(shapes);
  const stops = [{ x, y }, { x: x + 400, y }];
  const calendars = new Map([['n', { rules: new Map(), exceptions: new Map([['s:20261109', 1], ['t:20261110', 1]]) }]]);
  const length = shapes[0].length;
  const trip = (start, overrides) =>
    makeTrip({
      arr: Int32Array.from([start, start + 400]),
      dep: Int32Array.from([start, start + 400]),
      dist: Float64Array.from([0, length]),
      ...overrides,
    });
  const model = {
    shapes,
    stops,
    calendars,
    lines: [{}, {}],
    trips: [trip(1000), trip(5000), trip(9000, { serviceId: 't' })],
  };
  const timetable = decodeTimetable(viaJson(encodeTimetable(model, { from: '20261109', to: '20261110' })));
  const decodedVisits = decodeVisits(viaJson(encodeVisits(visits)));
  const hexes = buildHexes(stops);
  const areas = decodeAreas(viaJson(encodeAreas(hexes)));
  const day = dayOf(timetable, '20261109');
  const events = buildDayEvents(timetable, decodedVisits, day);
  const counts = { pieces: pieces.length, stops: stops.length, areas: areas.length };
  return { model, timetable, shapes, pieces, hexes, areas, day, events, counts, length };
}

test('trips sharing a rhythm become one profile and keep their own start', () => {
  const { timetable } = miniNetwork();
  assert.equal(timetable.profiles.length, 1);
  assert.deepEqual([...timetable.trips.start], [1000, 5000, 9000]);
  assert.deepEqual([...timetable.profiles[0].stops], [0, 1]);
});

test('the day calendar survives encoding', () => {
  const { timetable } = miniNetwork();
  const monday = dayOf(timetable, '20261109');
  assert.equal(monday.trips.length, 2);
  assert.equal(monday.origin, serviceOrigin('20261109'));
  assert.equal(dayOf(timetable, '20261110').trips.length, 1);
  assert.equal(dayOf(timetable, '20261111').trips.length, 0, 'after the last date');
  assert.equal(dayOf(timetable, '20261108').trips.length, 0, 'before the first date');
});

test('decoded routes have the same length as the originals', () => {
  const original = makeShape([toXY(7.01, 43.63), toXY(7.0123, 43.6312), toXY(7.02, 43.64)]);
  const [decoded] = decodeShapes(viaJson(encodeShapes([original])));
  assert.deepEqual([...decoded.cum], [...original.cum]);
});

test('map geometry can be rebuilt from the encoded form', () => {
  const [x, y] = toXY(7.01, 43.63);
  const raw = viaJson(encodeMap([{ line: [[x, y], [x + 40, y]] }, { line: [[x + 40, y], [x + 80, y]] }], [{ q: 3, r: -2 }, { q: 4, r: -2 }]));
  assert.equal(raw.roads.length, 2);
  assert.deepEqual(raw.areas, { q: [3, 1], r: [-2, 0] });
  const ring = hexRing(3, -2);
  assert.equal(ring.length, 7);
  assert.ok(Math.hypot(ring[0][0] - ring[6][0], ring[0][1] - ring[6][1]) < 1e-6, 'the ring closes');
});

test('vehiclesAt places a running vehicle on its route and leaves out the rest', () => {
  const { timetable, shapes, day, length } = miniNetwork();
  const at = (seconds) => vehiclesAt(timetable, shapes, [day], day.origin + seconds * 1000);
  const [vehicle, ...rest] = at(1200);
  assert.equal(rest.length, 0);
  const [x] = toXY(vehicle.lon, vehicle.lat);
  const [startX] = toXY(7.01, 43.63);
  assert.ok(Math.abs(x - startX - length / 2) < 2);
  assert.equal(vehicle.bearing, 90);
  assert.equal(at(900).length, 0, 'before the first departure');
  assert.equal(at(3000).length, 0, 'between trips');
});

test('passage counts follow the time window', () => {
  const { events, areas, counts } = miniNetwork();
  const roads = (from, to) => score(events, areas, counts, { from, to, lines: null }).roads;
  assert.ok(roads(-Infinity, Infinity).every((n) => n === 2), 'both trips over the full day');
  assert.ok(roads(-Infinity, 2000).every((n) => n === 1), 'only the first trip so far');
  assert.ok(roads(-Infinity, 900).every((n) => n === 0), 'nothing yet');
});

test('a vehicle crossing half the route has counted only the road behind it', () => {
  const { events, areas, counts, pieces } = miniNetwork();
  const { roads } = score(events, areas, counts, { from: -Infinity, to: 1200, lines: null });
  const [startX] = toXY(7.01, 43.63);
  const passed = pieces.filter((p, i) => roads[i] === 1);
  assert.ok(passed.length > 0 && passed.length < pieces.length);
  assert.ok(passed.every((p) => p.x - startX <= 201));
});

test('the line filter restricts the counts', () => {
  const { events, areas, counts } = miniNetwork();
  const none = score(events, areas, counts, { from: -Infinity, to: Infinity, lines: Uint8Array.from([0, 1]) });
  assert.ok(none.roads.every((n) => n === 0));
  const all = score(events, areas, counts, { from: -Infinity, to: Infinity, lines: Uint8Array.from([1, 0]) });
  assert.ok(all.roads.every((n) => n === 2));
});

test('area scores favour cells closer to a stop', () => {
  const stops = [{ x: 0, y: 0 }];
  const hexes = buildHexes(stops);
  const nearest = hexes.reduce((a, b) => (a.weights[0] > b.weights[0] ? a : b));
  const farthest = hexes.reduce((a, b) => (a.weights[0] < b.weights[0] ? a : b));
  assert.ok(hexes.length > 3);
  assert.ok(nearest.weights[0] > 0.9);
  assert.ok(farthest.weights[0] < nearest.weights[0]);
});

test('area scores count passages at nearby stops', () => {
  const { events, areas, counts } = miniNetwork();
  const score1 = score(events, areas, counts, { from: -Infinity, to: Infinity, lines: null }).areas;
  assert.ok(Math.max(...score1) >= 2);
});

test('pieceDetail lists the lines on a road piece', () => {
  const { events } = miniNetwork();
  const detail = pieceDetail(events, 0, { from: -Infinity, to: Infinity, lines: null });
  assert.equal(detail.total, 2);
  assert.deepEqual(detail.lines, [{ line: 0, count: 2 }]);
});

test('windowRange covers that day so far, the last hour and the full day', () => {
  assert.deepEqual(windowRange('today', 5000), { from: -Infinity, to: 5000 });
  assert.deepEqual(windowRange('hour', 5000), { from: 1400, to: 5000 });
  assert.deepEqual(windowRange('full', 5000), { from: -Infinity, to: Infinity });
});

test('nextDeparture finds the earliest wanted trip across days', () => {
  const profiles = [{ line: 0, time: [0, 10] }, { line: 1, time: [0, 10] }, { line: 0, time: [0] }];
  const timetable = { profiles, trips: { profile: [0, 1, 0, 2], start: [10, 50, 1, 2] } };
  const days = [{ origin: 1000, trips: [0, 1] }, { origin: 200_000, trips: [2] }];
  const all = () => true;
  assert.equal(nextDeparture(timetable, days, 0, all), 11_000);
  assert.equal(nextDeparture(timetable, days, 11_000, all), 51_000, 'strictly after the moment given');
  assert.equal(nextDeparture(timetable, days, 60_000, all), 201_000, 'carries into the next day');
  assert.equal(nextDeparture(timetable, days, 0, (p) => p.line === 1), 51_000, 'honours the line filter');
  assert.equal(nextDeparture(timetable, days, 300_000, all), null);
  assert.equal(nextDeparture(timetable, [{ origin: 0, trips: [3] }], 0, all), null, 'a trip that never appears');
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
