# Road Weather

Which day — and which route — should you drive to avoid black ice, snow and sleet?

Fill in a start and a destination (type them or click the map). Road Weather finds up to
three routes, checks the forecast for the hour you'll actually pass each town along them,
and compares routes, days and departure times. Especially handy in the autumn, before
you've switched to winter tyres.

**Try it:** [bjirch.com/road-weather](https://bjirch.com/road-weather)

## How it works

1. **Route** — [OSRM](https://project-osrm.org/) finds the fastest route. When OSRM has no
   alternatives of its own, the route is pushed sideways through via points; alternatives
   are kept only if they're clearly different and at most ~35 % slower.
2. **Places** — a point every ~40 km on the road itself, named after the nearest town with
   [Photon](https://photon.komoot.io/) (OpenStreetMap).
3. **Forecasts** — for every point, from the services you pick:
   - [Yr / MET Norway](https://api.met.no/) Locationforecast
   - [SMHI](https://opendata.smhi.se/) snow1g (Nordics only)
   - [Open-Meteo](https://open-meteo.com/) — its own blend, plus ECMWF, DWD ICON and NOAA GFS
4. **Risk** — each forecast is scored 0–10 for the hour you're there
   ([`src/lib/risk.js`](src/lib/risk.js)): freezing rain, rain on a frozen road, a wet road
   refreezing (black ice), snow, sleet near zero, frost on damp nights, strong gusts and fog
   score highest; darkness adds a little. Services are blended leaning towards the most
   pessimistic one.
5. **Right now** (Sweden) — live from [Trafikverket's open API](https://api.trafikinfo.trafikverket.se/):
   road surface temperatures measured at the roadside weather stations, road condition
   reports (slippery, ice and snow) and incidents along the chosen route.

The forecast part is a guide for choosing a day, not a road-surface model — it can't see
salting or ploughing. The Trafikverket panel shows what is measured and reported now.

Everything runs in the browser, with no backend. Only the Trafikverket panel needs a key
(free): put it in `.env.local` as `VITE_TRAFIKVERKET_KEY=…` before building, or paste it
into the page, which keeps it in that browser. Without one the rest works as usual.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static files in dist/
```

## Project layout

| File | What it does |
| --- | --- |
| `src/RoadWeather.jsx` | The page: inputs, route comparison, departure grid, stop list |
| `src/lib/api.js` | Geocoding, routing, alternative routes, weather fetching and caching |
| `src/lib/risk.js` | The risk model and trip scoring |
| `src/lib/RouteMap.jsx` | Leaflet map with routes and stops |
| `src/lib/trafikverket.js` | Live road status from Trafikverket, matched to the route |
| `src/lib/RoadReport.jsx` | The "Right now on the road" panel |

## Using the free services fairly

All the data comes from free public services that ask for reasonable use. If you deploy
your own copy for many people, please read their terms:

- **OSRM demo server** — at most about one request per second, not for heavy use.
  Host your own OSRM or use a commercial router for real traffic.
- **Photon** (komoot) — fair use; self-host for heavy use.
- **MET Norway** — [terms of service](https://api.met.no/doc/TermsOfService); throttles bursts.
- **Open-Meteo** — free for non-commercial use, [see terms](https://open-meteo.com/en/terms).
- **SMHI** — open data, CC BY 4.0.
- **Trafikverket** — free key per application; [open data terms](https://api.trafikinfo.trafikverket.se/).
  A key built into the page is visible to anyone, so use one meant for that site.
- **Map tiles** — OpenStreetMap's [tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

## License

MIT — see [LICENSE](LICENSE). Made by [bjirch](https://bjirch.com).
