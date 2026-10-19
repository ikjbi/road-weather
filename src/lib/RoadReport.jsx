import { useEffect, useState } from 'react'
import { BUILT_IN_KEY, fetchRoadReport, KeyError, storedKey, storeKey } from './trafikverket'

const fmtTime = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const fmtWhen = t => new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
const fmtTemp = v => (v == null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(1)}°`)

const CONDITION_COLORS = { 2: '#facc15', 3: '#fb923c', 4: '#ef4444' }

// Name of the stop closest to `km`, for "near Gävle".
function near(waypoints, km) {
  const named = waypoints.filter(w => w.name)
  if (!named.length) return null
  return named.reduce((a, b) => (Math.abs(b.km - km) < Math.abs(a.km - km) ? b : a)).name
}

function Where({ km, waypoints }) {
  const name = near(waypoints, km)
  return (
    <span className="text-slate-400 whitespace-nowrap">
      km {Math.round(km)}
      {name && <> · near {name}</>}
    </span>
  )
}

function surface(s) {
  if (s.ice) return { text: 'Ice', className: 'text-red-400 font-semibold' }
  if (s.snow) return { text: 'Snow', className: 'text-orange-300 font-semibold' }
  if (s.wet && s.road != null && s.road <= 1) return { text: 'Wet, near 0°', className: 'text-yellow-300' }
  if (s.wet) return { text: 'Wet', className: 'text-slate-200' }
  return { text: 'Dry', className: 'text-slate-300' }
}

function KeyForm({ rejected, onKey }) {
  const [value, setValue] = useState('')
  return (
    <form
      className="rounded-2xl bg-slate-700/60 border border-white/10 p-5 text-sm text-slate-300 space-y-3"
      onSubmit={e => {
        e.preventDefault()
        if (value.trim()) onKey(value.trim())
      }}
    >
      <p>
        {rejected ? 'Trafikverket did not accept that key. ' : ''}
        Live road data needs a free key from{' '}
        <a href="https://data.trafikverket.se/get-started" target="_blank" rel="noreferrer" className="text-sky-300 hover:text-sky-200">
          Trafikverket's open API
        </a>
        . Register, create a key and paste it here. It's kept in this browser only.
      </p>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="Trafikverket API key"
          className="flex-1 min-w-0 rounded-lg bg-slate-800 border border-white/10 px-3 py-2 text-white placeholder:text-slate-500"
        />
        <button type="submit" className="rounded-lg bg-sky-400 text-slate-900 font-semibold px-4 py-2">
          Save
        </button>
      </div>
    </form>
  )
}

// Live status along one route from Trafikverket. Remount (key) to refetch.
export default function RoadReport({ route, waypoints, title }) {
  const [key, setKey] = useState(() => BUILT_IN_KEY || storedKey())
  const [state, setState] = useState(() => (key ? { status: 'loading' } : { status: 'nokey' }))

  useEffect(() => {
    if (!key) return
    let live = true
    fetchRoadReport(route, key).then(
      data => live && setState({ status: 'done', data }),
      e =>
        live &&
        setState(e instanceof KeyError ? { status: 'nokey', rejected: true } : { status: 'error', text: e.message }),
    )
    return () => {
      live = false
    }
  }, [route, key])

  const saveKey = k => {
    storeKey(k)
    setState({ status: 'loading' })
    setKey(k)
  }

  const { status, data } = state
  const roadworks = data?.incidents.filter(d => d.roadworks) ?? []
  const incidents = data?.incidents.filter(d => !d.roadworks) ?? []
  const coldest = data?.stations.reduce((a, s) => (s.road != null && (a == null || s.road < a.road) ? s : a), null)
  const icy = data?.stations.filter(s => s.ice || s.snow).length ?? 0

  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold mb-1 flex items-center gap-2.5">{title}</h2>
      <p className="text-sm text-slate-300 mb-4 max-w-3xl">
        Live from Trafikverket: road temperatures measured at the roadside weather stations, the road condition
        reports, and incidents on the way. This is now, not a forecast, so it matters most if you're leaving soon.
        Swedish roads only.
      </p>

      {status === 'nokey' && (
        <KeyForm rejected={state.rejected} onKey={saveKey} />
      )}
      {status === 'loading' && <p className="text-slate-300 text-sm">Asking Trafikverket…</p>}
      {status === 'error' && <p className="text-red-300 text-sm">{state.text}</p>}

      {status === 'done' && (
        <div className="space-y-4">
          {!data.stations.length && !data.conditions.length && !data.incidents.length ? (
            <p className="text-slate-300 text-sm">Trafikverket has nothing to report along this route.</p>
          ) : (
            <p className="text-sm text-slate-300">
              {data.conditions.length
                ? `${data.conditions.length} stretch${data.conditions.length > 1 ? 'es' : ''} with a road condition warning`
                : 'No road condition warnings'}
              {coldest && (
                <>
                  {' · '}coldest road surface <span className="text-white">{fmtTemp(coldest.road)}</span> at {coldest.name}
                </>
              )}
              {icy > 0 && ` · ice or snow measured at ${icy} station${icy > 1 ? 's' : ''}`}
              {` · ${incidents.length} incident${incidents.length === 1 ? '' : 's'}`}
              {roadworks.length > 0 && `, ${roadworks.length} roadworks`}
              <span className="text-slate-400"> · checked {fmtTime(data.fetchedAt)}</span>
            </p>
          )}

          {data.conditions.length > 0 && (
            <div className="rounded-2xl bg-slate-700/60 border border-white/10 divide-y divide-white/10">
              <h3 className="px-4 py-3 font-semibold">Road conditions</h3>
              {data.conditions.map(c => (
                <div key={c.id} className="px-4 py-3 text-sm flex gap-3">
                  <span className="mt-1.5 w-2.5 h-2.5 rounded-full shrink-0" style={{ background: CONDITION_COLORS[c.code] }} />
                  <div className="min-w-0">
                    <div>
                      <span className="font-semibold" style={{ color: CONDITION_COLORS[c.code] }}>{c.text}</span>
                      {c.road && <span className="text-slate-300"> · {c.road}</span>}{' '}
                      <Where km={c.km} waypoints={waypoints} />
                    </div>
                    {(c.warnings.length > 0 || c.causes.length > 0) && (
                      <div className="text-slate-200 first-letter:uppercase">
                        {[...c.warnings, ...c.causes.map(x => `due to ${x}`)].join(', ')}
                      </div>
                    )}
                    {c.measures.length > 0 && <div className="text-slate-400 text-xs first-letter:uppercase">{c.measures.join(', ')}</div>}
                    {c.location && <div className="text-slate-400 text-xs">{c.location}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {data.stations.length > 0 && (
            <div className="overflow-x-auto rounded-2xl bg-slate-700/60 border border-white/10">
              <h3 className="px-4 pt-3 font-semibold">
                Road weather stations <span className="text-slate-400 font-normal text-sm">· {data.stations.length} along the route</span>
              </h3>
              <div className="max-h-[28rem] overflow-y-auto mt-2">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-700">
                  <tr className="text-left text-slate-300">
                    <th className="font-normal px-4 py-2">Station</th>
                    <th className="font-normal px-3 py-2 whitespace-nowrap">Road</th>
                    <th className="font-normal px-3 py-2 whitespace-nowrap">Air</th>
                    <th className="font-normal px-3 py-2">Surface</th>
                    <th className="font-normal px-3 py-2">Weather</th>
                    <th className="font-normal px-3 py-2">Measured</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {data.stations.map(s => {
                    const surf = surface(s)
                    const fog = s.visibility != null && s.visibility < 1000
                    return (
                      <tr key={s.id}>
                        <td className="px-4 py-2">
                          <div>{s.name}</div>
                          <div className="text-xs"><Where km={s.km} waypoints={waypoints} /></div>
                        </td>
                        <td className={`px-3 py-2 whitespace-nowrap font-semibold ${s.road != null && s.road <= 0 ? 'text-sky-300' : ''}`}>
                          {fmtTemp(s.road)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-slate-300">{fmtTemp(s.air)}</td>
                        <td className={`px-3 py-2 whitespace-nowrap ${surf.className}`}>{surf.text}</td>
                        <td className="px-3 py-2 text-slate-300">
                          {[s.precip, fog && `fog, ${Math.round(s.visibility / 10) * 10} m visibility`].filter(Boolean).join(', ') || '–'}
                        </td>
                        <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{fmtTime(s.sample)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
              <p className="px-4 py-3 text-xs text-slate-400 border-t border-white/10">
                Road temperatures at or below 0° are shown in blue. A wet road near 0° can freeze into black ice.
              </p>
            </div>
          )}

          {(incidents.length > 0 || roadworks.length > 0) && (
            <div className="rounded-2xl bg-slate-700/60 border border-white/10 divide-y divide-white/10">
              <h3 className="px-4 py-3 font-semibold">Incidents</h3>
              {incidents.map(d => (
                <Incident key={d.id} d={d} waypoints={waypoints} />
              ))}
              {incidents.length === 0 && <p className="px-4 py-3 text-sm text-slate-300">No accidents or obstructions reported.</p>}
              {roadworks.length > 0 && (
                <details className="px-4 py-3 text-sm">
                  <summary className="cursor-pointer text-slate-300">
                    {roadworks.length} roadworks along the route
                  </summary>
                  <div className="divide-y divide-white/10 mt-2 -mx-4">
                    {roadworks.map(d => (
                      <Incident key={d.id} d={d} waypoints={waypoints} />
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}

          <p className="text-xs text-slate-400">
            Data: Trafikverket. Messages are in Swedish as published. See also{' '}
            <a href="https://www.trafikverket.se/trafikinformation/vag/" target="_blank" rel="noreferrer" className="text-sky-300 hover:text-sky-200">
              Trafikverket's traffic information map
            </a>
            .
          </p>
        </div>
      )}
    </section>
  )
}

function Incident({ d, waypoints }) {
  return (
    <div className="px-4 py-3 text-sm">
      <div>
        <span className={`font-semibold ${d.severity >= 4 ? 'text-orange-300' : 'text-white'}`}>{d.type}</span>
        {d.road && <span className="text-slate-300"> · {d.road}</span>} <Where km={d.km} waypoints={waypoints} />
      </div>
      {(d.header || d.message) && <div className="text-slate-200">{[d.header, d.message].filter(Boolean).join(' – ')}</div>}
      <div className="text-xs text-slate-400">
        {[d.location, d.upcoming && `from ${fmtWhen(d.start)}`, d.end && `until ${fmtWhen(d.end)}`].filter(Boolean).join(' · ')}
      </div>
    </div>
  )
}
