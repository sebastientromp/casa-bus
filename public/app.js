import { nextDeparture } from '/replay.js';

const VALBONNE = [7.0086, 43.6417];
const MIN_SKIP_MS = 15 * 60 * 1000;
const SKIP_NOTE_MS = 2500;
const VEHICLE_MS = 5000;
const REPORTED_TWEEN_MS = 30000;
const BUSY_MAP_BUSES = 400;
const SERVICE_MS = 30000;
const MAX_TWEEN_METRES = 2000;
const ZERO_ROAD = '#343b4d';

// One hue, dim to bright, so the most-served roads stand out against the dark map.
const RAMP = ['#104281', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#b7d3f6', '#e4f0fd'];
const BREAKS = {
  day: { roads: [1, 10, 25, 50, 100, 200, 400], areas: [1, 20, 50, 100, 200, 400, 800] },
  hour: { roads: [1, 2, 4, 8, 12, 20, 35], areas: [1, 4, 8, 15, 30, 50, 100] },
};
const WINDOW_TEXT = { today: 'today so far', hour: 'in the last hour', full: 'in the full day' };

const state = {
  window: 'today',
  lines: [],
  networks: [],
  selected: new Set(),
  openNetworks: new Set(['envibus']),
  roadValues: [],
  areaValues: [],
  buses: new Map(),
  popup: null,
  popupBusId: null,
  serviceRequest: 0,
  liveOnly: false,
  latestVehicles: null,
  replay: {
    on: false,
    playing: true,
    speed: 300,
    skipEmpty: true,
    skipNote: '',
    skipNoteUntil: 0,
    sim: 0,
    lastTick: 0,
    shapes: null,
    shapesRequested: false,
    days: new Map(),
    loading: new Set(),
    retryAt: 0,
    lastColour: 0,
    lastColourSim: 0,
    colouring: false,
  },
};

const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    customAttribution: "Bus data: Envibus (ODbL), ZOU!, Lignes d'Azur, Palmbus, Zest, Sillages (Licence Ouverte), My Bus Finder",
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

function allSelected() {
  return state.selected.size === state.lines.length;
}

function linesQuery() {
  if (allSelected()) return '';
  const indices = state.lines.flatMap((l, i) => (state.selected.has(l.key) ? [i] : []));
  return `&lines=${indices.join(',')}`;
}

function applyValues(source, previous, next) {
  for (let id = 0; id < next.length; id++) {
    if (previous[id] !== next[id]) map.setFeatureState({ source, id }, { n: next[id] });
  }
}

function momentQuery() {
  return state.replay.on ? `&at=${Math.round(state.replay.sim)}` : '';
}

async function refreshService() {
  const request = ++state.serviceRequest;
  try {
    const res = await fetch(`/api/service?window=${state.window}${linesQuery()}${momentQuery()}`);
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    if (request !== state.serviceRequest) return;
    applyValues('roads', state.roadValues, data.roads);
    applyValues('areas', state.areaValues, data.areas);
    state.roadValues = data.roads;
    state.areaValues = data.areas;
  } catch (err) {
    console.warn('Service colouring not updated:', err.message);
  }
}

function ringColour(hex) {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  if (luminance >= 90) return hex;
  const mixed = channels.map((c) => Math.round(c + (255 - c) * 0.5));
  return `rgb(${mixed.join(',')})`;
}

function metresBetween(a, b) {
  const kx = 80500;
  const ky = 110574;
  return Math.hypot((a.lon - b.lon) * kx, (a.lat - b.lat) * ky);
}

function delayText(delay) {
  if (delay === null || delay === undefined) return '';
  const minutes = Math.round(Math.abs(delay) / 60);
  if (minutes === 0) return 'on time';
  return `${minutes} min ${delay > 0 ? 'late' : 'early'}`;
}

function busPopupHtml(v) {
  const status = {
    reported: `Reported position, ${v.age} s old${v.delay === null ? '' : `. ${delayText(v.delay)}`}`,
    live: `Live delay: ${delayText(v.delay)}`,
    scheduled: 'Timetable position; real position unknown',
  }[v.status];
  return `<div class="popup-title"><span class="popup-line" style="background:${v.color};color:${v.text}">${escapeHtml(v.short)}</span>${escapeHtml(v.headsign)}</div><div class="popup-sub">${status}</div>`;
}

function renderStatus(data) {
  const el = $('status');
  const failing = data.feeds.filter((f) => !f.ok);
  el.classList.toggle('warn', failing.length > 0);
  $('reported-count').textContent = data.reported ? `${data.reported} now` : 'none right now';
  if (data.vehicles.length === 0) {
    el.textContent = 'No buses running right now.';
    return;
  }
  if (state.liveOnly && data.reported + data.live === 0) {
    el.textContent = `No live buses right now. ${data.scheduled} scheduled are hidden.`;
    return;
  }
  const counts = `${data.reported ? `${data.reported} reported, ` : ''}${data.live} live, ${data.scheduled} scheduled`;
  if (failing.length) {
    el.textContent = `${counts}. ${failing.map((f) => f.label).join(' and ')} feed unavailable: showing timetable.`;
    return;
  }
  const age = Math.max(...data.feeds.map((f) => f.ageSeconds ?? 0));
  el.textContent = `${counts}. Live data ${age} s old.`;
}

async function refreshVehicles() {
  if (state.replay.on) return;
  try {
    const res = await fetch('/api/vehicles');
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    if (state.replay.on) return;
    const now = performance.now();
    const seen = new Set();
    for (const v of data.vehicles) {
      seen.add(v.id);
      const bus = state.buses.get(v.id);
      if (!bus) {
        state.buses.set(v.id, { ...v, fromLon: v.lon, fromLat: v.lat, toLon: v.lon, toLat: v.lat, start: now, shownLon: v.lon, shownLat: v.lat });
        continue;
      }
      // A reported position repeats until the next one arrives; let the glide finish.
      if (v.status === 'reported' && bus.status === 'reported' && bus.toLon === v.lon && bus.toLat === v.lat) {
        Object.assign(bus, v);
        continue;
      }
      const jump = metresBetween({ lon: bus.shownLon, lat: bus.shownLat }, v) > MAX_TWEEN_METRES;
      Object.assign(bus, v, {
        fromLon: jump ? v.lon : bus.shownLon,
        fromLat: jump ? v.lat : bus.shownLat,
        toLon: v.lon,
        toLat: v.lat,
        start: now,
        duration: v.status === 'reported' ? REPORTED_TWEEN_MS : VEHICLE_MS,
      });
    }
    for (const id of state.buses.keys()) if (!seen.has(id)) state.buses.delete(id);
    if (state.popupBusId) {
      const bus = state.buses.get(state.popupBusId);
      if (bus) state.popup.setHTML(busPopupHtml(bus));
      else state.popup.remove();
    }
    state.latestVehicles = data;
    renderStatus(data);
  } catch (err) {
    $('status').textContent = 'Lost contact with the local server. Retrying...';
    $('status').classList.add('warn');
  }
}

function drawBuses(now) {
  const features = [];
  const trails = [];
  for (const bus of state.buses.values()) {
    const r = reduceMotion ? 1 : Math.min(1, (now - bus.start) / (bus.duration ?? VEHICLE_MS));
    bus.shownLon = bus.fromLon + (bus.toLon - bus.fromLon) * r;
    bus.shownLat = bus.fromLat + (bus.toLat - bus.fromLat) * r;
    const scheduled = bus.status === 'scheduled';
    if (!state.selected.has(bus.line) || (state.liveOnly && scheduled && !state.replay.on)) {
      if (bus.id === state.popupBusId) state.popup.remove();
      continue;
    }
    if (bus.trail) {
      trails.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [...bus.trail, [bus.shownLon, bus.shownLat]] },
        properties: { colour: ringColour(bus.color) },
      });
    }
    features.push({
      type: 'Feature',
      id: features.length,
      geometry: { type: 'Point', coordinates: [bus.shownLon, bus.shownLat] },
      properties: {
        id: bus.id,
        short: bus.short,
        reported: bus.status === 'reported',
        fill: scheduled ? '#14171f' : bus.color,
        ring: scheduled ? ringColour(bus.color) : '#ffffff',
        label: scheduled ? '#ffffff' : bus.text,
        bearing: bus.bearing,
      },
    });
    if (bus.id === state.popupBusId) state.popup.setLngLat([bus.shownLon, bus.shownLat]);
  }
  map.getSource('buses').setData({ type: 'FeatureCollection', features });
  map.getSource('trails').setData({ type: 'FeatureCollection', features: trails });
}

const parisDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
const parisClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Same rule as the server: a service day runs from 03:00 to 03:00.
function serviceDateOf(ms) {
  return parisDay.format(ms - 3 * 3600 * 1000).replaceAll('-', '');
}

function shiftYmd(ymd, days) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + days));
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

function toInputValue(ms) {
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function lowerIndex(values, target) {
  let lo = 0;
  let hi = values.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= target) lo = mid;
    else hi = mid;
  }
  return lo;
}

function placeOnShape(shape, metres) {
  const i = lowerIndex(shape.m, metres);
  const [lon0, lat0] = shape.c[i];
  const [lon1, lat1] = shape.c[i + 1] ?? shape.c[i];
  const r = Math.min(1, Math.max(0, (metres - shape.m[i]) / (shape.m[i + 1] - shape.m[i] || 1)));
  const bearing = (Math.atan2((lon1 - lon0) * 0.7236, lat1 - lat0) * 180) / Math.PI;
  return { lon: lon0 + (lon1 - lon0) * r, lat: lat0 + (lat1 - lat0) * r, bearing: (bearing + 360) % 360 };
}

function loadReplayDay(date) {
  const replay = state.replay;
  if (replay.days.has(date) || replay.loading.has(date) || performance.now() < replay.retryAt) return;
  replay.loading.add(date);
  fetch(`/api/timetable?date=${date}`)
    .then((res) => {
      if (!res.ok) throw new Error(res.statusText);
      return res.json();
    })
    .then((day) => replay.days.set(date, day))
    .catch((err) => {
      console.warn('Timetable not loaded:', err.message);
      replay.retryAt = performance.now() + 5000;
    })
    .finally(() => replay.loading.delete(date));
}

