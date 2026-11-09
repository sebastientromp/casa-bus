# Valbonne bus map

A map of the buses around Valbonne, with roads and areas coloured by how much bus service they get.

## Start it

Needs Node 22 or later.

```bash
npm install
npm start
```

Then open <http://localhost:5177>. The first start downloads the timetables, which takes a minute at most. The server only listens on this PC.

Timetables are refreshed when the server starts, if the saved copy is more than a day old. **Restart the server every few days** if you leave it running, or it will keep using old timetables.

## How to read the map

**Buses**

- **Reported (filled marker with an outer ring):** the position comes straight from a vehicle position feed, is less than 2 minutes old and matches a trip in the timetable. Lignes d'Azur and Palmbus publish these directly. ZOU!'s feed comes through the community service My Bus Finder and is often empty. They refresh every 30 s, and the marker glides between positions. Road and area colours still come from the timetable and delays.
- **Live (filled marker):** the timetable corrected with the delay the network reports, every 30 s. It's an estimate along the route, not a GPS fix.
- **Scheduled (hollow marker):** where the timetable says the bus should be. The real bus may be elsewhere. Networks that publish no usable live data are always in this state, and any other bus is too when its feed is down or has nothing for it.

Tick **Live buses only** to hide the scheduled ones. The line behind a reported or live bus is the stretch of route it covered in the last 2 minutes, which makes movement visible when the map is zoomed out.

Buses are drawn moving continuously. Stops at the same rounded minute are merged and dwell is left out, and when a delay changes, the bus eases to it by running up to 30% slower or faster. Only a change of more than 4 minutes makes it jump. So a marker can be slightly behind the delay in its popup, and it won't pause at stops.

**Replay**

The map opens in **Replay**, starting now at 5 minutes per second. Under *Time* you can set the date, time and speed, up to 1 hour per second (a week in under 3 minutes), or switch to **Live**. Buses and colours follow the timetable for that moment, so *Today so far* means that day so far. Replay has no real delays, and only covers the dates in the published timetables.

**Skip times with no buses**, on by default, jumps to the next departure when nothing would be on the map for at least 15 minutes, such as overnight. It follows your line selection, so with a single line chosen it also skips that line's long gaps.

**Colours**

Brighter means more bus passages. A passage counts once a bus's modelled position has crossed that stretch of road, so during the day the roads fill in as buses go by.

- *Today so far* counts since the start of today's service, which changes at 03:00.
- *Last hour* and *Full day* do what they say. Last hour has its own scale, since its numbers are much smaller.
- Lines sharing a road add up, in both directions.
- An area's score adds up the passages at stops within 400 m, with closer stops counting more.

## What's included

Every bus network in the Alpes-Maritimes (06) that publishes open data:

| Network | Area | Timetable | Live data |
|---|---|---|---|
| Lignes d'Azur, buses and trams (L1, L2, L3, B) | Nice Métropole | Yes | Vehicle positions and delays |
| Palmbus | Cannes | Yes | Vehicle positions and delays |
| Envibus | Sophia Antipolis | Yes | None published |
| Sillages, urban and school | Pays de Grasse | Yes, most trips without a published route | None published |
| Zest | Menton | Yes | Published, but its trip IDs don't match its timetable |
| ZOU! Proximité and Express | Region | Trips with a stop in the 06 | Delays, and vehicle positions when the feed has any |
| ZOU! Scolaire | Region | Trips with a stop in the 06 | None published |

Whole trips are kept, so a ZOU! bus coming from the Var stays on the map after it leaves the 06.

Where a trip has no published route, its bus moves in straight lines between stops. It's left out of the road colouring, but still counts for area colours.

Not included: on-demand services, trains, Envibus school services (not in the published timetable), Monaco's buses (outside the 06).

To add a network, or a live feed if one appears, add or edit its entry in `NETWORKS` in `server/gtfs.js`.

## Development

```bash
npm test
```

`RT_URL_OVERRIDE=<url>` replaces the delay feed address and `VEHICLES_URL_OVERRIDE=<url>` the vehicle position feed address, which is handy for testing. `PORT` changes the port.

Data: Envibus / CASA (ODbL); ZOU! / Région Sud, Lignes d'Azur, Palmbus, Zest and Sillages (Licence Ouverte 2.0); ZOU! vehicle positions via My Bus Finder; department boundary from france-geojson. Basemap: OpenFreeMap, OpenMapTiles, OpenStreetMap contributors.
