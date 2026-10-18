// Data fetching for the road weather planner. Every service here is free,
// key-less and CORS-enabled, so the page runs entirely in the browser.
//
//   Geocoding  – Photon (komoot), OpenStreetMap data, with Open-Meteo's
//                place search as a fallback. Photon also names the towns
//                along the route, with BigDataCloud as a fallback.
//   Routing    – OSRM public demo server
//   Weather    – MET Norway (the data behind yr.no), SMHI snow1g, and
//                Open-Meteo (its own blend plus ECMWF, DWD ICON, NOAA GFS)

const HOUR = 3600_000

// ── Geometry helpers ─────────────────────────────────────────────────────

export function haversineKm(a, b) {
  const R = 6371
  const toRad = d => (d * Math.PI) / 180
  const dLat = toRad(b[0] - a[0])
  const dLon = toRad(b[1] - a[1])
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

// ── Geocoding ────────────────────────────────────────────────────────────

function photonLabel(p) {
  const { name, city, county, state, country } = p.properties
  const parts = [name]
  if (city && city !== name) parts.push(city)
  else if (county && county !== name) parts.push(county)
  else if (state && state !== name) parts.push(state)
  if (country) parts.push(country)
  return parts.filter(Boolean).join(', ')
}

async function searchPhoton(query, signal) {
  // Bias towards the Nordics without excluding the rest of Europe.
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6&lat=62&lon=16&location_bias_scale=0.3`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error('Photon unavailable')
  const data = await res.json()
  return data.features.map(f => ({
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    name: f.properties.name,
    label: photonLabel(f),
  }))
}

// Towns and places only (no street addresses), but very reliable.
async function searchOpenMeteo(query, signal) {
  const res = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=sv`,
    { signal },
  )
  if (!res.ok) throw new Error('Place search failed')
  const data = await res.json()
  return (data.results ?? []).map(r => ({
    lat: r.latitude,
    lon: r.longitude,
    name: r.name,
    label: [r.name, r.admin2 !== r.name ? r.admin2 : null, r.country].filter(Boolean).join(', '),
  }))
}

export async function searchPlaces(query, signal) {
  try {
    const hits = await searchPhoton(query, signal)
    if (hits.length) return hits
  } catch (e) {
    if (e.name === 'AbortError') throw e
  }
  return searchOpenMeteo(query, signal)
}

const cleanName = n => n?.replace(/\s+(kommun|distrikt|socken|församling)$/i, '') || null

// Photon returns places nearest first. Prefer a town within `townKm` over
// a closer village, so the list reads Märsta rather than Rosersberg.
async function nearestPlace(lat, lon, tags, radiusKm, townKm = 0) {
  const filter = tags.map(t => `&osm_tag=place:${t}`).join('')
  const res = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&limit=10&radius=${radiusKm}${filter}`)
  if (!res.ok) throw new Error('Photon unavailable')
  const places = (await res.json()).features ?? []
  const town = places.find(
    f =>
      ['city', 'town'].includes(f.properties.osm_value) &&
      haversineKm([lat, lon], [f.geometry.coordinates[1], f.geometry.coordinates[0]]) <= townKm,
  )
  return cleanName((town ?? places[0])?.properties.name)
}

// Municipality-level fallback for when Photon is busy.
async function municipality(lat, lon) {
  const res = await fetch(
    `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=sv`,
  )
  const d = await res.json()
  // Keep "kommun": the genitive form ("Tierps kommun") can't be safely trimmed.
  return d.locality || d.city || null
}

// Name for a point: a town within 10 km, else the nearest village, else
// whatever settlement is closest. One request in the common case — Photon
// takes about a second.
export async function reverseGeocode(lat, lon) {
  try {
    return (
      (await nearestPlace(lat, lon, ['city', 'town', 'village'], 12, 10)) ||
      (await nearestPlace(lat, lon, ['hamlet', 'locality'], 15))
    )
  } catch {
    return municipality(lat, lon).catch(() => null)
  }
}

// ── Routing ──────────────────────────────────────────────────────────────

// A route as parallel arrays: coords, cumulative km and cumulative driving
// seconds per vertex.
function parseRoute(r) {
  const coords = r.geometry.coordinates.map(([lon, lat]) => [lat, lon])
  const durations = r.legs.flatMap(l => l.annotation.duration)
  const km = [0]
  const sec = [0]
  for (let i = 1; i < coords.length; i++) {
    km.push(km[i - 1] + haversineKm(coords[i - 1], coords[i]))
    sec.push(sec[i - 1] + (durations[i - 1] ?? 0))
  }
  return { coords, km, sec, totalKm: km.at(-1), totalSec: sec.at(-1) }
}

async function osrm(points, alternatives) {
  const path = points.map(p => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(';')
  const res = await fetch(
    `https://router.project-osrm.org/route/v1/driving/${path}` +
      `?overview=full&geometries=geojson&annotations=duration${alternatives ? '&alternatives=2' : ''}`,
  )
  if (!res.ok) throw new Error('Routing service failed — try again in a moment')
  const data = await res.json()
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No driving route found')
  return data.routes.map(parseRoute)
}