function loadReplayShapes() {
  const replay = state.replay;
  if (replay.shapesRequested) return;
  replay.shapesRequested = true;
  fetch('/api/shapes')
    .then((res) => {
      if (!res.ok) throw new Error(res.statusText);
      return res.json();
    })
    .then((shapes) => {
      replay.shapes = shapes;
    })
    .catch((err) => {
      console.warn('Routes not loaded:', err.message);
      replay.shapesRequested = false;
    });
}

function replayedBuses(dates) {
  const replay = state.replay;
  const buses = new Map();
  for (const date of dates) {
    const day = replay.days.get(date);
    const t = (replay.sim - day.origin) / 1000;
    day.trips.forEach((trip, index) => {
      if (trip.t.length < 2 || t < trip.t[0] || t > trip.t[trip.t.length - 1]) return;
      const i = lowerIndex(trip.t, t);
      const metres = trip.d[i] + ((trip.d[i + 1] - trip.d[i]) * (t - trip.t[i])) / (trip.t[i + 1] - trip.t[i] || 1);
      const { lon, lat, bearing } = placeOnShape(replay.shapes[trip.s], metres);
      const line = state.lines[trip.l];
      const id = `${date}|${index}`;
      buses.set(id, {
        id,
        line: line.key,
        short: line.short,
        color: line.color,
        text: line.text,
        headsign: trip.h,
        status: 'scheduled',
        delay: null,
        age: null,
        trail: null,
        bearing: Math.round(bearing),
        fromLon: lon,
        fromLat: lat,
        toLon: lon,
        toLat: lat,
        start: -Infinity,
        shownLon: lon,
        shownLat: lat,
      });
    });
  }
  return buses;
}

function setStatusText(text, warn = false) {
  const el = $('status');
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('warn', warn);
}

function anyBusShown() {
  for (const bus of state.buses.values()) if (state.selected.has(bus.line)) return true;
  return false;
}

function skipToNextDeparture(now, dates, tomorrow) {
  const replay = state.replay;
  const loaded = [...dates, tomorrow].flatMap((date) => replay.days.get(date) ?? []);
  const next = nextDeparture(loaded, replay.sim, (trip) => state.selected.has(state.lines[trip.l].key));
  if (next === null || next - replay.sim < MIN_SKIP_MS) return;
  replay.sim = next + 1;
  replay.skipNote = `Skipped to ${parisClock.format(replay.sim)}: no buses until then.`;
  replay.skipNoteUntil = now + SKIP_NOTE_MS;
  state.buses = replayedBuses(dates.includes(serviceDateOf(replay.sim)) ? dates : [dates[1], tomorrow]);
}

