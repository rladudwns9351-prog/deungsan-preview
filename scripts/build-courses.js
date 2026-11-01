// 산별 코스 사전 계산 — data/tiles 를 읽어 봉우리(300m 이상)마다 들머리→정상 코스(최대 6개)를 계산해 data/mountains/<id>.json 저장
// 앱의 src/lib/route.ts · courses.ts 와 같은 로직 (Node 버전)
const fs = require("fs"); const path = require("path");
const TILES = path.join(__dirname, "..", "data", "tiles"); const OUT = path.join(__dirname, "..", "data", "mountains");
const PEAKS = JSON.parse(fs.readFileSync(path.join(__dirname, "peaks.json"), "utf8"));
const STEP = 0.1, MIN_H = Number(process.env.MIN_H || 300), RADIUS = 4500;
fs.mkdirSync(OUT, { recursive: true });
const hav = (a, b) => { const R = 6371000, r = (d) => d * Math.PI / 180; const x = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
const tileCache = new Map();
function tile(a, b) { const k = `${a}_${b}`; if (tileCache.has(k)) return tileCache.get(k); const f = path.join(TILES, k + ".json"); const t = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; if (tileCache.size > 60) tileCache.delete(tileCache.keys().next().value); tileCache.set(k, t); return t; }
function areaFor(lat, lng) {
  const dLat = RADIUS / 111320, dLng = RADIUS / (111320 * Math.cos(lat * Math.PI / 180));
  const a0 = Math.floor((lat - dLat) / STEP + 1e-9), a1 = Math.floor((lat + dLat) / STEP + 1e-9), b0 = Math.floor((lng - dLng) / STEP + 1e-9), b1 = Math.floor((lng + dLng) / STEP + 1e-9);
  const ts = []; for (let a = a0; a <= a1; a++) for (let b = b0; b <= b1; b++) { const t = tile(a, b); if (!t) return null; ts.push(t); }
  const seen = new Set(), ways = [], pois = []; const inR = (la, lo) => hav([la, lo], [lat, lng]) <= RADIUS * 1.3;
  for (const t of ts) { for (const w of t.ways) if (!seen.has(w.id) && w.pts.some((p) => inR(p[0], p[1]))) { seen.add(w.id); ways.push(w); } for (const p of t.pois) if (!seen.has(p.id) && inR(p.lat, p.lng)) { seen.add(p.id); pois.push(p); } }
  // 고도 조회용 (타일 직접 참조)
  const elev = (la, lo) => { const t = tile(Math.floor(la / STEP + 1e-9), Math.floor(lo / STEP + 1e-9)); if (!t || !t.grid || t.grid.max <= t.grid.min) return null; const g = t.grid; const fr = (la - g.lat0) / g.dLat, fc = (lo - g.lng0) / g.dLng; const r = Math.min(g.rows - 2, Math.max(0, Math.floor(fr))), c = Math.min(g.cols - 2, Math.max(0, Math.floor(fc))); const z = (rr, cc) => g.z[rr * g.cols + cc]; const tr = fr - r, tc = fc - c; return z(r, c) * (1 - tr) * (1 - tc) + z(r, c + 1) * (1 - tr) * tc + z(r + 1, c) * tr * (1 - tc) + z(r + 1, c + 1) * tr * tc; };
  return { ways, pois, elev };
}
function buildGraph(area) {
  const g = new Map(); const get = (id, p) => { let n = g.get(id); if (!n) { n = { id, lat: p[0], lng: p[1], adj: [] }; g.set(id, n); } return n; };
  const add = (w, f) => { const nodes = w.nodes && w.nodes.length === w.pts.length ? w.nodes : w.pts.map((p) => p[0] + "," + p[1]); for (let i = 1; i < w.pts.length; i++) { const a = get(nodes[i - 1], w.pts[i - 1]), b = get(nodes[i], w.pts[i]); const d = hav(w.pts[i - 1], w.pts[i]) * f; a.adj.push({ to: b.id, w: d }); b.adj.push({ to: a.id, w: d }); } };
  for (const w of area.ways) { if (w.kind === "trail") add(w, 1); else if (w.kind === "road") add(w, w.tag === "steps" ? 1 : 1.3); }
  return g;
}
function nearest(g, p) { let best = null, bd = Infinity; for (const n of g.values()) { const d = hav(p, [n.lat, n.lng]); if (d < bd) { bd = d; best = n; } } return best ? { node: best, distM: bd } : null; }
class Heap { constructor() { this.a = []; } push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } } pop() { const a = this.a; if (!a.length) return; const top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; } get size() { return this.a.length; } }
function dijkstra(g, src) { const dist = new Map(), prev = new Map(), done = new Set(); const h = new Heap(); dist.set(src.id, 0); h.push([0, src.id]); while (h.size) { const [d, id] = h.pop(); if (done.has(id)) continue; done.add(id); for (const e of g.get(id).adj) { const nd = d + e.w; if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, id); h.push([nd, e.to]); } } } return { dist, prev }; }
const r5 = (v) => Math.round(v * 1e5) / 1e5;
function routeTo(g, D, src, from, to) { const n = nearest(g, from); if (!n || n.distM > 1500 || !D.dist.has(n.node.id)) return null; const ids = []; let cur = n.node.id; while (cur) { ids.push(cur); if (cur === src.id) break; cur = D.prev.get(cur); } const pts = [from, ...ids.map((i) => { const x = g.get(i); return [x.lat, x.lng]; }), to].map((p) => [r5(p[0]), r5(p[1])]); let len = 0; for (let i = 1; i < pts.length; i++) len += hav(pts[i - 1], pts[i]); return { pts, lengthM: Math.round(len) }; }
function candidates(area, m) {
  const out = []; const dist = (p) => hav(p, [m.lat, m.lng]);
  for (const p of area.pois) if (p.kind === "parking") { const d = dist([p.lat, p.lng]); if (d > 250 && d < 7000) out.push({ pt: [p.lat, p.lng], name: p.name, source: "parking", score: 0 }); }
  const cell = (la, lo) => `${Math.round(la / 0.00045)}:${Math.round(lo / 0.00055)}`; const idx = new Map();
  for (const w of area.ways) if (w.kind === "road") for (const p of w.pts) { const k = cell(p[0], p[1]); (idx.get(k) || idx.set(k, []).get(k)).push(p); }
  const nearRoad = (p) => { const r0 = Math.round(p[0] / 0.00045), c0 = Math.round(p[1] / 0.00055); for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const arr = idx.get(`${r0 + dr}:${c0 + dc}`); if (arr && arr.some((q) => hav(q, p) < 40)) return true; } return false; };
  for (const w of area.ways) { if (w.kind !== "trail" || w.pts.length < 2) continue; for (const end of [w.pts[0], w.pts[w.pts.length - 1]]) { const d = dist(end); if (d > 400 && d < 7000 && nearRoad(end)) out.push({ pt: end, name: w.name ? `${w.name} 입구` : "등산로 입구", source: "trailhead", score: 1 }); } }
  for (const p of area.pois) if (p.kind === "place") { const d = dist([p.lat, p.lng]); if (d > 500 && d < 7000) out.push({ pt: [p.lat, p.lng], name: p.name, source: "place", score: 2 }); }
  out.sort((a, b) => a.score - b.score); const kept = []; for (const c of out) if (!kept.some((k) => hav(k.pt, c.pt) < 300)) kept.push(c); return kept.slice(0, 14);
}
function overlap(a, b) { const cell = (p) => `${Math.round(p[0] / 0.0005)}:${Math.round(p[1] / 0.0006)}`; const bs = new Set(b.pts.map(cell)); let hit = 0; for (let i = 0; i < a.pts.length; i += 2) if (bs.has(cell(a.pts[i]))) hit++; return hit / Math.ceil(a.pts.length / 2); }
const COLORS = ["#E8A33D", "#2E7D5B", "#D9534F", "#5B7FD9", "#9B59B6", "#1ABC9C"];
function courses(area, m) {
  const g = buildGraph(area); if (!g.size) return [];
  const s = nearest(g, [m.lat, m.lng]); if (!s || s.distM > 800) return [];
  const D = dijkstra(g, s.node); const found = [];
  for (const c of candidates(area, m)) { const r = routeTo(g, D, s.node, c.pt, [m.lat, m.lng]); if (!r || r.lengthM < 300) continue; if (found.some((f) => overlap(r, f.route) > 0.6)) continue; found.push({ route: r, cand: c }); if (found.length >= 6) break; }
  found.sort((a, b) => a.route.lengthM - b.route.lengthM);
  return found.map((f, i) => {
    const startAlt = Math.round(area.elev(f.cand.pt[0], f.cand.pt[1]) ?? m.h * 0.3);
    let asc = 0, prev = null; const stepN = Math.max(1, Math.floor(f.route.pts.length / 60)); for (let k = 0; k < f.route.pts.length; k += stepN) { const z = area.elev(f.route.pts[k][0], f.route.pts[k][1]); if (z == null) continue; if (prev != null && z > prev) asc += z - prev; prev = z; }
    const ascentM = Math.round(asc || Math.max(0, m.h - startAlt)); const km = f.route.lengthM / 1000; const rtH = (2 * km) / 4 + ascentM / 500;
    const diff = ascentM < 300 && rtH < 2.5 ? 1 : ascentM >= 700 || rtH >= 5 ? 3 : 2;
    return { id: `c${i}`, color: COLORS[i % COLORS.length], ascentM, rtH: Math.round(rtH * 100) / 100, diff, source: f.cand.source, name: `${f.cand.name.replace(/\s*주차장$/, "") || f.cand.name} → 정상`, start: f.cand.name, startAddr: "", park: f.cand.source === "parking" ? f.cand.name : `${f.cand.name} (주차장 미확인)`, parkAddr: "", parkLat: f.cand.pt[0], parkLng: f.cand.pt[1], parkDist: Math.round(hav(f.cand.pt, [m.lat, m.lng])), dist: Math.round(km * 10) / 10, startAlt, estimated: false, route: f.route };
  });
}
(async () => {
  const list = PEAKS.filter((p) => p[2] >= MIN_H).filter(([id]) => !fs.existsSync(path.join(OUT, id + ".json")));
  console.log("mountains to build:", list.length);
  let done = 0, skipped = 0; const t0 = Date.now();
  for (const [id, name, h, lat, lng] of list) {
    const area = areaFor(lat, lng); if (!area) { skipped++; continue; }
    try { const cs = courses(area, { id, name, h, lat, lng }); fs.writeFileSync(path.join(OUT, id + ".json"), JSON.stringify({ v: 1, id, name, h, lat, lng, courses: cs, builtAt: new Date().toISOString() })); done++; }
    catch (e) { console.log("fail", id, name, String(e.message || e)); }
    if (done % 200 === 0 && done) console.log(`[${done}] ${name} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  console.log("done", done, "skipped(no tiles)", skipped);
})();
