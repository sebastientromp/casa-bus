import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeShape, projectStops, toXY } from '../public/geo.js';
import { readZip } from './zip.js';

const ONE_DAY = 24 * 3600 * 1000;
const DEPARTMENT = JSON.parse(readFileSync(new URL('./alpes-maritimes.json', import.meta.url), 'utf8'));

export const NETWORKS = [
  {
    id: 'envibus',
    label: 'Envibus',
    gtfs: 'https://open-share.agglo-casa.fr/s/34FS2SWg36NEZk4/download',
    // This server doesn't answer GitHub's build machines, so the national portal's copy is the fallback.
    archiveDataset: '5be2ce698b4c414a99f9d84c',
    licence: 'ODbL',
  },
  {
    id: 'zou-prox',
    label: 'ZOU! Proximité',
    gtfs: 'https://www.datasud.fr/fr/dataset/datasets/3745/resource/5016/download/',
    licence: 'Licence Ouverte',
    onlyInDepartment: true,
  },
  {
    id: 'zou-exp',
    label: 'ZOU! Express',
    gtfs: 'https://www.datasud.fr/fr/dataset/datasets/3743/resource/5153/download/',
    licence: 'Licence Ouverte',
    onlyInDepartment: true,
  },
  {
    id: 'zou-sco',
    label: 'ZOU! Scolaire',
    gtfs: 'https://www.data.gouv.fr/api/1/datasets/r/6471d334-17df-4308-bae0-5736c24a2e6a',
    licence: 'Licence Ouverte',
    onlyInDepartment: true,
  },
  {
    id: 'lignes-azur',
    label: "Lignes d'Azur",
    gtfs: 'https://www.data.gouv.fr/api/1/datasets/r/f5678ab2-c863-4b48-ba1f-9021c7d97634',
    licence: 'Licence Ouverte',
  },
  {
    id: 'palmbus',
    label: 'Palmbus',
    gtfs: 'https://www.data.gouv.fr/api/1/datasets/r/47bc8088-6c72-43ad-a959-a5bbdd1aa14f',
    licence: 'Licence Ouverte',
  },
  {
    id: 'zest',
    label: 'Zest',
    gtfs: 'https://www.data.gouv.fr/api/1/datasets/r/72609821-2459-47fb-a63b-3dbbc0d96c92',
    licence: 'Licence Ouverte',
  },
  {
    id: 'sillages',
    label: 'Sillages',
    gtfs: 'https://www.data.gouv.fr/api/1/datasets/r/851decd7-714f-45ad-9579-d60c06fad9dd',
    licence: 'Licence Ouverte',
  },
  {
    id: 'sillages-sco',
    label: 'Sillages Scolaire',
    gtfs: 'https://www.data.gouv.fr/api/1/datasets/r/1580b34b-8ebe-42b1-b75c-a4ae41d579b7',
    licence: 'Licence Ouverte',
  },
];

function insideRing(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inAlpesMaritimes(lon, lat) {
  return DEPARTMENT.some((ring) => insideRing(ring, lon, lat));
}

/** Regular buses and trams: leaves out boats, trains and on-demand services (route type 715). */
export function isShownRoute(type) {
  const code = Number(type);
  return code === 0 || code === 3 || code === 800 || (code >= 700 && code < 800 && code !== 715);
}

/** Minimal RFC 4180 parser returning one object per row. */
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let header = null;
  let fields = [];
  let field = '';
  let quoted = false;
  const flushRow = () => {
    fields.push(field);
    field = '';
    if (!header) {
      header = fields.map((h) => h.trim());
    } else if (fields.length > 1 || fields[0] !== '') {
      const row = {};
      header.forEach((h, i) => {
        row[h] = fields[i] ?? '';
      });
      rows.push(row);
    }
    fields = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      fields.push(field);
      field = '';
    } else if (c === '\n') flushRow();
    else if (c !== '\r') field += c;
  }
  if (field !== '' || fields.length) flushRow();
  return rows;
}