function tickReplay(now) {
  const replay = state.replay;
  const elapsed = Math.min(now - replay.lastTick, 250);
  replay.lastTick = now;

  const today = serviceDateOf(replay.sim);
  const dates = [shiftYmd(today, -1), today];
  dates.forEach(loadReplayDay);
  loadReplayShapes();
  if (!replay.shapes || !dates.every((d) => replay.days.has(d))) {
    setStatusText('Loading the timetable...');
    return;
  }
  const tomorrow = shiftYmd(today, 1);
  loadReplayDay(tomorrow);
  const keep = new Set([...dates, tomorrow]);
  for (const date of replay.days.keys()) if (!keep.has(date)) replay.days.delete(date);

  if (replay.playing) replay.sim += elapsed * replay.speed;
  state.buses = replayedBuses(dates);
  if (replay.playing && replay.skipEmpty && !anyBusShown()) skipToNextDeparture(now, dates, tomorrow);
  if (state.popupBusId && !state.buses.has(state.popupBusId)) state.popup.remove();

  const clock = parisClock.format(replay.sim);
  if ($('replay-clock').textContent !== clock) {
    $('replay-clock').textContent = clock;
    if (document.activeElement !== $('replay-at')) $('replay-at').value = toInputValue(replay.sim);
  }
  const count = [...state.buses.values()].filter((bus) => state.selected.has(bus.line)).length;
  if (now < replay.skipNoteUntil) setStatusText(replay.skipNote);
  else setStatusText(count ? `Replay: ${count} ${count === 1 ? 'bus' : 'buses'} on the road.` : 'Replay: no buses in the timetable at this time.');

  const colourDue = now - replay.lastColour > 1000 && Math.abs(replay.sim - replay.lastColourSim) >= 30000;
  if (colourDue && !replay.colouring) {
    replay.lastColour = now;
    replay.lastColourSim = replay.sim;
    replay.colouring = true;
    refreshService().finally(() => {
      replay.colouring = false;
    });
  }
}

function setMode(mode) {
  const replay = state.replay;
  const on = mode === 'replay';
  if (on === replay.on) return;
  replay.on = on;
  document.querySelectorAll('#mode-choice button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  $('replay').hidden = !on;
  $('toggle-live-only').disabled = on;
  state.popup?.remove();
  state.buses = new Map();
  if (on) {
    replay.sim = replay.sim || Date.now();
    replay.lastTick = performance.now();
    replay.lastColourSim = -Infinity;
    $('replay-at').value = toInputValue(replay.sim);
  } else {
    setStatusText('Loading live buses...');
    refreshVehicles();
    refreshService();
  }
}

let lastFrame = 0;
function frame(now) {
  const frameGap = state.buses.size > BUSY_MAP_BUSES ? 66 : 33;
  if (!document.hidden && now - lastFrame > frameGap) {
    lastFrame = now;
    if (state.replay.on) tickReplay(now);
    drawBuses(now);
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
  drawBuses(performance.now());
  refreshService();
}

function bindControls() {
  $('window-choice').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-window]');
    if (!button || button.dataset.window === state.window) return;
    state.window = button.dataset.window;
    document.querySelectorAll('#window-choice button').forEach((b) => b.setAttribute('aria-checked', String(b === button)));
    applyColourScale();
    refreshService();
  });
  $('mode-choice').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-mode]');
    if (button) setMode(button.dataset.mode);
  });
  $('replay-play').addEventListener('click', (e) => {
    state.replay.playing = !state.replay.playing;
    e.target.textContent = state.replay.playing ? 'Pause' : 'Play';
  });
  $('replay-speed').addEventListener('change', (e) => {
    state.replay.speed = Number(e.target.value);
  });
  $('replay-skip').addEventListener('change', (e) => {
    state.replay.skipEmpty = e.target.checked;
  });
  $('replay-at').addEventListener('change', (e) => {
    const ms = new Date(e.target.value).getTime();
    if (Number.isNaN(ms)) return;
    state.replay.sim = ms;
    state.replay.lastColourSim = -Infinity;
  });
  $('toggle-roads').addEventListener('change', (e) => setVisible(['roads-casing', 'roads'], e.target.checked));
  $('toggle-areas').addEventListener('change', (e) => setVisible(['areas'], e.target.checked));
  $('toggle-buses').addEventListener('change', (e) => setVisible(['trails-casing', 'trails', 'bus-halos', 'bus-circles', 'bus-arrows', 'bus-labels'], e.target.checked));
  $('toggle-live-only').addEventListener('change', (e) => {
    state.liveOnly = e.target.checked;
    drawBuses(performance.now());
    if (state.latestVehicles) renderStatus(state.latestVehicles);
  });
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

function showPopup(lngLat, html, busId = null) {
  state.popup?.remove();
  state.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '280px', offset: busId ? 16 : 6 })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(map);
  state.popupBusId = busId;
  const popup = state.popup;
  popup.on('close', () => {
    if (state.popup === popup) state.popupBusId = null;
  });
}

