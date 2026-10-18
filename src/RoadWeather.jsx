import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import RouteMap from './lib/RouteMap'
import { letter, ROUTE_COLORS } from './lib/letter'
import {
  fetchRoutes, fetchWeather, nameWaypoints, reverseGeocode, sampleWaypoints, searchPlaces, SOURCES, viaName,
} from './lib/api'
import { LEVELS, level, scoreTrip } from './lib/risk'

const STORE_KEY = 'roadweather:v1'
const DAY_COUNT = 10

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) ?? {}
  } catch {
    return {}
  }
}

function save(value) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(value))
  } catch {
    // private mode — nothing to remember
  }
}

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function upcomingDays() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Array.from({ length: DAY_COUNT }, (_, i) => {
    const d = new Date(today)
    d.setDate(today.getDate() + i)
    return d
  })
}

const fmtDay = d => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
const fmtTime = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const fmtWeekdayTime = t =>
  new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
const fmtDuration = sec => `${Math.floor(sec / 3600)} h ${String(Math.round((sec % 3600) / 60)).padStart(2, '0')} min`
const fmtHour = h => `${String(h).padStart(2, '0')}:00`
const listNames = names =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

const PTYPE_LABEL = { rain: 'Rain', drizzle: 'Drizzle', sleet: 'Sleet', snow: 'Snow', freezing: 'Freezing rain' }

// ── Small pieces ─────────────────────────────────────────────────────────

