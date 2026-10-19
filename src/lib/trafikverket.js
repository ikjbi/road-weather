// Live road status from Trafikverket's open API (Swedish roads only):
// measured road temperatures at the road weather stations, the road
// condition reports (slippery, ice, snow) and incidents such as accidents
// and roadworks. Unlike the forecasts this is what is happening right now.
//
// It needs a free key from https://data.trafikverket.se/get-started. Set it
// as VITE_TRAFIKVERKET_KEY when building, or paste one into the page.

import { haversineKm } from './api'

const URL = 'https://api.trafikinfo.trafikverket.se/v2/data.json'
const KEY_STORE = 'roadweather:trafikverket-key'

export const BUILT_IN_KEY = import.meta.env?.VITE_TRAFIKVERKET_KEY || ''

export function storedKey() {
  try {
    return localStorage.getItem(KEY_STORE) || ''
  } catch {
    return ''
  }
}

export function storeKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORE, key)
    else localStorage.removeItem(KEY_STORE)
  } catch {
    // private mode — the key lasts for this visit only
  }
}

// ── Swedish → English ────────────────────────────────────────────────────

export const CONDITION = {
  1: 'Normal',
  2: 'Difficult',
  3: 'Very difficult',
  4: 'Ice and snow on the road',
}

const WORDS = {
  // Warnings
  'Risk för halka': 'risk of slippery road',
  Halka: 'slippery',
  Snörök: 'snow spray',
  Snödrev: 'drifting snow',
  'Hård vind': 'strong wind',
  Snöfall: 'snowfall',
  // Causes
  Dimma: 'fog',
  'Fallande temperatur': 'falling temperature',
  Frost: 'frost',
  Regn: 'rain',
  Smältvatten: 'meltwater',
  'Underkylt regn': 'freezing rain',
  // Measures taken
  'Förebyggande halkbekämpning': 'preventive salting',
  Halkbekämpning: 'salted or gritted',
  Ishyvling: 'ice planed',
  Plogning: 'ploughed',
  Sandning: 'sanded',
  Annat: 'other',
}

const MESSAGE_TYPES = {
  Olycka: 'Accident',
  Hinder: 'Obstruction',
  Vägarbete: 'Roadworks',
  Restriktion: 'Restriction',
  Trafikmeddelande: 'Traffic message',
  'Viktig trafikinformation': 'Important traffic information',
  Färjor: 'Ferries',
}

// Finer-grained than the message type; these read better as the label.
const MESSAGE_CODES = {
  'Djur på vägen': 'Animals on the road',
  Körfältsavstängningar: 'Lane closures',
  Beläggningsarbete: 'Resurfacing',
  Sprängningsarbete: 'Blasting',
}
// Standing notices with no news in them.
const SKIP_CODES = ['Hastighetsbegränsning gäller', 'Omkörning förbjuden']

const PRECIPITATION = {
  rain: 'rain',
  freezing_rain: 'freezing rain',
  snow: 'snow',
  sleet: 'sleet',
  yes: 'precipitation',
}

// Entries can carry a time after the phrase ("Förebyggande halkbekämpning
// 19 okt. 03:00-20 okt. 00:00"): translate the phrase, keep the time.
const translate = w => {
  if (WORDS[w]) return WORDS[w]
  const phrase = Object.keys(WORDS)
    .sort((a, b) => b.length - a.length)
    .find(k => w.startsWith(`${k} `))
  return phrase ? `${WORDS[phrase]} (${w.slice(phrase.length).trim()})` : w
}
const en = list => (list ?? []).map(translate)

// ── Geometry ─────────────────────────────────────────────────────────────

// "POINT (18.06 59.33)", "LINESTRING (…)", "MULTILINESTRING ((…))" → [[lat, lon]]
function parseWkt(wkt) {
  const nums = (wkt ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
  const out = []
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i + 1], nums[i]])
  return out
}

// The route as flat segments (km east/north), for distance-to-line checks.
function routeTrack(route) {
  const lat0 = (route.coords[0][0] * Math.PI) / 180
  const flat = ([lat, lon]) => [lon * 111.32 * Math.cos(lat0), lat * 110.57]
  const pts = route.coords.map(flat)
  const segs = []
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i]
    const [bx, by] = pts[i + 1]
    segs.push({ ax, ay, bx, by, km: route.km[i], len: route.km[i + 1] - route.km[i], minY: Math.min(ay, by), maxY: Math.max(ay, by) })
  }
  return { flat, segs }
}

