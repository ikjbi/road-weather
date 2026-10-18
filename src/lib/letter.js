// 0 → A, 25 → Z, 26 → AA …
export function letter(i) {
  let s = ''
  i += 1
  while (i > 0) {
    const r = (i - 1) % 26
    s = String.fromCharCode(65 + r) + s
    i = Math.floor((i - 1) / 26)
  }
  return s
}

// Line colours for route A, B, C on the map and in tags.
export const ROUTE_COLORS = ['#38bdf8', '#c084fc', '#f472b6']
