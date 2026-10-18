// Road-condition risk model. Scores 0–10 for one place at one hour, based on
// the forecast at that hour plus the hours leading up to it (a road that was
// wet and then drops below zero is the classic black-ice setup).
//
// This is a heuristic, not a road-surface model — it can't know about
// salting, ploughing or local cold spots. Treat it as "which day/time looks
// worse", then check Trafikverket before you leave.

const HOUR = 3600_000

export const LEVELS = [
  { max: 1.5, label: 'Good', color: '#22c55e', meaning: 'Above freezing and mostly dry. Normal driving.' },
  { max: 3.5, label: 'Watch', color: '#a3e635', meaning: 'Cold or near freezing in places. Slippery patches possible, keep an eye out.' },
  { max: 5.5, label: 'Caution', color: '#facc15', meaning: 'Frost, below-zero roads or fog likely somewhere. Winter tyres and extra care.' },
  { max: 7.5, label: 'Dangerous', color: '#f97316', meaning: 'Snow, sleet or a wet road refreezing (black ice) likely. Consider another day or time.' },
  { max: 11, label: 'Severe', color: '#ef4444', meaning: 'Freezing rain, rain on frozen roads or heavy snow. Avoid driving if you can.' },
]

export function level(score) {
  return LEVELS.find(l => score <= l.max)
}

// Nearest record within 3.5 h of t (series is sorted by t).
export function at(series, t) {
  if (!series?.length) return null
  let lo = 0
  let hi = series.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (series[mid].t < t) lo = mid + 1
    else hi = mid
  }
  const cands = [series[lo], series[lo - 1]].filter(Boolean)
  const best = cands.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a))
  return Math.abs(best.t - t) <= 3.5 * HOUR ? best : null
}

function between(series, from, to) {
  return series.filter(r => r.t >= from && r.t <= to)
}

const LIQUID = new Set(['rain', 'drizzle', 'sleet', 'freezing'])

// opts: { summerTires, isDay }
export function scoreHour(series, t, opts) {
  const h = at(series, t)
  if (!h || h.temp == null) return null

  const isDay = h.isDay ?? opts.isDay
  // Road surface: use the modelled ground-surface temperature when we have
  // it, otherwise assume the road runs a bit colder than the air at night.
  const road = h.surf != null ? Math.min(h.temp, h.surf) : h.temp - (isDay === false ? 1 : 0)
  const humid = h.dew != null && h.dew >= h.temp - 1.5

  const prior = between(series, t - 6 * HOUR, t - 1)
  const wetBefore = prior.some(r => r.precip >= 0.2 && LIQUID.has(r.ptype))
  const coldBefore = between(series, t - 12 * HOUR, t).some(r => r.temp != null && r.temp <= 0)

  const hits = [] // [score, reason]
  const p = h.precip ?? 0

  if (h.ptype === 'freezing' && p > 0) hits.push([10, 'Freezing rain'])
  if ((h.ptype === 'rain' || h.ptype === 'drizzle') && p >= 0.1 && (road <= 0 || (coldBefore && road <= 1)))
    hits.push([9, 'Rain on a frozen road'])
  if (h.ptype === 'snow' && p >= 1) hits.push([8, 'Heavy snow'])
  else if (h.ptype === 'snow' && p >= 0.1) hits.push([6, 'Snowfall'])
  if (h.ptype === 'sleet' && p >= 0.1) hits.push(road <= 1 ? [7, 'Sleet near freezing'] : [5, 'Sleet'])
  if (wetBefore && road <= 0.5) hits.push([7, 'Wet road refreezing — black ice'])
  if (road <= 0 && humid) hits.push([6, 'Frost on the road likely'])
  else if (road <= 0) hits.push([4, 'Below freezing'])
  else if (road <= 2) hits.push(humid ? [4, 'Near freezing, damp — slippery patches'] : [2, 'Near freezing'])
  else if (road <= 4) hits.push([1, 'Cold'])
  if (h.ptype === 'rain' && p >= 2) hits.push([3, 'Heavy rain'])
  if (h.gust >= 25) hits.push([6, 'Storm gusts'])
  else if (h.gust >= 20) hits.push([4, 'Strong gusts'])
  if (h.vis != null && h.vis < 300) hits.push([6, 'Dense fog'])
  else if (h.vis != null && h.vis < 1000) hits.push([4, 'Poor visibility'])

  if (opts.summerTires) {
    const wintry = hits.some(([s, r]) => s >= 6 && !/gust|fog|visibility/i.test(r))
    if (wintry) hits.push([10, 'Summer tyres in wintry conditions'])
    else if (road <= 4) hits.push([5, 'Summer tyres below +4 °C'])
  }

  let score = hits.reduce((m, [s]) => Math.max(m, s), 0)
  const reasons = hits
    .filter(([s]) => s >= 2)
    .sort((a, b) => b[0] - a[0])
    .map(([, r]) => r)
  if (score >= 3 && isDay === false) {
    score = Math.min(10, score + 1)
    reasons.push('Dark')
  }

  return { score, reasons: [...new Set(reasons)], temp: h.temp, road, precip: p, ptype: h.ptype, gust: h.gust }
}

// Scores every waypoint for one departure time.
// weather: { yr: [series per point], smhi: [...], … }; opts.sources picks
// which of them count.
export function scoreTrip(waypoints, weather, departure, opts) {
  const stops = waypoints.map((w, i) => {
    const eta = departure + w.driveSec * 1000 * opts.pace + Math.floor(w.driveSec / 7200) * opts.breakMin * 60_000
    const isDay = at(weather.om?.[i], eta)?.isDay
    const bySource = {}
    for (const src of opts.sources) {
      bySource[src] = scoreHour(weather[src]?.[i], eta, { ...opts, isDay })
    }
    const scores = Object.values(bySource).filter(Boolean).map(s => s.score)
    // Lean towards the most pessimistic source: when one model sees ice,
    // averaging it away would be misleading.
    const combined = scores.length
      ? (Math.max(...scores) + scores.reduce((a, b) => a + b, 0) / scores.length) / 2
      : null
    return { ...w, eta, bySource, combined }
  })

  const scored = stops.filter(s => s.combined != null)
  if (scored.length < stops.length * 0.7) return { stops, score: null, peak: null, mean: null }
  const peak = Math.max(...scored.map(s => s.combined))
  const mean = scored.reduce((a, s) => a + s.combined, 0) / scored.length
  return { stops, peak, mean, score: (peak + mean) / 2 }
}
