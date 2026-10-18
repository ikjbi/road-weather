import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { level } from './risk'
import { ROUTE_COLORS, letter } from './letter'

function pin(text, color) {
  return L.divIcon({
    className: '',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    html: `<div style="width:26px;height:26px;border-radius:50%;background:${color};color:#0f172a;
      font:700 12px system-ui;display:flex;align-items:center;justify-content:center;
      border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)">${text}</div>`,
  })
}

// routes: every candidate route (A, B, C); stops: the selected route's
// waypoints, with an optional `combined` risk score each.
export default function RouteMap({ from, to, routes, selectedRoute, onSelectRoute, stops, onPick, selectedIndex, onSelectStop }) {
  const el = useRef(null)
  const map = useRef(null)
  const routeLayer = useRef(null)
  const layer = useRef(null)
  const pickRef = useRef(onPick)
  const selectRouteRef = useRef(onSelectRoute)
  const fitted = useRef(null)

  useEffect(() => {
    pickRef.current = onPick
    selectRouteRef.current = onSelectRoute
  }, [onPick, onSelectRoute])

  useEffect(() => {
    const m = L.map(el.current, { zoomControl: true }).setView([62, 16], 5)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(m)
    m.on('click', e => pickRef.current?.(e.latlng.lat, e.latlng.lng))
    routeLayer.current = L.layerGroup().addTo(m)
    layer.current = L.layerGroup().addTo(m)
    map.current = m
    return () => m.remove()
  }, [])

  // Fit the view only when a new set of routes arrives, not on selection
  // or when town names fill in.
  useEffect(() => {
    if (!routes?.length || fitted.current === routes[0]) return
    fitted.current = routes[0]
    const bounds = L.latLngBounds(routes.flatMap(r => r.coords.filter((_, i) => i % 50 === 0).concat([r.coords.at(-1)])))
    map.current.fitBounds(bounds, { padding: [30, 30] })
  }, [routes])

  useEffect(() => {
    const g = routeLayer.current
    g.clearLayers()
    if (!routes?.length) return
    // Unselected routes first so the selected one is drawn on top.
    const order = routes.map((_, i) => i).sort((a, b) => (a === selectedRoute) - (b === selectedRoute))
    for (const i of order) {
      const on = i === selectedRoute
      L.polyline(routes[i].coords, {
        color: ROUTE_COLORS[i % ROUTE_COLORS.length],
        weight: on ? 6 : 4,
        opacity: on ? 0.95 : 0.5,
        dashArray: on ? null : '8 8',
      })
        .bindTooltip(`Route ${letter(i)}`, { sticky: true })
        .on('click', e => {
          L.DomEvent.stopPropagation(e)
          selectRouteRef.current?.(i)
        })
        .addTo(g)
    }
  }, [routes, selectedRoute])

  useEffect(() => {
    const g = layer.current
    g.clearLayers()
    if (stops?.length) {
      stops.forEach((s, i) => {
        const color = s.combined != null ? level(s.combined).color : '#e2e8f0'
        const m = L.marker([s.lat, s.lon], {
          icon: pin(i + 1, color),
          zIndexOffset: i === selectedIndex ? 1000 : 0,
        })
          .bindTooltip(`${i + 1} · ${s.name ?? `km ${Math.round(s.km)}`}`)
          .on('click', () => onSelectStop?.(i))
          .addTo(g)
        if (i === selectedIndex) m.openTooltip()
      })
    } else {
      if (from) L.marker([from.lat, from.lon], { icon: pin('S', '#e2e8f0') }).bindTooltip('Start').addTo(g)
      if (to) L.marker([to.lat, to.lon], { icon: pin('🏁', '#e2e8f0') }).bindTooltip('Destination').addTo(g)
      const pts = [from, to].filter(Boolean)
      if (!routes?.length && pts.length === 2) map.current.fitBounds(pts.map(p => [p.lat, p.lon]), { padding: [40, 40] })
      else if (!routes?.length && pts.length === 1) map.current.setView([pts[0].lat, pts[0].lon], 8)
    }
  }, [from, to, routes, stops, selectedIndex, onSelectStop])

  return <div ref={el} className="w-full h-full rounded-2xl overflow-hidden" style={{ minHeight: 320 }} />
}
