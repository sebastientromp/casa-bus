import { hexRing, toLonLat } from './geo.js';
import { dayOf, decodeShapes, decodeTimetable, loadGz, nextDeparture, serviceDateOf, shiftYmd, vehiclesAt } from './schedule.js';

const VALBONNE = [7.0086, 43.6417];
const MIN_SKIP_MS = 15 * 60 * 1000;
const SKIP_NOTE_MS = 2500;
const COLOUR_EVERY_MS = 1000;
const COLOUR_MIN_SIM_MS = 30000;
const BUSY_MAP_VEHICLES = 400;
const ZERO_ROAD = '#343b4d';

// One hue, dim to bright, so the most-served roads stand out against the dark map.
const RAMP = ['#104281', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#b7d3f6', '#e4f0fd'];
const BREAKS = {
  day: { roads: [1, 10, 25, 50, 100, 200, 400], areas: [1, 20, 50, 100, 200, 400, 800] },
  hour: { roads: [1, 2, 4, 8, 12, 20, 35], areas: [1, 4, 8, 15, 30, 50, 100] },
};
const WINDOW_TEXT = { today: 'that day so far', hour: 'in the last hour', full: 'in the full day' };

const state = {
  window: 'today',
  lines: [],
  networks: [],
  selected: new Set(),
  openNetworks: new Set(['envibus']),
  roadValues: [],
  areaValues: [],
  vehicles: new Map(),
  popup: null,
  popupVehicleId: null,
  timetable: null,
  shapes: null,
  days: new Map(),
  worker: null,
  workerReady: false,
  colouring: false,
  colourAgain: false,
  roadRequests: new Map(),
  nextRoadRequest: 1,
  playing: true,
  speed: 300,
  skipEmpty: true,
  skipNote: '',
  skipNoteUntil: 0,
  sim: 0,
  lastTick: 0,
  lastColour: 0,
  lastColourSim: -Infinity,
};

const $ = (id) => document.getElementById(id);

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/dark',
  center: VALBONNE,
  zoom: 12.3,
  attributionControl: false,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(
  new maplibregl.AttributionControl({
    compact: false,
    customAttribution: "Timetables: Envibus (ODbL), ZOU!, Lignes d'Azur, Palmbus, Zest, Sillages (Licence Ouverte)",
  }),
);

// The basemap references a decorative pattern that its sprite doesn't include.
map.on('styleimagemissing', (e) => {
  if (!map.hasImage(e.id)) map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function stepExpression(breaks, zeroColor) {
  const expr = ['step', ['coalesce', ['feature-state', 'n'], 0], zeroColor];
  breaks.forEach((b, i) => expr.push(b, RAMP[i]));
  return expr;
}

function currentBreaks() {
  return state.window === 'hour' ? BREAKS.hour : BREAKS.day;
}

function renderLegend() {
  const { roads, areas } = currentBreaks();
  $('ramp').innerHTML = RAMP.map((c) => `<span style="background:${c}"></span>`).join('');
  const ticks = (values) => values.map((v, i) => `<span>${v}${i === values.length - 1 ? '+' : ''}</span>`).join('');
  $('ticks-roads').innerHTML = ticks(roads);
  $('ticks-areas').innerHTML = ticks(areas);
}

function applyColourScale() {
  const { roads, areas } = currentBreaks();
  map.setPaintProperty('roads', 'line-color', stepExpression(roads, ZERO_ROAD));
  map.setPaintProperty('areas', 'fill-color', stepExpression(areas, 'rgba(0,0,0,0)'));
  renderLegend();
}

function selectedLineNumbers() {
  if (state.selected.size === state.lines.length) return null;
  return state.lines.flatMap((l, i) => (state.selected.has(l.key) ? [i] : []));
}

function applyValues(source, previous, next) {
  for (let id = 0; id < next.length; id++) {
    if ((previous[id] ?? 0) !== next[id]) map.setFeatureState({ source, id }, { n: next[id] });
  }
}

function refreshColours() {
  if (!state.workerReady) return;
  if (state.colouring) {
    state.colourAgain = true;
    return;
  }
  state.colouring = true;
  state.lastColourSim = state.sim;
  state.worker.postMessage({ type: 'score', at: Math.round(state.sim), window: state.window, lines: selectedLineNumbers() });
}

function onWorkerMessage({ data: message }) {
  if (message.type === 'ready') {
    state.workerReady = true;
    refreshColours();
  } else if (message.type === 'score') {
    applyValues('roads', state.roadValues, message.roads);
    applyValues('areas', state.areaValues, message.areas);
    state.roadValues = message.roads;
    state.areaValues = message.areas;
    state.colouring = false;
    if (state.colourAgain) {
      state.colourAgain = false;
      refreshColours();
    }
  } else if (message.type === 'piece') {
    const lngLat = state.roadRequests.get(message.request);
    state.roadRequests.delete(message.request);
    if (lngLat) showRoad(message.detail, lngLat);
  } else if (message.type === 'error') {
    console.warn('Colouring failed:', message.message);
    state.colouring = false;
  }
}

function vehiclePopupHtml(v) {
  return `<div class="popup-title"><span class="popup-line" style="background:${v.color};color:${v.text}">${escapeHtml(v.short)}</span>${escapeHtml(v.headsign)}</div><div class="popup-sub">Position from the timetable</div>`;
}

function setStatusText(text, warn = false) {
  const el = $('status');
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('warn', warn);
}

function drawVehicles() {
  const features = [];
  for (const vehicle of state.vehicles.values()) {
    if (!state.selected.has(vehicle.line)) {
      if (vehicle.id === state.popupVehicleId) state.popup.remove();
      continue;
    }
    features.push({
      type: 'Feature',
      id: features.length,
      geometry: { type: 'Point', coordinates: [vehicle.lon, vehicle.lat] },
      properties: { id: vehicle.id, short: vehicle.short, fill: vehicle.color, label: vehicle.text, bearing: vehicle.bearing },
    });
    if (vehicle.id === state.popupVehicleId) state.popup.setLngLat([vehicle.lon, vehicle.lat]);
  }
  map.getSource('vehicles').setData({ type: 'FeatureCollection', features });
}

const parisClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function toInputValue(ms) {
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function dayFor(date) {
  if (!state.days.has(date)) state.days.set(date, dayOf(state.timetable, date));
  return state.days.get(date);
}

function updateVehicles(days) {
  const vehicles = new Map();
  for (const v of vehiclesAt(state.timetable, state.shapes, days, state.sim)) {
    const line = state.lines[v.profile.line];
    vehicles.set(v.id, { id: v.id, lon: v.lon, lat: v.lat, bearing: v.bearing, line: line.key, short: line.short, color: line.color, text: line.text, headsign: v.profile.headsign });
  }
  state.vehicles = vehicles;
}

function shownVehicleCount() {
  let count = 0;
  for (const vehicle of state.vehicles.values()) if (state.selected.has(vehicle.line)) count++;
  return count;
}

function skipToNextDeparture(now, days, tomorrow) {
  const wanted = (profile) => state.selected.has(state.lines[profile.line].key);
  const next = nextDeparture(state.timetable, [...days, tomorrow], state.sim, wanted);
  if (next === null || next - state.sim < MIN_SKIP_MS) return;
  state.sim = next + 1;
  state.skipNote = `Skipped to ${parisClock.format(state.sim)}: nothing runs until then.`;
  state.skipNoteUntil = now + SKIP_NOTE_MS;
}

function tick(now) {
  const elapsed = Math.min(now - state.lastTick, 250);
  state.lastTick = now;
  if (state.playing) state.sim += elapsed * state.speed;

  let today = serviceDateOf(state.sim);
  let days = [dayFor(shiftYmd(today, -1)), dayFor(today)];
  updateVehicles(days);
  if (state.playing && state.skipEmpty && shownVehicleCount() === 0) {
    skipToNextDeparture(now, days, dayFor(shiftYmd(today, 1)));
    today = serviceDateOf(state.sim);
    days = [dayFor(shiftYmd(today, -1)), dayFor(today)];
    updateVehicles(days);
  }
  const keep = new Set([shiftYmd(today, -1), today, shiftYmd(today, 1)]);
  for (const date of state.days.keys()) if (!keep.has(date)) state.days.delete(date);
  if (state.popupVehicleId && !state.vehicles.has(state.popupVehicleId)) state.popup.remove();

  const clock = parisClock.format(state.sim);
  if ($('replay-clock').textContent !== clock) {
    $('replay-clock').textContent = clock;
    if (document.activeElement !== $('replay-at')) $('replay-at').value = toInputValue(state.sim);
  }
  const count = shownVehicleCount();
  if (now < state.skipNoteUntil) setStatusText(state.skipNote);
  else setStatusText(count ? `${count} ${count === 1 ? 'vehicle' : 'vehicles'} on the road.` : 'Nothing in the timetable at this time.');

  if (now - state.lastColour > COLOUR_EVERY_MS && Math.abs(state.sim - state.lastColourSim) >= COLOUR_MIN_SIM_MS) {
    state.lastColour = now;
    refreshColours();
  }
}

let lastFrame = 0;
function frame(now) {
  const frameGap = state.vehicles.size > BUSY_MAP_VEHICLES ? 66 : 33;
  if (!document.hidden && now - lastFrame > frameGap) {
    lastFrame = now;
    tick(now);
    drawVehicles();
  }
  requestAnimationFrame(frame);
}

function arrowImage() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#14171f';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(size / 2, 2);
  ctx.lineTo(size / 2 + 11, 17);
  ctx.lineTo(size / 2 - 11, 17);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

function setVisible(layers, visible) {
  for (const layer of layers) map.setLayoutProperty(layer, 'visibility', visible ? 'visible' : 'none');
}

function renderLines() {
  const container = $('lines');
  container.innerHTML = state.networks
    .map((net) => {
      const lines = state.lines.filter((l) => l.net === net.id);
      if (!lines.length) return '';
      const open = state.openNetworks.has(net.id);
      const chips = open
        ? lines
            .map(
              (l) =>
                `<button type="button" class="chip" data-line="${escapeHtml(l.key)}" aria-pressed="${state.selected.has(l.key)}" style="--chip:${l.color};--chip-text:${l.text}" title="${escapeHtml(l.long)}">${escapeHtml(l.short)}</button>`,
            )
            .join('')
        : '';
      const total = lines.length;
      const on = lines.filter((l) => state.selected.has(l.key)).length;
      const count = on === total ? `${total} lines` : `${on} of ${total} lines`;
      return `<div class="network"><div class="network-head"><label><input type="checkbox" data-net="${net.id}" ${on === total ? 'checked' : ''} /> ${escapeHtml(net.label)}</label><button type="button" class="link" data-expand="${net.id}" aria-expanded="${open}">${count} ${open ? '▴' : '▾'}</button></div>${open ? `<div class="chips">${chips}</div>` : ''}</div>`;
    })
    .join('');
  container.querySelectorAll('input[data-net]').forEach((input) => {
    const lines = state.lines.filter((l) => l.net === input.dataset.net);
    const on = lines.filter((l) => state.selected.has(l.key)).length;
    input.indeterminate = on > 0 && on < lines.length;
  });
}

function linesChanged() {
  renderLines();
  if (state.timetable) drawVehicles();
  refreshColours();
}

function bindControls() {
  $('window-choice').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-window]');
    if (!button || button.dataset.window === state.window) return;
    state.window = button.dataset.window;
    document.querySelectorAll('#window-choice button').forEach((b) => b.setAttribute('aria-checked', String(b === button)));
    applyColourScale();
    refreshColours();
  });
  $('replay-play').addEventListener('click', (e) => {
    state.playing = !state.playing;
    e.target.textContent = state.playing ? 'Pause' : 'Play';
  });
  $('replay-speed').addEventListener('change', (e) => {
    state.speed = Number(e.target.value);
  });
  $('replay-skip').addEventListener('change', (e) => {
    state.skipEmpty = e.target.checked;
  });
  $('replay-at').addEventListener('change', (e) => {
    const ms = new Date(e.target.value).getTime();
    if (Number.isNaN(ms)) return;
    state.sim = ms;
    state.lastColourSim = -Infinity;
  });
  $('toggle-roads').addEventListener('change', (e) => setVisible(['roads-casing', 'roads'], e.target.checked));
  $('toggle-areas').addEventListener('change', (e) => setVisible(['areas'], e.target.checked));
  $('toggle-vehicles').addEventListener('change', (e) => setVisible(['vehicle-circles', 'vehicle-arrows', 'vehicle-labels'], e.target.checked));
  $('lines-all').addEventListener('click', () => {
    state.selected = new Set(state.lines.map((l) => l.key));
    linesChanged();
  });
  $('lines-none').addEventListener('click', () => {
    state.selected = new Set();
    linesChanged();
  });
  $('lines').addEventListener('click', (e) => {
    const expand = e.target.closest('button[data-expand]');
    if (expand) {
      const net = expand.dataset.expand;
      if (state.openNetworks.has(net)) state.openNetworks.delete(net);
      else state.openNetworks.add(net);
      renderLines();
      return;
    }
    const chip = e.target.closest('button[data-line]');
    if (!chip) return;
    const key = chip.dataset.line;
    if (state.selected.has(key)) state.selected.delete(key);
    else state.selected.add(key);
    linesChanged();
  });
  $('lines').addEventListener('change', (e) => {
    const net = e.target.dataset.net;
    if (!net) return;
    for (const line of state.lines) {
      if (line.net !== net) continue;
      if (e.target.checked) state.selected.add(line.key);
      else state.selected.delete(line.key);
    }
    linesChanged();
  });
}

function showPopup(lngLat, html, vehicleId = null) {
  state.popup?.remove();
  state.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px', offset: vehicleId ? 16 : 6 })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);
  state.popupVehicleId = vehicleId;
  const popup = state.popup;
  popup.on('close', () => {
    if (state.popup === popup) state.popupVehicleId = null;
  });
}

function showRoad(detail, lngLat) {
  const label = detail.total === 1 ? 'passage' : 'passages';
  const lines = detail.lines
    .map(({ line, count }) => {
      const l = state.lines[line];
      return `<span><span class="popup-line" style="background:${l.color};color:${l.text}">${escapeHtml(l.short)}</span> ${count}</span>`;
    })
    .join('');
  showPopup(
    lngLat,
    `<div class="popup-title">${detail.total} ${label}</div><div class="popup-sub">${WINDOW_TEXT[state.window]}</div>${lines ? `<div class="popup-lines">${lines}</div>` : ''}`,
  );
}

function requestRoad(piece, lngLat) {
  if (!state.workerReady) return;
  const request = state.nextRoadRequest++;
  state.roadRequests.set(request, lngLat);
  state.worker.postMessage({ type: 'piece', request, piece, at: Math.round(state.sim), window: state.window, lines: selectedLineNumbers() });
}

function bindMapClicks() {
  const around = (p, r) => [
    [p.x - r, p.y - r],
    [p.x + r, p.y + r],
  ];
  map.on('click', (e) => {
    const hit = map.queryRenderedFeatures(around(e.point, 4), { layers: ['vehicle-circles'] })[0];
    if (hit) {
      const vehicle = state.vehicles.get(hit.properties.id);
      if (vehicle) showPopup([vehicle.lon, vehicle.lat], vehiclePopupHtml(vehicle), vehicle.id);
      return;
    }
    const road = map.queryRenderedFeatures(around(e.point, 6), { layers: ['roads'] })[0];
    if (road) requestRoad(road.id, e.lngLat);
  });
  map.on('mousemove', (e) => {
    const hit = map.queryRenderedFeatures(around(e.point, 6), { layers: ['vehicle-circles', 'roads'] });
    map.getCanvas().style.cursor = hit.length ? 'pointer' : '';
  });
}

function decodeMap(raw) {
  let lon = 0;
  let lat = 0;
  const roads = raw.roads.map((flat, id) => {
    const coordinates = [];
    for (let i = 0; i < flat.length; i += 2) {
      lon += flat[i];
      lat += flat[i + 1];
      coordinates.push([lon / 1e5, lat / 1e5]);
    }
    return { type: 'Feature', id, properties: {}, geometry: { type: 'LineString', coordinates } };
  });
  let q = 0;
  let r = 0;
  const areas = raw.areas.q.map((stepQ, id) => {
    q += stepQ;
    r += raw.areas.r[id];
    const ring = hexRing(q, r).map(([x, y]) => toLonLat(x, y).map((v) => Math.round(v * 1e5) / 1e5));
    return { type: 'Feature', id, properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
  });
  return { roads: { type: 'FeatureCollection', features: roads }, areas: { type: 'FeatureCollection', features: areas } };
}

function addLayers(network) {
  // Above every basemap road and building, below only the labels that follow them.
  const baseLayers = map.getStyle().layers;
  const lastShape = baseLayers.findLastIndex((l) => l.type !== 'symbol');
  const firstSymbol = baseLayers[lastShape + 1]?.id;
  map.addSource('areas', { type: 'geojson', data: network.areas, buffer: 8 });
  map.addSource('roads', { type: 'geojson', data: network.roads, buffer: 8, tolerance: 0.2 });
  map.addSource('vehicles', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addImage('vehicle-arrow', arrowImage());

  map.addLayer(
    {
      id: 'areas',
      type: 'fill',
      source: 'areas',
      paint: { 'fill-color': 'rgba(0,0,0,0)', 'fill-opacity': 0.42, 'fill-antialias': false },
    },
    firstSymbol,
  );
  // A dark edge keeps roads legible over areas that share their colour.
  map.addLayer(
    {
      id: 'roads-casing',
      type: 'line',
      source: 'roads',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#0a0c11',
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2, 12, 4.5, 15, 8, 18, 13],
      },
    },
    firstSymbol,
  );
  map.addLayer(
    {
      id: 'roads',
      type: 'line',
      source: 'roads',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ZERO_ROAD,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 12, 2.5, 15, 5, 18, 9],
      },
    },
    firstSymbol,
  );

  map.addLayer({
    id: 'vehicle-arrows',
    type: 'symbol',
    source: 'vehicles',
    minzoom: 11,
    layout: {
      'icon-image': 'vehicle-arrow',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.55, 14, 0.8],
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
  map.addLayer({
    id: 'vehicle-circles',
    type: 'circle',
    source: 'vehicles',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 4, 11, 8, 14, 12],
      'circle-color': ['get', 'fill'],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 12, 2],
    },
  });
  map.addLayer({
    id: 'vehicle-labels',
    type: 'symbol',
    source: 'vehicles',
    minzoom: 11,
    layout: {
      'text-field': ['get', 'short'],
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 11, 9, 14, 11],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': ['get', 'label'] },
  });
}

