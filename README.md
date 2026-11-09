# Buses of the 06

A replay of every bus and tram timetable in the Alpes-Maritimes. Vehicles move across the map at the speed you choose, and roads and areas brighten with the number of passages.

It's a static site: everything runs in the visitor's browser, with no server. A build step turns the published timetables into data files.

## Run it on your PC

Needs Node 22 or later.

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Then open <http://localhost:5177>.

The build reuses timetables downloaded in the last 24 hours, and stops with an error if a network has no timetable at all, so a site is never published with one missing.

## Publish it for free

The site is whatever `npm run build` puts in `dist/`, so any static host works.

`.github/workflows/deploy.yml` publishes it on GitHub Pages:

1. Push this repository to GitHub. On a free GitHub plan it has to be public.
2. In the repository's *Settings > Pages*, set *Source* to *GitHub Actions*.
3. Push to `master`, or run the workflow by hand from the *Actions* tab.

It rebuilds every Monday to pick up new timetables. The map only knows the timetables from its last build, and shows that date in the panel.

## How to read the map

- Every vehicle is placed from the published timetable. It isn't a real position, and there are no delays.
- Vehicles move continuously: stops at the same rounded minute are merged and dwell is left out, so they don't pause at stops.
- The map opens at the current moment and runs at 5 minutes per second. Set the date, time and speed in the panel, up to 1 hour per second (a week in under 3 minutes).
- **Skip times with nothing running**, on by default, jumps to the next departure when nothing would be on the map for at least 15 minutes. It follows your line selection.

**Colours**

Brighter means more passages. A passage counts once a vehicle has crossed that stretch of road.

- *Day so far* counts since the start of the service day, which changes at 03:00.
- *Last hour* and *Full day* do what they say. Last hour has its own scale, since its numbers are much smaller.
- Lines sharing a road add up, in both directions.
- An area's score adds up the passages at stops within 400 m, with closer stops counting more.

## What's included

Every bus network in the 06 that publishes open data:

| Network | Area |
|---|---|
| Lignes d'Azur, buses and trams (L1, L2, L3, B) | Nice Métropole |
| Palmbus | Cannes |
| Envibus | Sophia Antipolis |
| Sillages, urban and school | Pays de Grasse |
| Zest | Menton |
| ZOU! Proximité, Express and Scolaire, trips with a stop in the 06 | Region |

Whole trips are kept, so a ZOU! bus coming from the Var stays on the map after it leaves the 06.

Where a trip has no published route, as with most of Sillages, the vehicle moves in straight lines between stops. It's left out of the road colouring, but still counts for area colours.

Not included: on-demand services, trains, Envibus school services (not in the published timetable), Monaco's buses (outside the 06).

To add a network, add its entry to `NETWORKS` in `build/gtfs.js`.

## Project layout

- `build/`: downloads the timetables and writes the data files. `npm start` also lives here, as a small preview server.
- `public/`: the page itself. `schedule.js` places the vehicles and `colouring.js`, run from `colour-worker.js`, works out the colours.

## Development

```bash
npm test
```

`PORT` changes the preview port.

Data: Envibus / CASA (ODbL); ZOU! / Région Sud, Lignes d'Azur, Palmbus, Zest and Sillages (Licence Ouverte 2.0); department boundary from france-geojson. Basemap: OpenFreeMap, OpenMapTiles, OpenStreetMap contributors.
