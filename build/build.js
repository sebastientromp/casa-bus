import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, gzipSync } from 'node:zlib';
import { encodeAreas, encodeMap, encodeShapes, encodeTimetable, encodeVisits } from './encode.js';
import { NETWORKS, ensureFeeds, loadAll, timetableRange } from './gtfs.js';
import { buildHexes, buildPieces } from './network.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEEDS = join(ROOT, 'data');
const SITE = join(ROOT, 'dist');
const OUT = join(SITE, 'data');
const MAPLIBRE = join(ROOT, 'node_modules', 'maplibre-gl', 'dist');

await ensureFeeds(FEEDS);
// Stop here rather than publish a site with a network quietly missing.
const missing = NETWORKS.filter((n) => !existsSync(join(FEEDS, `${n.id}.zip`)));
if (missing.length) throw new Error(`No timetable for ${missing.map((n) => n.label).join(', ')}`);

console.log('Reading timetables...');
const model = loadAll(FEEDS);
for (const net of NETWORKS) {
  if (!model.trips.some((t) => t.net === net.id)) throw new Error(`${net.label} has no usable trips`);
}
console.log('Building road pieces and area grid...');
const { pieces, visits } = buildPieces(model.shapes);
const hexes = buildHexes(model.stops);
console.log(`${pieces.length} road pieces, ${hexes.length} area cells, ${model.lines.length} lines`);

rmSync(SITE, { recursive: true, force: true });
cpSync(join(ROOT, 'public'), SITE, { recursive: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(join(SITE, 'vendor'), { recursive: true });
for (const file of ['maplibre-gl.js', 'maplibre-gl.css']) cpSync(join(MAPLIBRE, file), join(SITE, 'vendor', file));

function writeGz(name, value) {
  const file = join(OUT, `${name}.json.gz`);
  writeFileSync(file, gzipSync(JSON.stringify(value), { level: constants.Z_BEST_COMPRESSION }));
  console.log(`  ${name}: ${(statSync(file).size / 1048576).toFixed(2)} MB`);
}

const range = timetableRange(model);
console.log('Writing data files:');
writeGz('map', encodeMap(pieces, hexes));
writeGz('shapes', encodeShapes(model.shapes));
writeGz('timetable', encodeTimetable(model, range));
writeGz('visits', encodeVisits(visits));
writeGz('areas', encodeAreas(hexes));
writeFileSync(
  join(OUT, 'meta.json'),
  JSON.stringify({
    version: Date.now(),
    range,
    lines: model.lines,
    networks: NETWORKS.map(({ id, label }) => ({ id, label })),
    counts: { pieces: pieces.length, stops: model.stops.length, areas: hexes.length },
  }),
);
console.log(`Site ready in ${SITE}`);