/** 'HH:MM:SS' (possibly past 24:00) to seconds, or null when blank. */
export function parseTime(value) {
  if (!value) return null;
  const [h, m, s] = value.trim().split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

function parisOffsetMs(epochMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris',
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(epochMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wall - Math.floor(epochMs / 1000) * 1000;
}

/** Paris calendar date of an instant, as 'YYYYMMDD'. */
export function shiftDate(ymd, days) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + days));
  return (
    String(d.getUTCFullYear()) +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0')
  );
}

/** GTFS time zero for a service date: noon local minus 12 h, so DST nights stay correct. */
export function serviceOrigin(ymd) {
  const guess = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), 12);
  const noon = guess - parisOffsetMs(guess);
  return noon - 12 * 3600 * 1000;
}

export function isServiceActive(calendar, serviceId, ymd) {
  const exception = calendar.exceptions.get(`${serviceId}:${ymd}`);
  if (exception === 1) return true;
  if (exception === 2) return false;
  const rule = calendar.rules.get(serviceId);
  if (!rule || ymd < rule.start || ymd > rule.end) return false;
  const weekday = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay();
  return rule.days[weekday];
}

/** Fills blank stop times by distance between the nearest timed stops. */
export function fillMissingTimes(times, dist) {
  const out = times.slice();
  let last = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === null) continue;
    if (last >= 0 && i - last > 1) {
      const span = dist[i] - dist[last] || 1;
      for (let k = last + 1; k < i; k++) {
        out[k] = Math.round(out[last] + ((out[i] - out[last]) * (dist[k] - dist[last])) / span);
      }
    }
    last = i;
  }
  return out;
}

function contrastText(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum > 150 ? '#10131a' : '#ffffff';
}

function lineColor(raw) {
  const clean = (raw || '').trim().replace('#', '');
  return /^[0-9a-fA-F]{6}$/.test(clean) && clean.toLowerCase() !== 'ffffff'
    ? `#${clean.toLowerCase()}`
    : '#8a93a6';
}

const CLIENT_HEADERS = { 'user-agent': 'valbonne-bus-map' };