// Points every `stepKm` along a route.
function samples(route, stepKm) {
  const out = []
  for (let d = 0; d < route.totalKm; d += stepKm) out.push(route.coords[indexAtKm(route, d)])
  out.push(route.coords.at(-1))
  return out
}

// Share of route a's length that runs within 1.5 km of route b.
function overlap(a, b) {
  const pa = samples(a, 4)
  const pb = samples(b, 1)
  return pa.filter(p => pb.some(q => haversineKm(p, q) < 1.5)).length / pa.length
}

// A forced via point that lands on a dead end makes the route drive in and
// back out again. Spot that as two stretches far apart along the route that
// are almost on top of each other.
function hasDetour(route) {
  const pts = samples(route, 2)
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 4; j < pts.length; j++) if (haversineKm(pts[i], pts[j]) < 0.4) return true
  return false
}

const wait = ms => new Promise(r => setTimeout(r, ms))

// Up to `max` meaningfully different routes, fastest first. OSRM's own
// alternatives are used when it has them; otherwise we push the route
// sideways through via points and keep the results that are distinct and
// not much longer.
export async function fetchRoutes(from, to, max = 3, onProgress) {
  const routes = []
  const consider = r => {
    if (routes.length >= max) return
    if (routes.length && r.totalSec > routes[0].totalSec * 1.35) return
    if (routes.some(o => overlap(r, o) > 0.7 || overlap(o, r) > 0.7)) return
    if (hasDetour(r)) return
    routes.push(r)
  }
  ;(await osrm([from, to], true)).forEach(consider)

  const base = routes[0]
  const straight = haversineKm([from.lat, from.lon], [to.lat, to.lon])
  if (straight < 30) return routes // short trips: alternatives aren't worth it

  // Perpendicular to the overall direction of travel (flat-earth is fine here).
  const kx = Math.cos((((from.lat + to.lat) / 2) * Math.PI) / 180)
  const dx = (to.lon - from.lon) * kx
  const dy = to.lat - from.lat
  const len = Math.hypot(dx, dy)
  const perp = [dx / len, -dy / len] // [north, east] unit vector, rotated 90°

  const tries = [
    [0.5, 0.2], [0.5, -0.2], [0.5, 0.35], [0.5, -0.35],
    [0.35, 0.2], [0.35, -0.2], [0.65, 0.2], [0.65, -0.2],
  ]
  for (const [frac, side] of tries) {
    if (routes.length >= max) break
    onProgress?.(`Looking for alternative routes (${routes.length} found)…`)
    const [lat0, lon0] = base.coords[indexAtKm(base, base.totalKm * frac)]
    const offKm = straight * side
    const via = { lat: lat0 + (perp[0] * offKm) / 111, lon: lon0 + (perp[1] * offKm) / (111 * kx) }
    try {
      await wait(1000) // the OSRM demo server asks for at most ~1 request a second
      const [r] = await osrm([from, via, to], false)
      consider(r)
    } catch {
      // via point in the sea or similar — skip it
    }
  }
  return routes
}