// Nearest point on the route within maxKm: { dist, km } (dist Infinity if
// none is that close).
function locate({ flat, segs }, p, maxKm = 5) {
  const [x, y] = flat(p)
  let best = { dist: maxKm, km: 0 }
  for (const s of segs) {
    // Cheap reject: more than the best distance so far north or south.
    if (y < s.minY - best.dist || y > s.maxY + best.dist) continue
    const dx = s.bx - s.ax
    const dy = s.by - s.ay
    const t = dx || dy ? Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / (dx * dx + dy * dy))) : 0
    const d = Math.hypot(x - (s.ax + t * dx), y - (s.ay + t * dy))
    if (d <= best.dist) best = { dist: d, km: s.km + t * s.len, hit: true }
  }
  return best.hit ? { dist: best.dist, km: best.km } : { dist: Infinity, km: 0 }
}

// How much of a line runs along the route: { km, shared } where km is
// where it starts on the route and shared is how many km of it lie within
// 250 m of the road. A road that merely crosses the route shares about
// half a kilometre, one that runs along it shares its whole length.
function alongRoute(track, points) {
  const STEP = 0.25
  let shared = 0
  let length = 0
  let km = Infinity
  const check = p => {
    const hit = locate(track, p, 0.25)
    if (hit.dist <= 0.25) {
      shared += STEP
      km = Math.min(km, hit.km)
    }
  }
  if (points.length === 1) {
    check(points[0])
    return { km, shared, length: 0 }
  }
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]]
    const len = haversineKm(a, b)
    length += len
    const steps = Math.min(400, Math.max(1, Math.round(len / STEP)))
    for (let s = 0; s < steps; s++) check([a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps])
  }
  return { km, shared, length }
}

// On the route: a point right on the road, or a line with at least 1 km
// of it (or most of a short one) along the road.
const onRoute = ({ shared, length }) => (length === 0 ? shared > 0 : shared >= Math.min(1, length * 0.6))

// Boxes around ~80 km stretches of the route, so a long trip asks for a
// corridor rather than half of Sweden.
function corridor(route) {
  const boxes = []
  for (let from = 0; from < route.totalKm; from += 80) {
    const part = route.coords.filter((_, i) => route.km[i] >= from - 1 && route.km[i] <= from + 81)
    if (!part.length) continue
    const lats = part.map(p => p[0])
    const lons = part.map(p => p[1])
    boxes.push([Math.min(...lons) - 0.15, Math.min(...lats) - 0.08, Math.max(...lons) + 0.15, Math.max(...lats) + 0.08])
  }
  return boxes
}

function within(field, boxes) {
  const parts = boxes.map(
    ([x1, y1, x2, y2]) =>
      `<WITHIN name="${field}" shape="box" value="${x1.toFixed(4)} ${y1.toFixed(4)}, ${x2.toFixed(4)} ${y2.toFixed(4)}"/>`,
  )
  return parts.length > 1 ? `<OR>${parts.join('')}</OR>` : parts[0]
}

const include = fields => fields.map(f => `<INCLUDE>${f}</INCLUDE>`).join('')

// ── The request ──────────────────────────────────────────────────────────

const STATION_FIELDS = [
  'Id',
  'Name',
  'Geometry.WGS84',
  'Observation.Sample',
  'Observation.Air.Temperature.Value',
  'Observation.Air.VisibleDistance.Value',
  'Observation.Surface.Temperature.Value',
  'Observation.Surface.Ice',
  'Observation.Surface.Snow',
  'Observation.Surface.Water',
  'Observation.Weather.Precipitation',
]

const CONDITION_FIELDS = [
  'Id',
  'ConditionCode',
  'ConditionText',
  'Warning',
  'Cause',
  'Measurement',
  'LocationText',
  'RoadNumber',
  'StartTime',
  'EndTime',
  'Geometry.WGS84',
]

const DEVIATION_FIELDS = [
  'Deviation.Id',
  'Deviation.Header',
  'Deviation.Message',
  'Deviation.MessageCode',
  'Deviation.MessageType',
  'Deviation.SeverityCode',
  'Deviation.SeverityText',
  'Deviation.RoadNumber',
  'Deviation.LocationDescriptor',
  'Deviation.StartTime',
  'Deviation.EndTime',
  'Deviation.WebLink',
  'Deviation.Geometry.Point.WGS84',
  'Deviation.Geometry.Line.WGS84',
]

export class KeyError extends Error {}