// Free-text place field. Typing searches as you go; Enter picks the top
// match. Unpicked text is reported via onText so "Check" can resolve it.
function LocationInput({ label, value, onChange, onText, active, onActivate }) {
  const [text, setText] = useState(value?.label ?? '')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [state, setState] = useState(null) // 'searching' | 'none' | 'error'
  const timer = useRef(null)
  const abort = useRef(null)

  async function search(q) {
    abort.current?.abort()
    abort.current = new AbortController()
    setState('searching')
    try {
      const hits = await searchPlaces(q, abort.current.signal)
      setResults(hits)
      setState(hits.length ? null : 'none')
      setOpen(true)
      return hits
    } catch (e) {
      if (e.name !== 'AbortError') setState('error')
      return []
    }
  }

  function onType(e) {
    const q = e.target.value
    setText(q)
    onText(q)
    clearTimeout(timer.current)
    if (q.trim().length < 2) {
      setResults([])
      setState(null)
      return
    }
    timer.current = setTimeout(() => search(q), 300)
  }

  async function onKeyDown(e) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    clearTimeout(timer.current)
    const hits = results.length ? results : await search(text)
    if (hits[0]) onChange(hits[0])
  }

  return (
    <div className="relative">
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs uppercase tracking-wider text-slate-300">{label}</label>
        <button
          type="button"
          onClick={onActivate}
          className={`text-xs px-2 py-0.5 rounded-full transition-colors ${
            active ? 'bg-sky-400 text-slate-900' : 'text-sky-300 hover:text-sky-200'
          }`}
        >
          {active ? 'Now click the map…' : '📍 Pick on map'}
        </button>
      </div>
      <input
        value={text}
        onChange={onType}
        onKeyDown={onKeyDown}
        onFocus={() => results.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Type a town or address"
        className="w-full rounded-xl bg-slate-800/70 border border-white/10 px-3 py-2.5 text-white placeholder:text-slate-500 focus:outline-none focus:border-sky-400"
      />
      {state === 'searching' && <p className="text-xs text-slate-400 mt-1">Searching…</p>}
      {state === 'none' && (
        <p className="text-xs text-amber-300 mt-1">No place called “{text}” — check the spelling or pick it on the map.</p>
      )}
      {state === 'error' && (
        <p className="text-xs text-amber-300 mt-1">Place search isn't answering right now — pick the place on the map instead.</p>
      )}
      {open && results.length > 0 && (
        <ul className="absolute z-[1000] mt-1 w-full rounded-xl bg-slate-800 border border-white/10 shadow-xl overflow-hidden">
          {results.map((r, i) => (
            <li key={i}>
              <button
                type="button"
                onMouseDown={() => {
                  onChange(r)
                  setOpen(false)
                }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-slate-700"
              >
                {r.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Dot({ score, size = 'w-3 h-3' }) {
  if (score == null) return <span className={`inline-block ${size} rounded-full bg-slate-500/50`} />
  return <span className={`inline-block ${size} rounded-full`} style={{ background: level(score).color }} />
}

function ScoreBadge({ score }) {
  if (score == null) return <span className="text-slate-400 text-sm">No data</span>
  const l = level(score)
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: l.color }}>
      <Dot score={score} /> {l.label} <span className="text-slate-400 font-normal">{score.toFixed(1)}</span>
    </span>
  )
}

function RouteTag({ index }) {
  return (
    <span
      className="inline-flex items-center justify-center w-6 h-6 rounded-md text-xs font-bold text-slate-900"
      style={{ background: ROUTE_COLORS[index % ROUTE_COLORS.length] }}
    >
      {letter(index)}
    </span>
  )
}

// Every candidate day × departure hour for one route.
function buildGrid(trip, weather, { days, selectedDays, earliest, latest, fetchedAt, opts }) {
  const hours = []
  for (let h = earliest; h <= latest; h++) hours.push(h)
  const rows = days
    .filter(d => selectedDays.includes(dayKey(d)))
    .map(d => {
      const cells = hours.map(h => {
        const dep = new Date(d)
        dep.setHours(h)
        if (dep.getTime() < fetchedAt - 3600_000) return { hour: h, past: true }
        return { hour: h, ...scoreTrip(trip.waypoints, weather, dep.getTime(), opts) }
      })
      const valid = cells.filter(c => c.score != null)
      const best = valid.length ? valid.reduce((a, b) => (b.score < a.score ? b : a)) : null
      return { day: dayKey(d), date: d, cells, best, allPast: cells.every(c => c.past) }
    })
  const withBest = rows.filter(r => r.best)
  const best = withBest.length ? withBest.reduce((a, b) => (b.best.score < a.best.score ? b : a)) : null
  return { hours, rows, best }
}

function hazards(stops, minScore) {
  const set = new Set(
    stops.flatMap(s => Object.values(s.bySource).flatMap(x => (x && x.score >= minScore ? x.reasons : []))),
  )
  set.delete('Dark')
  if (set.has('Near freezing, damp — slippery patches')) set.delete('Near freezing')
  return [...set]
}

// ── Page ─────────────────────────────────────────────────────────────────

export default function RoadWeather() {
  const [saved] = useState(load)
  const [days] = useState(upcomingDays)

  const [from, setFrom] = useState(saved.from ?? null)
  const [to, setTo] = useState(saved.to ?? null)
  const [fromText, setFromText] = useState(saved.from?.label ?? '')
  const [toText, setToText] = useState(saved.to?.label ?? '')
  const [pickMode, setPickMode] = useState(null)
  const [selectedDays, setSelectedDays] = useState(() => days.slice(0, 3).map(dayKey))
  const [earliest, setEarliest] = useState(saved.earliest ?? 6)
  const [latest, setLatest] = useState(saved.latest ?? 14)
  const [spacing, setSpacing] = useState(saved.spacing ?? 40)
  const [pace, setPace] = useState(saved.pace ?? 1.1)
  const [breakMin, setBreakMin] = useState(saved.breakMin ?? 15)
  const [summerTires, setSummerTires] = useState(saved.summerTires ?? false)
  const [sources, setSources] = useState(
    () => saved.sources?.filter(id => SOURCES.some(s => s.id === id)) ?? SOURCES.filter(s => s.on).map(s => s.id),
  )

  const [status, setStatus] = useState(null) // { busy, text, error }
  const [trips, setTrips] = useState(null) // [{ route, waypoints, via }]
  const [weathers, setWeathers] = useState(null) // one per trip
  const [fetchedAt, setFetchedAt] = useState(0)
  const [selected, setSelected] = useState(null) // { route, day, hour }
  const [focusStop, setFocusStop] = useState(null)
  const runId = useRef(0)

  useEffect(() => {
    save({ from, to, earliest, latest, spacing, pace, breakMin, summerTires, sources })
  }, [from, to, earliest, latest, spacing, pace, breakMin, summerTires, sources])

  const chooseFrom = useCallback(place => {
    setFrom(place)
    setFromText(place?.label ?? '')
  }, [])
  const chooseTo = useCallback(place => {
    setTo(place)
    setToText(place?.label ?? '')
  }, [])

  // Map click: fills whichever field asked for it, otherwise start, then
  // destination.
  const onPick = useCallback(
    async (lat, lon) => {
      const which = pickMode ?? (!from ? 'from' : !to ? 'to' : null)
      if (!which) return
      setPickMode(null)
      const name = (await reverseGeocode(lat, lon)) ?? `${lat.toFixed(3)}, ${lon.toFixed(3)}`
      const place = { lat, lon, name, label: name }
      if (which === 'from') chooseFrom(place)
      else chooseTo(place)
    },
    [pickMode, from, to, chooseFrom, chooseTo],
  )

  // Text typed but never picked from the list: take the top match.
  async function resolve(place, text, choose) {
    if (place && place.label === text) return place
    if (!text.trim()) return place
    const [hit] = await searchPlaces(text)
    if (!hit) throw new Error(`Couldn't find “${text}” — check the spelling or pick it on the map.`)
    choose(hit)
    return hit
  }

  async function plan() {
    const run = ++runId.current
    const current = fn => value => run === runId.current && fn(value)
    setSelected(null)
    setFocusStop(null)
    setWeathers(null)
    setTrips(null)
    try {
      setStatus({ busy: true, text: 'Finding the places…' })
      const a = await resolve(from, fromText, chooseFrom)
      const b = await resolve(to, toText, chooseTo)
      if (!a || !b) throw new Error('Set both a start and a destination.')

      setStatus({ busy: true, text: 'Finding routes…' })
      const routes = await fetchRoutes(a, b, 3, current(text => setStatus({ busy: true, text })))
      if (run !== runId.current) return
      let list = routes.map(route => ({ route, waypoints: sampleWaypoints(route, a, b, spacing), via: null }))
      setTrips(list)

      setStatus({ busy: true, text: `Fetching forecasts for ${routes.length} route${routes.length > 1 ? 's' : ''}…` })
      // One route at a time so shared stretches reuse cached forecasts.
      const wx = []
      for (const t of list) wx.push(await fetchWeather(t.waypoints))
      current(setFetchedAt)(Date.now())
      current(setWeathers)(wx)

      // Forecasts are in; names fill in as they arrive.
      current(setStatus)({ busy: true, text: 'Looking up town names along the way…' })
      for (let i = 0; i < list.length; i++) {
        const named = await nameWaypoints(list[i].waypoints, partial => {
          list = list.map((t, j) => (j === i ? { ...t, waypoints: partial } : t))
          current(setTrips)(list)
        })
        list = list.map((t, j) => (j === i ? { ...t, waypoints: named } : t))
        current(setTrips)(list)
      }
      list = list.map((t, i) => (i === 0 ? t : { ...t, via: viaName(t.waypoints, list[0].route) }))
      current(setTrips)(list)
      current(setStatus)(null)
    } catch (e) {
      current(setStatus)({ error: true, text: e.message || 'Something went wrong' })
    }
  }

  const grids = useMemo(() => {
    if (!trips || !weathers || !sources.length) return null
    const ctx = { days, selectedDays, earliest, latest, fetchedAt, opts: { summerTires, pace, breakMin, sources } }
    return trips.map((t, i) => buildGrid(t, weathers[i], ctx))
  }, [trips, weathers, days, selectedDays, earliest, latest, fetchedAt, summerTires, pace, breakMin, sources])

  // Best route + day + hour overall.
  const overall = useMemo(() => {
    if (!grids) return null
    let best = null
    grids.forEach((g, route) => {
      if (g.best && (!best || g.best.best.score < best.score))
        best = { route, day: g.best.day, hour: g.best.best.hour, score: g.best.best.score }
    })
    return best
  }, [grids])

  const pick = selected ?? overall
  const routeIdx = pick?.route ?? 0
  const grid = grids?.[routeIdx]
  const trip = trips?.[routeIdx]

  const ranked = useMemo(
    () => (grid ? grid.rows.filter(r => r.best).sort((a, b) => a.best.score - b.best.score) : []),
    [grid],
  )

  const active = useMemo(() => {
    if (!grid || !pick) return null
    const row = grid.rows.find(r => r.day === pick.day) ?? ranked[0]
    const cell = row?.cells.find(c => c.hour === pick.hour) ?? row?.best
    return cell?.stops ? { row, cell } : null
  }, [grid, pick, ranked])

  const toggleDay = k => setSelectedDays(s => (s.includes(k) ? s.filter(x => x !== k) : [...s, k].sort()))
  const toggleSource = id =>
    setSources(s => (s.includes(id) ? (s.length > 1 ? s.filter(x => x !== id) : s) : [...s, id]))

  const routeName = i => (i === 0 ? 'Fastest' : trips?.[i]?.via ? `via ${trips[i].via}` : 'Alternative')
  const sourceNames = SOURCES.filter(s => sources.includes(s.id)).map(s => s.full)
  const mapStops = active?.cell.stops ?? trip?.waypoints
  const hint = pickMode
    ? `Click the map to set ${pickMode === 'from' ? 'the start' : 'the destination'}`
    : !from
      ? 'Type a start on the left, or click the map to set it'
      : !to
        ? 'Now click the map to set the destination (or type it)'
        : null

  const select = (route, day, hour) => {
    setSelected({ route, day, hour })
    setFocusStop(null)
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10">
      <header className="mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold">Road Weather</h1>
        <p className="text-slate-300 mt-2 max-w-2xl">
          Pick where you start and where you're going. The planner finds up to three routes, checks the forecast for
          the hour you'll pass each town along them, and compares routes, days and departure times so you can dodge
          black ice, snow and sleet.
        </p>
      </header>

      {/* Inputs + map */}
      <div className="grid lg:grid-cols-[360px_1fr] gap-6">
        <div className="space-y-5 rounded-2xl bg-slate-700/60 border border-white/10 p-5">
          <LocationInput
            key={`from:${from?.label}`}
            label="From"
            value={from}
            onChange={chooseFrom}
            onText={setFromText}
            active={pickMode === 'from'}
            onActivate={() => setPickMode(m => (m === 'from' ? null : 'from'))}
          />
          <div className="flex justify-center -my-2">
            <button
              type="button"
              onClick={() => {
                chooseFrom(to)
                chooseTo(from)
              }}
              className="text-slate-300 hover:text-white text-sm"
              title="Swap"
            >
              ⇅ swap
            </button>
          </div>
          <LocationInput
            key={`to:${to?.label}`}
            label="To"
            value={to}
            onChange={chooseTo}
            onText={setToText}
            active={pickMode === 'to'}
            onActivate={() => setPickMode(m => (m === 'to' ? null : 'to'))}
          />

          <div>
            <div className="text-xs uppercase tracking-wider text-slate-300 mb-2">Days to compare</div>
            <div className="flex flex-wrap gap-1.5">
              {days.map((d, i) => {
                const k = dayKey(d)
                const on = selectedDays.includes(k)
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => toggleDay(k)}
                    className={`px-2.5 py-1 rounded-lg text-sm border transition-colors ${
                      on ? 'bg-sky-400 text-slate-900 border-sky-400' : 'border-white/15 text-slate-200 hover:border-white/40'
                    }`}
                  >
                    {i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : fmtDay(d)}
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-slate-400 mt-1.5">Yr and SMHI reach about 9 days ahead; Open-Meteo a bit further.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="block text-xs uppercase tracking-wider text-slate-300 mb-1">Leave earliest</span>
              <select value={earliest} onChange={e => setEarliest(+e.target.value)} className="w-full rounded-lg bg-slate-800/70 border border-white/10 px-2 py-2">
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{fmtHour(h)}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className="block text-xs uppercase tracking-wider text-slate-300 mb-1">Leave latest</span>
              <select value={latest} onChange={e => setLatest(Math.max(+e.target.value, earliest))} className="w-full rounded-lg bg-slate-800/70 border border-white/10 px-2 py-2">
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h} disabled={h < earliest}>{fmtHour(h)}</option>)}
              </select>
            </label>
          </div>

          <label className="flex items-center gap-3 cursor-pointer select-none">
            <input type="checkbox" checked={summerTires} onChange={e => setSummerTires(e.target.checked)} className="w-4 h-4 accent-sky-400" />
            <span className="text-sm">Still on summer tyres</span>
          </label>

          <div>
            <div className="text-xs uppercase tracking-wider text-slate-300 mb-2">Weather services</div>
            <div className="space-y-1.5">
              {SOURCES.map(s => (
                <label key={s.id} className="flex items-start gap-3 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={sources.includes(s.id)}
                    onChange={() => toggleSource(s.id)}
                    className="w-4 h-4 mt-0.5 accent-sky-400"
                  />
                  <span className="text-sm leading-tight">
                    {s.full}
                    <span className="block text-xs text-slate-400">{s.note}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="text-xs text-slate-400 mt-1.5">Turning services on or off updates the results right away.</p>
          </div>

          <details className="text-sm">
            <summary className="cursor-pointer text-slate-300 hover:text-white">More settings</summary>
            <div className="mt-3 space-y-3">
              <label className="block">
                <span className="block text-xs text-slate-300 mb-1">Check a place about every</span>
                <select value={spacing} onChange={e => setSpacing(+e.target.value)} className="w-full rounded-lg bg-slate-800/70 border border-white/10 px-2 py-2">
                  {[20, 30, 40, 60, 80].map(v => <option key={v} value={v}>{v} km</option>)}
                </select>
              </label>
              <label className="block">
                <span className="block text-xs text-slate-300 mb-1">Driving pace vs. the router's estimate</span>
                <select value={pace} onChange={e => setPace(+e.target.value)} className="w-full rounded-lg bg-slate-800/70 border border-white/10 px-2 py-2">
                  {[1, 1.1, 1.2, 1.3].map(v => <option key={v} value={v}>{v === 1 ? 'As estimated' : `${Math.round((v - 1) * 100)}% slower`}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="block text-xs text-slate-300 mb-1">Break every 2 hours</span>
                <select value={breakMin} onChange={e => setBreakMin(+e.target.value)} className="w-full rounded-lg bg-slate-800/70 border border-white/10 px-2 py-2">
                  {[0, 10, 15, 20, 30].map(v => <option key={v} value={v}>{v ? `${v} min` : 'No breaks'}</option>)}
                </select>
              </label>
              <p className="text-xs text-slate-400">Changing the spacing needs a new check; the rest updates right away.</p>
            </div>
          </details>

          <button
            type="button"
            onClick={plan}
            disabled={!(from || fromText.trim()) || !(to || toText.trim()) || status?.busy}
            className="w-full rounded-xl bg-sky-400 text-slate-900 font-semibold py-3 disabled:opacity-40 hover:bg-sky-300 transition-colors"
          >
            {status?.busy ? 'Working…' : 'Check the route'}
          </button>
          {status && <p className={`text-sm ${status.error ? 'text-red-300' : 'text-slate-300'}`}>{status.text}</p>}
        </div>

        <div className="h-[420px] lg:h-auto lg:min-h-[560px] relative">
          <RouteMap
            from={from}
            to={to}
            routes={trips?.map(t => t.route)}
            selectedRoute={routeIdx}
            onSelectRoute={i => select(i, grids?.[i]?.best?.day, grids?.[i]?.best?.best.hour)}
            stops={mapStops}
            onPick={onPick}
            selectedIndex={focusStop}
            onSelectStop={setFocusStop}
          />
          {hint && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[500] bg-slate-900/90 text-sm px-3 py-1.5 rounded-full pointer-events-none whitespace-nowrap">
              {hint}
            </div>
          )}
        </div>
      </div>

      {grids && (
        <>
          <p className="text-sm text-slate-300 mt-4">
            Forecasts from <span className="text-white">{listNames(sourceNames)}</span>. Change which services count
            under Weather services.
          </p>

          {/* Route comparison */}
          <section className="mt-10">
            <h2 className="text-xl font-semibold mb-1">{trips.length > 1 ? 'Which route?' : 'Route'}</h2>
            <p className="text-sm text-slate-300 mb-4">
              {trips.length > 1
                ? 'The best departure on each route and day. Click a route to see it in detail.'
                : 'No sensible alternative route was found for this trip.'}
            </p>
            <div className="overflow-x-auto rounded-2xl bg-slate-700/60 border border-white/10">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-300">
                    <th className="font-normal px-4 py-3">Route</th>
                    {grids[0].rows.map(r => (
                      <th key={r.day} className="font-normal px-3 py-3 whitespace-nowrap">{fmtDay(r.date)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {trips.map((t, i) => {
                    const g = grids[i]
                    const isActive = i === routeIdx
                    return (
                      <tr
                        key={i}
                        onClick={() => g.best && select(i, g.best.day, g.best.best.hour)}
                        className={`cursor-pointer ${isActive ? 'bg-white/5' : 'hover:bg-white/5'}`}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <RouteTag index={i} />
                            <div>
                              <div className="font-semibold whitespace-nowrap">
                                {routeName(i)}
                                {overall?.route === i && (
                                  <span className="ml-2 text-[11px] bg-sky-400 text-slate-900 font-semibold px-1.5 py-0.5 rounded-full">Best</span>
                                )}
                              </div>
                              <div className="text-xs text-slate-400 whitespace-nowrap">
                                {Math.round(t.route.totalKm)} km · {fmtDuration(t.route.totalSec * pace + Math.floor(t.route.totalSec / 7200) * breakMin * 60)}
                              </div>
                            </div>
                          </div>
                        </td>
                        {g.rows.map(r => (
                          <td key={r.day} className="px-3 py-3">
                            {r.best ? (
                              <button
                                type="button"
                                onClick={e => {
                                  e.stopPropagation()
                                  select(i, r.day, r.best.hour)
                                }}
                                className="text-left"
                              >
                                <ScoreBadge score={r.best.score} />
                                <div className="text-xs text-slate-400">leave {fmtHour(r.best.hour)}</div>
                              </button>
                            ) : (
                              <span className="text-slate-500 text-xs">{r.allPast ? 'Too late today' : 'No forecast'}</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Day ranking for the chosen route */}
          <section className="mt-10">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2.5">
              <RouteTag index={routeIdx} /> Best day to drive {trips.length > 1 && <span className="text-slate-300 font-normal">· {routeName(routeIdx)}</span>}
            </h2>
            {ranked.length === 0 ? (
              <p className="text-slate-300">No forecast covers the days you picked yet.</p>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {ranked.map((r, i) => {
                  const worst = r.best.stops.reduce((a, b) => ((b.combined ?? -1) > (a.combined ?? -1) ? b : a))
                  const reasons = hazards(r.best.stops, 4)
                  const isActive = active?.row.day === r.day && active?.cell.hour === r.best.hour
                  return (
                    <button
                      key={r.day}
                      type="button"
                      onClick={() => select(routeIdx, r.day, r.best.hour)}
                      className={`text-left rounded-2xl p-5 border transition-colors ${
                        isActive ? 'bg-slate-700 border-sky-400' : 'bg-slate-700/60 border-white/10 hover:border-white/30'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-lg font-semibold">{fmtDay(r.date)}</span>
                        {i === 0 && <span className="text-xs bg-sky-400 text-slate-900 font-semibold px-2 py-0.5 rounded-full">Best</span>}
                      </div>
                      <div className="mt-1 text-sm text-slate-300">
                        Leave {fmtHour(r.best.hour)} · arrive {fmtTime(r.best.stops.at(-1).eta)}
                      </div>
                      <div className="mt-3"><ScoreBadge score={r.best.score} /></div>
                      <div className="mt-2 text-sm text-slate-300">
                        Worst stretch: <span className="text-white">{worst.name ?? `km ${Math.round(worst.km)}`}</span> ({level(worst.combined ?? 0).label.toLowerCase()})
                      </div>
                      {reasons.length > 0 && <div className="mt-2 text-xs text-slate-400">{reasons.slice(0, 4).join(' · ')}</div>}
                    </button>
                  )
                })}
              </div>
            )}
          </section>

          {/* Day × departure hour heatmap */}
          <section className="mt-10">
            <h2 className="text-xl font-semibold mb-1">Departure times</h2>
            <p className="text-sm text-slate-300 mb-4">Each square is the whole trip on route {letter(routeIdx)} if you leave at that hour. Click one to see the details.</p>
            <div className="overflow-x-auto rounded-2xl bg-slate-700/60 border border-white/10 p-4">
              <table className="border-separate" style={{ borderSpacing: 4 }}>
                <thead>
                  <tr>
                    <th />
                    {grid.hours.map(h => (
                      <th key={h} className="text-xs font-normal text-slate-300 w-10">{String(h).padStart(2, '0')}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.rows.map(r => (
                    <tr key={r.day}>
                      <td className="text-sm pr-3 whitespace-nowrap text-slate-200">{fmtDay(r.date)}</td>
                      {r.cells.map(c => {
                        const isActive = active?.row.day === r.day && active?.cell.hour === c.hour
                        const color = c.score != null ? level(c.score).color : null
                        return (
                          <td key={c.hour}>
                            <button
                              type="button"
                              disabled={c.score == null}
                              onClick={() => select(routeIdx, r.day, c.hour)}
                              title={c.score != null ? `${level(c.score).label} (${c.score.toFixed(1)})` : c.past ? 'In the past' : 'No forecast yet'}
                              className={`w-10 h-9 rounded-md text-[11px] font-semibold text-slate-900 ${isActive ? 'ring-2 ring-white' : ''}`}
                              style={{ background: color ?? 'rgba(148,163,184,.15)' }}
                            >
                              {c.score != null ? c.score.toFixed(0) : ''}
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex flex-wrap gap-4 mt-3 text-xs text-slate-300">
                {LEVELS.map(l => (
                  <span key={l.label} className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm" style={{ background: l.color }} /> {l.label}
                  </span>
                ))}
              </div>
            </div>
          </section>

          {/* Stop-by-stop detail */}
          {active && (
            <section className="mt-10">
              <h2 className="text-xl font-semibold mb-1 flex items-center gap-2.5">
                <RouteTag index={routeIdx} /> {fmtDay(active.row.date)}, leaving {fmtHour(active.cell.hour)}
              </h2>
              <p className="text-sm text-slate-300 mb-4">Places in driving order, with the forecast for when you'll be there.</p>
              <div className="rounded-2xl bg-slate-700/60 border border-white/10 divide-y divide-white/10">
                {active.cell.stops.map((s, i) => {
                  const primary = sources.map(id => s.bySource[id]).find(Boolean)
                  const reasons = hazards([s], 2)
                  return (
                    <div
                      key={i}
                      onMouseEnter={() => setFocusStop(i)}
                      className={`grid grid-cols-[auto_1fr] sm:grid-cols-[auto_1.4fr_1fr_1.3fr_auto] gap-x-4 gap-y-1 items-center px-4 py-3 ${
                        focusStop === i ? 'bg-white/5' : ''
                      }`}
                    >
                      <span
                        className="w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm text-slate-900 row-span-2 sm:row-span-1"
                        style={{ background: s.combined != null ? level(s.combined).color : '#94a3b8' }}
                      >
                        {i + 1}
                      </span>
                      <div>
                        <div className="font-semibold">{s.name ?? <span className="text-slate-400">Km {Math.round(s.km)}…</span>}</div>
                        <div className="text-xs text-slate-400">km {Math.round(s.km)} · {fmtWeekdayTime(s.eta)}</div>
                      </div>
                      <div className="text-sm col-start-2 sm:col-start-auto">
                        {primary ? (
                          <>
                            <span className="text-white">{primary.temp.toFixed(0)}°</span>
                            <span className="text-slate-400"> air · road ~{primary.road.toFixed(0)}°</span>
                            <div className="text-xs text-slate-400">
                              {primary.ptype !== 'none' && primary.precip >= 0.1
                                ? `${PTYPE_LABEL[primary.ptype]} ${primary.precip.toFixed(1)} mm/h`
                                : 'Dry'}
                              {primary.gust != null && ` · gusts ${Math.round(primary.gust)} m/s`}
                            </div>
                          </>
                        ) : (
                          <span className="text-slate-400">No forecast</span>
                        )}
                      </div>
                      <div className="text-xs text-slate-300 col-start-2 sm:col-start-auto">
                        {reasons.length ? reasons.join(' · ') : <span className="text-slate-500">Nothing notable</span>}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 col-start-2 sm:col-start-auto">
                        {SOURCES.filter(src => sources.includes(src.id)).map(src => (
                          <span
                            key={src.id}
                            className="inline-flex items-center gap-1 text-[11px] text-slate-300"
                            title={s.bySource[src.id] ? `${src.full}: ${level(s.bySource[src.id].score).label}` : `${src.full}: no data`}
                          >
                            <Dot score={s.bySource[src.id]?.score} size="w-2.5 h-2.5" />
                            {src.label}
                          </span>
                        ))}
                        <a
                          href={`https://www.yr.no/en/forecast/daily-table/${s.lat.toFixed(3)},${s.lon.toFixed(3)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-sky-300 hover:text-sky-200"
                        >
                          yr.no ↗
                        </a>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          <section className="mt-10 text-sm text-slate-300 space-y-2 max-w-3xl">
            <h2 className="text-base font-semibold text-white">How the risk is judged</h2>
            <p>
              For every place, each forecast is read for the hour you'll pass it. The worst signs score highest:
              freezing rain, rain falling on a frozen road, a wet road that drops below zero (classic black ice), snow,
              sleet near zero, frost on damp nights, strong gusts and fog. Darkness adds a little. The road is assumed
              to be about as cold as the modelled ground surface, or slightly colder than the air at night.
            </p>
            <p>
              The services you pick are blended leaning towards the most pessimistic one, since one model seeing ice is
              reason enough to be careful. Alternative routes are only shown when they're at most about a third
              slower than the fastest. It's a guide for choosing — it can't see salting or ploughing, so check{' '}
              <a href="https://www.trafikverket.se/trafikinformation/vag/" target="_blank" rel="noreferrer" className="text-sky-300 hover:text-sky-200">
                Trafikverket's road conditions
              </a>{' '}
              and{' '}
              <a href="https://www.smhi.se/vader/varningar-och-brandrisk" target="_blank" rel="noreferrer" className="text-sky-300 hover:text-sky-200">
                SMHI's warnings
              </a>{' '}
              before you leave.
            </p>
            <p className="text-xs text-slate-400">
              Data: MET Norway (yr.no), SMHI, Open-Meteo (ECMWF, DWD, NOAA), OSRM and OpenStreetMap contributors.
            </p>
          </section>
        </>
      )}
    </div>
  )
}