function ymdToMs(ymd) {
  return new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T12:00`).getTime();
}

async function start() {
  const loaded = new Promise((resolve) => map.once('load', resolve));
  const metaRes = await fetch('data/meta.json', { cache: 'no-cache' });
  if (!metaRes.ok) throw new Error('The timetable data could not be loaded.');
  const meta = await metaRes.json();
  state.lines = meta.lines;
  state.networks = meta.networks;
  state.selected = new Set(state.lines.map((l) => l.key));
  renderLines();
  renderLegend();
  const asInput = (ymd, time) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${time}`;
  $('replay-at').min = asInput(meta.range.from, '00:00');
  $('replay-at').max = asInput(meta.range.to, '23:59');
  $('data-date').textContent = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(meta.version);
  state.sim = Math.min(Math.max(Date.now(), ymdToMs(meta.range.from)), ymdToMs(meta.range.to));
  $('replay-at').value = toInputValue(state.sim);

  setStatusText('Downloading the timetables...');
  const query = `?v=${meta.version}`;
  const [mapData, timetable, shapes] = await Promise.all(
    ['map', 'timetable', 'shapes'].map((name) => loadGz(`data/${name}.json.gz${query}`)),
  );
  state.timetable = decodeTimetable(timetable);
  state.shapes = decodeShapes(shapes);
  const network = decodeMap(mapData);

  await loaded;
  addLayers(network);
  applyColourScale();
  bindControls();
  bindMapClicks();

  state.worker = new Worker('colour-worker.js', { type: 'module' });
  state.worker.onmessage = onWorkerMessage;
  state.worker.postMessage({ type: 'init', version: meta.version, counts: meta.counts, lineCount: state.lines.length });

  state.lastTick = performance.now();
  requestAnimationFrame(frame);
}

start().catch((err) => {
  console.error(err);
  setStatusText('The map could not start. Try reloading the page.', true);
});