// Index of the first vertex at or past `targetKm`.
function indexAtKm(route, targetKm) {
  let lo = 0
  let hi = route.km.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (route.km[mid] < targetKm) lo = mid + 1
    else hi = mid
  }
  return lo
}

// ── Places along the route ───────────────────────────────────────────────

// Evenly spaced points on the road itself (that's where the weather
// matters). Only start and end are named; see nameWaypoints.
export function sampleWaypoints(route, from, to, spacingKm) {
  const segments = Math.max(1, Math.round(route.totalKm / spacingKm))
  const step = route.totalKm / segments
  const waypoints = []
  for (let n = 0; n <= segments; n++) {
    const idx = n === segments ? route.coords.length - 1 : indexAtKm(route, n * step)
    const [lat, lon] = route.coords[idx]
    waypoints.push({ lat, lon, km: route.km[idx], driveSec: route.sec[idx], name: null })
  }
  waypoints[0].name = from.name
  waypoints.at(-1).name = to.name
  return waypoints
}

// Names each point after the nearest town. Returns a new array; onUpdate
// gets the partly named list as names arrive.
export async function nameWaypoints(waypoints, onUpdate) {
  // A handful at a time — Photon is a shared free service. Names are cached
  // per ~5 km cell, so routes that share road share lookups.
  const names = waypoints.map(w => w.name)
  const build = done =>
    waypoints.map((w, i) => {
      let name = names[i] ?? (done ? `Km ${Math.round(w.km)}` : null)
      // Two points named after the same town: label the second by distance.
      if (name && i > 0 && names[i] === names[i - 1]) name = `${name} (km ${Math.round(w.km)})`
      return { ...w, name }
    })
  let pending = 0
  await limited(waypoints, 5, async (w, i) => {
    if (w.name) return
    const key = cellKey(w)
    if (!nameCache.has(key)) nameCache.set(key, reverseGeocode(w.lat, w.lon))
    names[i] = await nameCache.get(key)
    if (onUpdate && ++pending % 4 === 0) onUpdate(build(false))
  })
  return build(true)
}

// Name of the place on `waypoints` that lies farthest from `base` — what
// makes this route different ("via Sollefteå").
export function viaName(waypoints, base) {
  const pts = samples(base, 2)
  let best = null
  let bestDist = 0
  for (const w of waypoints) {
    const d = Math.min(...pts.map(p => haversineKm([w.lat, w.lon], p)))
    if (d > bestDist) {
      bestDist = d
      best = w
    }
  }
  return best && bestDist > 3 ? best.name?.replace(/ \(km \d+\)$/, '') : null
}

// ── Weather ──────────────────────────────────────────────────────────────
// Each source is normalised to a sorted series of hourly-ish records:
//   { t, temp, dew, surf, precip (mm/h), ptype, gust, vis (m), isDay }
// ptype ∈ 'none' | 'rain' | 'drizzle' | 'sleet' | 'snow' | 'freezing'

function dewPoint(temp, rh) {
  if (temp == null || rh == null || rh <= 0) return null
  const a = 17.62
  const b = 243.12
  const g = Math.log(rh / 100) + (a * temp) / (b + temp)
  return (b * g) / (a - g)
}

async function limited(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = await fn(items[i], i)
      } catch {
        results[i] = null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

// MET throttles bursts (and the throttled reply has no CORS header, so it
// shows up as a network error). Back off and try again a couple of times.
async function retry(fn, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= tries - 1) throw e
      await wait(1500 * (i + 1))
    }
  }
}

function openMeteoPtype(code, rain, snow) {
  if ([56, 57, 66, 67].includes(code)) return 'freezing'
  if (snow > 0 && rain > 0) return 'sleet'
  if (snow > 0 || [71, 73, 75, 77, 85, 86].includes(code)) return 'snow'
  if ([51, 53, 55].includes(code)) return 'drizzle'
  if (rain > 0 || [61, 63, 65, 80, 81, 82, 95].includes(code)) return 'rain'
  return 'none'
}