// Everything Trafikverket knows about the road near `route`, in driving
// order. Throws KeyError if the key is missing or rejected.
export async function fetchRoadReport(route, key) {
  if (!key) throw new KeyError('No Trafikverket key')
  const track = routeTrack(route)
  const boxes = corridor(route)
  const body =
    `<REQUEST><LOGIN authenticationkey="${key.replace(/[^\w-]/g, '')}"/>` +
    `<QUERY objecttype="WeatherMeasurepoint" schemaversion="2.1">` +
    `<FILTER><EQ name="Deleted" value="false"/>${within('Geometry.WGS84', boxes)}</FILTER>${include(STATION_FIELDS)}</QUERY>` +
    `<QUERY objecttype="RoadCondition" schemaversion="1.2">` +
    `<FILTER><EQ name="Deleted" value="false"/>${within('Geometry.WGS84', boxes)}</FILTER>${include(CONDITION_FIELDS)}</QUERY>` +
    `<QUERY objecttype="Situation" namespace="road.trafficinfo" schemaversion="1.6">` +
    `<FILTER><EQ name="Deleted" value="false"/>${within('Deviation.Geometry.Point.WGS84', boxes)}</FILTER>${include(DEVIATION_FIELDS)}</QUERY>` +
    `</REQUEST>`

  const res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body })
  const data = await res.json().catch(() => null)
  const results = data?.RESPONSE?.RESULT ?? []
  const error = results.find(r => r.ERROR)?.ERROR
  if (res.status === 401 || error?.SOURCE === 'Security') throw new KeyError('Trafikverket did not accept the key')
  if (!res.ok || error) throw new Error(error?.MESSAGE || 'Trafikverket is not answering right now')

  const now = Date.now()
  const [stationsRaw = [], conditionsRaw = [], situations = []] = [
    results.find(r => r.WeatherMeasurepoint)?.WeatherMeasurepoint,
    results.find(r => r.RoadCondition)?.RoadCondition,
    results.find(r => r.Situation)?.Situation,
  ]

  const stations = stationsRaw
    .map(s => {
      const o = s.Observation ?? {}
      const sample = o.Sample ? Date.parse(o.Sample) : NaN
      const where = locate(track, parseWkt(s.Geometry?.WGS84)[0] ?? [0, 0])
      return {
        id: s.Id,
        name: s.Name,
        ...where,
        sample,
        road: o.Surface?.Temperature?.Value ?? null,
        air: o.Air?.Temperature?.Value ?? null,
        visibility: o.Air?.VisibleDistance?.Value ?? null,
        ice: !!o.Surface?.Ice,
        snow: !!o.Surface?.Snow,
        wet: !!o.Surface?.Water,
        precip: PRECIPITATION[o.Weather?.Precipitation] ?? null,
      }
    })
    // Within 5 km of the road, and measured in the last two hours.
    .filter(s => s.dist <= 5 && now - s.sample < 2 * 3600_000 && (s.road != null || s.air != null))
    .sort((a, b) => a.km - b.km)

  const conditions = conditionsRaw
    .map(c => ({
      id: c.Id,
      code: c.ConditionCode ?? 1,
      text: CONDITION[c.ConditionCode] ?? c.ConditionText,
      warnings: en(c.Warning),
      causes: en(c.Cause),
      measures: en(c.Measurement),
      road: c.RoadNumber,
      location: c.LocationText,
      until: c.EndTime ? Date.parse(c.EndTime) : null,
      ...alongRoute(track, parseWkt(c.Geometry?.WGS84)),
    }))
    .filter(c => c.code >= 2 && onRoute(c) && (c.until == null || c.until > now))
    .sort((a, b) => a.km - b.km)

  const incidents = situations
    .flatMap(s => s.Deviation ?? [])
    .map(d => ({
      id: d.Id,
      type: MESSAGE_CODES[d.MessageCode] ?? MESSAGE_TYPES[d.MessageType] ?? d.MessageType ?? 'Traffic message',
      code: d.MessageCode,
      roadworks: d.MessageType === 'Vägarbete' || d.MessageCode === 'Körfältsavstängningar',
      header: d.Header,
      message: d.Message,
      severity: d.SeverityCode ?? 0,
      road: d.RoadNumber,
      location: d.LocationDescriptor,
      start: d.StartTime ? Date.parse(d.StartTime) : null,
      end: d.EndTime ? Date.parse(d.EndTime) : null,
      upcoming: d.StartTime ? Date.parse(d.StartTime) > now : false,
      link: d.WebLink,
      ...alongRoute(track, parseWkt(d.Geometry?.Line?.WGS84 ?? d.Geometry?.Point?.WGS84)),
    }))
    .filter(
      d =>
        onRoute(d) &&
        d.type !== 'Ferries' &&
        !SKIP_CODES.includes(d.code) &&
        // Current, or starting within two days.
        (d.end == null || d.end > now) &&
        (d.start == null || d.start < now + 48 * 3600_000),
    )
    // One event is often published twice (as roadworks and as a traffic
    // message) — keep the first.
    .filter((d, i, all) => all.findIndex(x => x.id === d.id || (x.message && x.message === d.message)) === i)
    .sort((a, b) => a.km - b.km)

  return { stations, conditions, incidents, fetchedAt: now }
}