async function showRoad(id, lngLat) {
  const res = await fetch(`/api/piece/${id}?window=${state.window}${linesQuery()}${momentQuery()}`);
  if (!res.ok) return;
  const detail = await res.json();
  const label = detail.total === 1 ? 'passage' : 'passages';
  const lines = detail.lines
    .map(
      (l) =>
        `<span><span class="popup-line" style="background:${l.color};color:${l.text}">${escapeHtml(l.short)}</span> ${l.count}</span>`,
    )
    .join('');
  showPopup(
    lngLat,
    `<div class="popup-title">${detail.total} ${label}</div><div class="popup-sub">${WINDOW_TEXT[state.window]}</div>${lines ? `<div class="popup-lines">${lines}</div>` : ''}`,
  );
}

function bindMapClicks() {
  const around = (p, r) => [
    [p.x - r, p.y - r],
    [p.x + r, p.y + r],
  ];
  map.on('click', (e) => {
    const bus = map.queryRenderedFeatures(around(e.point, 4), { layers: ['bus-circles'] })[0];
    if (bus) {
      const data = state.buses.get(bus.properties.id);
      if (data) showPopup([data.shownLon, data.shownLat], busPopupHtml(data), data.id);
      return;
    }
    const road = map.queryRenderedFeatures(around(e.point, 6), { layers: ['roads'] })[0];
    if (road) showRoad(road.id, e.lngLat);
  });
  map.on('mousemove', (e) => {
    const hit = map.queryRenderedFeatures(around(e.point, 6), { layers: ['bus-circles', 'roads'] });
    map.getCanvas().style.cursor = hit.length ? 'pointer' : '';
  });
}

function addLayers(network) {
  // Above every basemap road and building, below only the labels that follow them.
  const baseLayers = map.getStyle().layers;
  const lastShape = baseLayers.findLastIndex((l) => l.type !== 'symbol');
  const firstSymbol = baseLayers[lastShape + 1]?.id;
  map.addSource('areas', { type: 'geojson', data: network.areas, buffer: 8 });
  map.addSource('roads', { type: 'geojson', data: network.roads, buffer: 8, tolerance: 0.2 });
  map.addSource('buses', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addImage('bus-arrow', arrowImage());

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

  const trailLayout = { 'line-cap': 'round', 'line-join': 'round' };
  map.addLayer({
    id: 'trails-casing',
    type: 'line',
    source: 'trails',
    layout: trailLayout,
    paint: {
      'line-color': '#0a0c11',
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 12, 6, 15, 9],
    },
  });
  map.addLayer({
    id: 'trails',
    type: 'line',
    source: 'trails',
    layout: trailLayout,
    paint: {
      'line-color': ['get', 'colour'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 12, 3, 15, 5],
    },
  });
  map.addLayer({
    id: 'bus-arrows',
    type: 'symbol',
    source: 'buses',
    minzoom: 11,
    layout: {
      'icon-image': 'bus-arrow',
      'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.55, 14, 0.8],
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });
  map.addLayer({
    id: 'bus-halos',
    type: 'circle',
    source: 'buses',
    filter: ['get', 'reported'],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 7, 11, 12, 14, 17],
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
    },
  });
  map.addLayer({
    id: 'bus-circles',
    type: 'circle',
    source: 'buses',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 4, 11, 8, 14, 12],
      'circle-color': ['get', 'fill'],
      'circle-stroke-color': ['get', 'ring'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 12, 2.5],
    },
  });
  map.addLayer({
    id: 'bus-labels',
    type: 'symbol',
    source: 'buses',
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

async function start() {
  const loaded = new Promise((resolve) => map.once('load', resolve));
  const res = await fetch('/api/network');
  if (!res.ok) throw new Error('The network could not be loaded.');
  const network = await res.json();
  state.lines = network.lines;
  state.networks = network.networks;
  state.selected = new Set(state.lines.map((l) => l.key));
  const asInput = (ymd, time) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${time}`;
  $('replay-at').min = asInput(network.timetable.from, '00:00');
  $('replay-at').max = asInput(network.timetable.to, '23:59');

  await loaded;
  addLayers(network);
  applyColourScale();
  renderLines();
  bindControls();
  bindMapClicks();
  setMode('replay');

  await Promise.all([refreshService(), refreshVehicles()]);
  setInterval(refreshVehicles, VEHICLE_MS);
  setInterval(() => {
    if (!state.replay.on) refreshService();
  }, SERVICE_MS);
  requestAnimationFrame(frame);
}

start().catch((err) => {
  console.error(err);
  $('status').textContent = 'The map could not start. Is the local server running?';
  $('status').classList.add('warn');
});