const OM_MODELS = { om: 'best_match', ecmwf: 'ecmwf_ifs025', icon: 'icon_seamless', gfs: 'gfs_seamless' }

// One request per batch of points; every Open-Meteo model comes back at once.
async function fetchOpenMeteo(points) {
  const vars = [
    'temperature_2m', 'dew_point_2m', 'soil_temperature_0cm', 'precipitation', 'rain', 'showers',
    'snowfall', 'weather_code', 'wind_gusts_10m', 'visibility', 'is_day',
  ]
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${points.map(p => p.lat.toFixed(4)).join(',')}` +
    `&longitude=${points.map(p => p.lon.toFixed(4)).join(',')}` +
    `&hourly=${vars.join(',')}&models=${Object.values(OM_MODELS).join(',')}` +
    `&wind_speed_unit=ms&timeformat=unixtime&forecast_days=12&past_days=1`
  const res = await fetch(url)
  if (!res.ok) throw new Error('Open-Meteo failed')
  let data = await res.json()
  if (!Array.isArray(data)) data = [data]
  return data.map(d => {
    const h = d.hourly
    const isDay = h.is_day_best_match ?? []
    return Object.fromEntries(
      Object.entries(OM_MODELS).map(([id, model]) => {
        const v = name => h[`${name}_${model}`] ?? []
        const [temp, dew, surf, precip, rain, showers, snowfall, code, gust, vis] = [
          'temperature_2m', 'dew_point_2m', 'soil_temperature_0cm', 'precipitation', 'rain', 'showers',
          'snowfall', 'weather_code', 'wind_gusts_10m', 'visibility',
        ].map(v)
        const series = h.time
          .map((t, i) => {
            const p = precip[i] ?? 0
            const liquid = (rain[i] ?? 0) + (showers[i] ?? 0)
            return {
              t: t * 1000,
              temp: temp[i],
              dew: dew[i],
              surf: surf[i],
              precip: p,
              ptype: p > 0 ? openMeteoPtype(code[i], liquid, snowfall[i] ?? 0) : 'none',
              gust: gust[i],
              vis: vis[i],
              isDay: isDay[i] == null ? null : isDay[i] === 1,
            }
          })
          .filter(r => r.temp != null)
        return [id, series.length ? series : null]
      }),
    )
  })
}

function metPtype(symbol) {
  if (!symbol) return 'none'
  if (symbol.includes('sleet')) return 'sleet'
  if (symbol.includes('snow')) return 'snow'
  if (symbol.includes('rain')) return 'rain'
  return 'none'
}

// MET Norway Locationforecast — the forecast shown on yr.no.
async function fetchMet(p) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}`
  const data = await retry(async () => {
    const res = await fetch(url)
    if (!res.ok) throw new Error('MET failed')
    return res.json()
  })
  return data.properties.timeseries.map(ts => {
    const inst = ts.data.instant.details
    const next = ts.data.next_1_hours ?? ts.data.next_6_hours
    const hours = ts.data.next_1_hours ? 1 : 6
    const precip = (next?.details?.precipitation_amount ?? 0) / hours
    return {
      t: Date.parse(ts.time),
      temp: inst.air_temperature,
      dew: inst.dew_point_temperature ?? dewPoint(inst.air_temperature, inst.relative_humidity),
      surf: null,
      precip,
      ptype: precip > 0 ? metPtype(next?.summary?.symbol_code) : 'none',
      gust: inst.wind_speed_of_gust ?? null,
      vis: inst.fog_area_fraction > 50 ? 500 : null,
      isDay: null,
    }
  })
}

// SMHI ptype follows the ECMWF precipitation type table.
function smhiPtype(code, frozenPart) {
  switch (code) {
    case 0: return 'none'
    case 1: return frozenPart > 30 ? 'sleet' : 'rain'
    case 3: case 12: return 'freezing'
    case 5: case 6: case 8: case 9: return 'snow'
    case 7: return 'sleet'
    case 11: return 'drizzle'
    default: return 'rain'
  }
}

