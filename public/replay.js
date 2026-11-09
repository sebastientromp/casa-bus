/** The first moment after `after` that a wanted trip sets off, or null if none is loaded. */
export function nextDeparture(days, after, isWanted) {
  let best = null;
  for (const day of days) {
    for (const trip of day.trips) {
      if (trip.t.length < 2 || !isWanted(trip)) continue;
      const at = day.origin + trip.t[0] * 1000;
      if (at > after && (best === null || at < best)) best = at;
    }
  }
  return best;
}