async function downloadGtfs(url) {
  const res = await fetch(url, { headers: CLIENT_HEADERS, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!readZip(bytes, ['routes.txt'])['routes.txt']) throw new Error('not a GTFS archive');
  return bytes;
}

/** The address of the most recent copy the national portal has kept of a timetable file. */
export function newestArchiveUrl(history, sourceUrl) {
  const copies = history
    .filter((entry) => entry.payload?.format === 'GTFS' && entry.payload.resource_url === sourceUrl && entry.payload.permanent_url)
    .sort((a, b) => b.payload.download_datetime.localeCompare(a.payload.download_datetime));
  return copies[0]?.payload.permanent_url ?? null;
}

async function downloadArchive(net) {
  const url = `https://transport.data.gouv.fr/api/datasets/${net.archiveDataset}`;
  const res = await fetch(url, { headers: CLIENT_HEADERS, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`portal HTTP ${res.status}`);
  const archive = newestArchiveUrl((await res.json()).history ?? [], net.gtfs);
  if (!archive) throw new Error('no archived copy');
  return downloadGtfs(archive);
}

const reason = (err) => [err.message, err.cause?.code ?? err.cause?.message].filter(Boolean).join(': ');

/** Downloads any timetable that is missing or older than a day; a failed refresh keeps the last copy. */
export async function ensureFeeds(dataDir, log = console.log) {
  mkdirSync(dataDir, { recursive: true });
  for (const net of NETWORKS) {
    const file = join(dataDir, `${net.id}.zip`);
    const fresh = existsSync(file) && Date.now() - statSync(file).mtimeMs < ONE_DAY;
    if (fresh) continue;
    log(`Downloading ${net.label} timetable...`);
    try {
      let bytes;
      try {
        bytes = await downloadGtfs(net.gtfs);
      } catch (err) {
        if (!net.archiveDataset) throw err;
        log(`${net.label} source failed (${reason(err)}); using the national portal's copy.`);
        bytes = await downloadArchive(net);
      }
      writeFileSync(file, bytes);
    } catch (err) {
      log(existsSync(file)
        ? `Could not refresh ${net.label} (${reason(err)}); using the previous copy.`
        : `Could not download ${net.label} (${reason(err)}); it will be missing from the map.`);
    }
  }
}

function readGtfs(dataDir, net) {
  const wanted = new Set(['routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'shapes.txt', 'calendar.txt', 'calendar_dates.txt']);
  const files = readZip(readFileSync(join(dataDir, `${net.id}.zip`)), wanted);
  return (name) => (files[name] ? parseCsv(files[name].toString('utf8')) : []);
}

function readCalendar(read) {
  const rules = new Map();
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (const row of read('calendar.txt')) {
    rules.set(row.service_id, {
      days: names.map((d) => row[d] === '1'),
      start: row.start_date,
      end: row.end_date,
    });
  }
  const exceptions = new Map();
  for (const row of read('calendar_dates.txt')) {
    exceptions.set(`${row.service_id}:${row.date}`, Number(row.exception_type));
  }
  return { rules, exceptions };
}

/** Coordinates are kept to 1e-5 degrees, so the browser rebuilds exactly the same route lengths. */
function fixedXY(lon, lat) {
  return toXY(Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5);
}

function readShapes(read) {
  const groups = new Map();
  for (const row of read('shapes.txt')) {
    if (!groups.has(row.shape_id)) groups.set(row.shape_id, []);
    groups.get(row.shape_id).push([Number(row.shape_pt_sequence), +row.shape_pt_lon, +row.shape_pt_lat]);
  }
  const shapes = new Map();
  for (const [id, pts] of groups) {
    pts.sort((a, b) => a[0] - b[0]);
    shapes.set(id, makeShape(pts.map(([, lon, lat]) => fixedXY(lon, lat))));
  }
  return shapes;
}

/** Loads all networks into one model: lines, stops, shapes, trips, calendars. */
export function loadAll(dataDir, log = console.log) {
  const model = { lines: [], stops: [], shapes: [], trips: [], calendars: new Map() };
  const lineIndex = new Map();

  for (const net of NETWORKS) {
    if (!existsSync(join(dataDir, `${net.id}.zip`))) continue;
    const read = readGtfs(dataDir, net);
    model.calendars.set(net.id, readCalendar(read));

    const stopIdx = new Map();
    const stopRows = read('stops.txt').filter((s) => s.stop_lat && s.stop_lon);
    const stopXY = new Map();
    const stopsInDepartment = new Set();
    for (const s of stopRows) {
      stopXY.set(s.stop_id, fixedXY(+s.stop_lon, +s.stop_lat));
      if (inAlpesMaritimes(+s.stop_lon, +s.stop_lat)) stopsInDepartment.add(s.stop_id);
    }

    const rowsByTrip = new Map();
    const keepTrip = new Set();
    for (const row of read('stop_times.txt')) {
      if (!rowsByTrip.has(row.trip_id)) rowsByTrip.set(row.trip_id, []);
      rowsByTrip.get(row.trip_id).push(row);
      if (!net.onlyInDepartment || stopsInDepartment.has(row.stop_id)) keepTrip.add(row.trip_id);
    }

    const routes = new Map(read('routes.txt').map((r) => [r.route_id, r]));
    const shapes = readShapes(read);
    const shapeIndex = new Map();
    const patterns = new Map();
    let skipped = 0;
    let kept = 0;
    let joinedStops = 0;

    for (const t of read('trips.txt')) {
      if (!keepTrip.has(t.trip_id)) continue;
      const route = routes.get(t.route_id);
      const rows = rowsByTrip.get(t.trip_id);
      if (!route || !isShownRoute(route.route_type)) continue;
      if (!rows || rows.length < 2) {
        skipped++;
        continue;
      }
      rows.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
      if (rows.some((r) => !stopXY.has(r.stop_id))) {
        skipped++;
        continue;
      }

      // No published route: join the stops, and let the road colouring ignore it.
      let shapeKey = t.shape_id;
      let shape = shapes.get(shapeKey);
      if (!shape || shape.xs.length < 2) {
        shapeKey = `stops:${rows.map((r) => r.stop_id).join(',')}`;
        shape = shapes.get(shapeKey) ?? makeShape(rows.map((r) => stopXY.get(r.stop_id)));
        shape.synthetic = true;
        shapes.set(shapeKey, shape);
        if (shape.xs.length < 2) {
          skipped++;
          continue;
        }
        joinedStops++;
      }

      const patternKey = `${shapeKey}|${rows.map((r) => r.stop_id).join(',')}`;
      if (!patterns.has(patternKey)) {
        patterns.set(patternKey, projectStops(shape, rows.map((r) => stopXY.get(r.stop_id))));
      }
      const dist = patterns.get(patternKey);

      const arrivals = rows.map((r) => parseTime(r.arrival_time) ?? parseTime(r.departure_time));
      const departures = rows.map((r) => parseTime(r.departure_time) ?? parseTime(r.arrival_time));
      if (arrivals[0] === null || arrivals[arrivals.length - 1] === null) {
        skipped++;
        continue;
      }
      const arr = fillMissingTimes(arrivals, dist);
      const dep = fillMissingTimes(departures, dist);

      if (!shapeIndex.has(shapeKey)) {
        shapeIndex.set(shapeKey, model.shapes.length);
        model.shapes.push(shape);
      }

      const lineKey = `${net.id}:${route.route_short_name || route.route_id}`;
      if (!lineIndex.has(lineKey)) {
        const color = lineColor(route.route_color);
        lineIndex.set(lineKey, model.lines.length);
        model.lines.push({
          key: lineKey,
          net: net.id,
          short: route.route_short_name || route.route_id,
          long: route.route_long_name || '',
          color,
          text: contrastText(color),
        });
      }

      const stopIndices = rows.map((r) => {
        const key = `${net.id}:${r.stop_id}`;
        if (!stopIdx.has(key)) {
          const [x, y] = stopXY.get(r.stop_id);
          stopIdx.set(key, model.stops.length);
          model.stops.push({ x, y });
        }
        return stopIdx.get(key);
      });

      model.trips.push({
        net: net.id,
        serviceId: t.service_id,
        line: lineIndex.get(lineKey),
        headsign: t.trip_headsign || rows[rows.length - 1].stop_headsign || route.route_long_name || '',
        shape: shapeIndex.get(shapeKey),
        arr: Int32Array.from(arr),
        dep: Int32Array.from(dep),
        dist,
        stops: Int32Array.from(stopIndices),
      });
      kept++;
    }
    log(`${net.label}: ${kept} trips kept${joinedStops ? ` (${joinedStops} with no published route)` : ''}${skipped ? `, ${skipped} skipped (incomplete data)` : ''}`);
  }
  return model;
}

/** First and last service dates any published timetable covers, as YYYYMMDD. */
export function timetableRange(model) {
  const dates = [];
  for (const calendar of model.calendars.values()) {
    for (const rule of calendar.rules.values()) dates.push(rule.start, rule.end);
    for (const [key, type] of calendar.exceptions) if (type === 1) dates.push(key.slice(-8));
  }
  dates.sort();
  return { from: dates[0], to: dates[dates.length - 1] };
}

/** Trips running on a service date. */
export function tripsOn(model, ymd) {
  return model.trips.filter((t) => isServiceActive(model.calendars.get(t.net), t.serviceId, ymd));
}
