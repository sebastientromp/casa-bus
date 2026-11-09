// Works out the road and area colours away from the page, so the animation never waits for it.
import { buildDayEvents, decodeAreas, decodeVisits, pieceDetail, score, windowRange } from './colouring.js';
import { dayOf, decodeTimetable, loadGz, serviceDateOf } from './schedule.js';

const MAX_DAYS = 2;
const days = new Map();
const profileCache = new Map();
let data = null;
let ready = null;

function eventsFor(at) {
  const date = serviceDateOf(at);
  if (!days.has(date)) {
    if (days.size >= MAX_DAYS) days.delete(days.keys().next().value);
    days.set(date, buildDayEvents(data.timetable, data.visits, dayOf(data.timetable, date), profileCache));
  }
  return days.get(date);
}

function optionsFor(message, events) {
  const seconds = (message.at - events.origin) / 1000;
  let lines = null;
  if (message.lines) {
    lines = new Uint8Array(data.lineCount);
    for (const line of message.lines) lines[line] = 1;
  }
  return { ...windowRange(message.window, seconds), lines };
}

async function load({ version, counts, lineCount }) {
  const query = `?v=${version}`;
  const [timetable, visits, areas] = await Promise.all(
    ['timetable', 'visits', 'areas'].map((name) => loadGz(`data/${name}.json.gz${query}`)),
  );
  data = { timetable: decodeTimetable(timetable), visits: decodeVisits(visits), areas: decodeAreas(areas), counts, lineCount };
}

self.onmessage = async ({ data: message }) => {
  try {
    if (message.type === 'init') {
      ready = load(message);
      await ready;
      self.postMessage({ type: 'ready' });
      return;
    }
    await ready;
    const events = eventsFor(message.at);
    const options = optionsFor(message, events);
    if (message.type === 'score') {
      const { roads, areas } = score(events, data.areas, data.counts, options);
      self.postMessage({ type: 'score', roads, areas }, [roads.buffer, areas.buffer]);
    } else if (message.type === 'piece') {
      self.postMessage({ type: 'piece', request: message.request, detail: pieceDetail(events, message.piece, options) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
