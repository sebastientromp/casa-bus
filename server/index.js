import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { NETWORKS, currentServiceDate, ensureFeeds, loadAll, serviceOrigin, timetableRange } from './gtfs.js';
import { toLonLat } from './geo.js';
import { computeVehicles, createDelaySmoother, cruiseOf, makeDayCache } from './positions.js';
import { createRealtime } from './realtime.js';
import {
  buildDay,
  buildHexes,
  buildPieces,
  currentDelays,
  hexesGeoJson,
  pieceDetail,
  piecesGeoJson,
  score,
} from './service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const VENDOR = join(ROOT, 'node_modules', 'maplibre-gl', 'dist');
const PORT = Number(process.env.PORT) || 5177;
const POLL_MS = 30_000;
const SERVICE_CACHE_MS = 10_000;
const MAX_DAYS_IN_MEMORY = 3;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json' };

await ensureFeeds(join(ROOT, 'data'));
console.log('Reading timetables...');
const model = loadAll(join(ROOT, 'data'));
console.log('Building road pieces and area grid...');
const { pieces, visits } = buildPieces(model.shapes);
const hexes = buildHexes(model.stops);
console.log(`${pieces.length} road pieces, ${hexes.length} area cells, ${model.lines.length} lines`);

const realtime = createRealtime(model);
await realtime.poll();
setInterval(() => realtime.poll(), POLL_MS);

const dayCache = makeDayCache(model);
const smoothDelay = createDelaySmoother();
const days = new Map();

function dayAt(atMs) {
  const date = currentServiceDate(atMs);
  if (!days.has(date)) {
    if (days.size >= MAX_DAYS_IN_MEMORY) days.delete(days.keys().next().value);
    days.set(date, buildDay(model, visits, date));
  }
  return days.get(date);
}
dayAt(Date.now());

/** The moment a request asks about, or null for right now. */
function requestedMoment(url) {
  const at = Number(url.searchParams.get('at'));
  return Number.isFinite(at) && at > 0 ? at : null;
}

const timetables = new Map();

function timetableResponse(date) {
  if (!timetables.has(date)) {
    if (timetables.size >= MAX_DAYS_IN_MEMORY) timetables.delete(timetables.keys().next().value);
    const trips = dayCache(date).map((trip) => {
      const cruise = cruiseOf(trip);
      return { l: trip.line, s: trip.shape, h: trip.headsign, t: Array.from(cruise.time), d: Array.from(cruise.dist, Math.round) };
    });
    timetables.set(date, gzipSync(JSON.stringify({ date, origin: serviceOrigin(date), trips })));
  }
  return timetables.get(date);
}

let shapesPayload = null;

function shapesResponse() {
  shapesPayload ??= gzipSync(
    JSON.stringify(
      model.shapes.map((shape) => ({
        c: Array.from(shape.xs, (x, i) => toLonLat(x, shape.ys[i]).map((v) => Math.round(v * 1e5) / 1e5)),
        m: Array.from(shape.cum, Math.round),
      })),
    ),
  );
  return shapesPayload;
}

const networkPayload = gzipSync(
  JSON.stringify({
    roads: piecesGeoJson(pieces),
    areas: hexesGeoJson(hexes),
    lines: model.lines,
    networks: NETWORKS.map(({ id, label, realtime: rt }) => ({ id, label, hasLive: !!rt })),
    timetable: timetableRange(model),
  }),
);

function send(res, status, body, type = 'application/json; charset=utf-8', gzip = false) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    ...(gzip ? { 'content-encoding': 'gzip' } : {}),
  });
  res.end(body);
}

function queryOptions(url, d) {
  const at = requestedMoment(url);
  const t = ((at ?? Date.now()) - d.origin) / 1000;
  const window = url.searchParams.get('window') ?? 'today';
  const from = window === 'hour' ? t - 3600 : -Infinity;
  const to = window === 'full' ? Infinity : t;
  const raw = url.searchParams.get('lines');
  const lines = raw === null ? null : new Set(raw.split(',').filter(Boolean).map(Number));
  const delays = at === null ? currentDelays(d, realtime, t) : new Int32Array(d.trips.length);
  return { from, to, lines, delays, window };
}

const serviceCache = new Map();

function serviceResponse(url) {
  const key = url.search;
  const cached = serviceCache.get(key);
  if (cached && Date.now() - cached.at < SERVICE_CACHE_MS) return cached.body;
  const d = dayAt(requestedMoment(url) ?? Date.now());
  const { roads, areas } = score(model, d, hexes, pieces.length, queryOptions(url, d));
  const body = gzipSync(JSON.stringify({ date: d.date, roads: Array.from(roads), areas: Array.from(areas) }));
  if (serviceCache.size > 50) serviceCache.clear();
  serviceCache.set(key, { at: Date.now(), body });
  return body;
}

function vehiclesResponse() {
  const now = Date.now();
  const { vehicles, cancelled } = computeVehicles(model, realtime, now, dayCache, smoothDelay);
  const count = (status) => vehicles.filter((v) => v.status === status).length;
  return {
    now,
    vehicles,
    reported: count('reported'),
    live: count('live'),
    scheduled: count('scheduled'),
    cancelled,
    feeds: realtime.status(),
    positionFeeds: realtime.positionStatus(),
  };
}

async function serveFile(res, base, relative) {
  const target = normalize(join(base, relative));
  if (target !== base && !target.startsWith(base + sep)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const content = await readFile(target);
    send(res, 200, content, TYPES[extname(target)] ?? 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    if (path === '/api/network') return send(res, 200, networkPayload, undefined, true);
    if (path === '/api/vehicles') return send(res, 200, JSON.stringify(vehiclesResponse()));
    if (path === '/api/service') return send(res, 200, serviceResponse(url), undefined, true);
    if (path === '/api/shapes') return send(res, 200, shapesResponse(), undefined, true);
    if (path === '/api/timetable') {
      const date = url.searchParams.get('date') ?? '';
      if (!/^\d{8}$/.test(date)) return send(res, 400, '{"error":"Expected date=YYYYMMDD"}');
      return send(res, 200, timetableResponse(date), undefined, true);
    }
    const pieceMatch = path.match(/^\/api\/piece\/(\d+)$/);
    if (pieceMatch) {
      const id = Number(pieceMatch[1]);
      if (id >= pieces.length) return send(res, 404, '{"error":"Unknown road piece"}');
      const d = dayAt(requestedMoment(url) ?? Date.now());
      return send(res, 200, JSON.stringify(pieceDetail(model, d, id, queryOptions(url, d))));
    }
    if (path.startsWith('/vendor/')) return serveFile(res, VENDOR, path.slice('/vendor/'.length));
    return serveFile(res, PUBLIC, path === '/' ? 'index.html' : path.slice(1));
  } catch (err) {
    console.error(err);
    send(res, 500, '{"error":"Server error"}');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nBus map ready: http://localhost:${PORT}`);
});