async function fetchSmhi(p) {
  const res = await fetch(
    `https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1/geotype/point/lon/${p.lon.toFixed(4)}/lat/${p.lat.toFixed(4)}/data.json`,
  )
  if (!res.ok) throw new Error('SMHI failed') // outside SMHI's area (roughly the Nordics)
  const data = await res.json()
  return data.timeSeries.map(ts => {
    const d = ts.data
    const t = Date.parse(ts.time)
    const start = ts.intervalParametersStartTime ? Date.parse(ts.intervalParametersStartTime) : t - HOUR
    const hours = Math.max(1, (t - start) / HOUR)
    const ok = v => (v == null || v === 9999 ? null : v)
    const precip = (ok(d.precipitation_amount_mean) ?? 0) / hours
    return {
      t,
      temp: ok(d.air_temperature),
      dew: dewPoint(ok(d.air_temperature), ok(d.relative_humidity)),
      surf: null,
      precip,
      ptype: precip > 0 ? smhiPtype(d.predominant_precipitation_type_at_surface, d.precipitation_frozen_part) : 'none',
      gust: ok(d.wind_speed_of_gust),
      vis: ok(d.visibility_in_air) != null ? d.visibility_in_air * 1000 : null,
      isDay: null,
    }
  })
}

export const SOURCES = [
  { id: 'yr', label: 'Yr', full: 'Yr / MET Norway', note: 'Norwegian Met Institute, about 9 days ahead', on: true },
  { id: 'smhi', label: 'SMHI', full: 'SMHI', note: 'Swedish Met Institute, about 10 days, Nordics only', on: true },
  { id: 'om', label: 'OM', full: 'Open-Meteo', note: 'Best local model blend, has road-surface temperature', on: true },
  { id: 'ecmwf', label: 'ECMWF', full: 'ECMWF', note: 'European centre, via Open-Meteo', on: false },
  { id: 'icon', label: 'ICON', full: 'DWD ICON', note: 'German weather service, via Open-Meteo', on: false },
  { id: 'gfs', label: 'GFS', full: 'NOAA GFS', note: 'US weather service, via Open-Meteo', on: false },
]

// Points closer than ~5 km share one forecast, and forecasts are kept for
// the session, so alternative routes and re-runs cost little.
const nameCache = new Map()
const cellKey = p => `${(Math.round(p.lat * 20) / 20).toFixed(2)},${(Math.round(p.lon * 20) / 20).toFixed(2)}`
const cache = new Map() // cellKey → Promise<{ yr, smhi, om, ecmwf, icon, gfs }>

// Returns { yr: [series per point], smhi: [...], om: [...], … }; a missing
// source for a point is null.
export async function fetchWeather(points) {
  const missing = [...new Map(points.filter(p => !cache.has(cellKey(p))).map(p => [cellKey(p), p])).values()]
  if (missing.length) {
    const batches = []
    for (let i = 0; i < missing.length; i += 20) batches.push(missing.slice(i, i + 20))
    const om = Promise.all(batches.map(b => fetchOpenMeteo(b).catch(() => b.map(() => ({}))))).then(r => r.flat())
    const yr = limited(missing, 3, fetchMet)
    const smhi = limited(missing, 4, fetchSmhi)
    const all = Promise.all([om, yr, smhi])
    missing.forEach((p, i) => {
      cache.set(
        cellKey(p),
        all.then(([o, y, s]) => ({ ...o[i], yr: y[i], smhi: s[i] })),
      )
    })
    // Don't keep failures around for the next run.
    all.catch(() => missing.forEach(p => cache.delete(cellKey(p))))
  }
  const perPoint = await Promise.all(points.map(p => cache.get(cellKey(p))))
  return Object.fromEntries(SOURCES.map(s => [s.id, perPoint.map(w => w?.[s.id] ?? null)]))
}
