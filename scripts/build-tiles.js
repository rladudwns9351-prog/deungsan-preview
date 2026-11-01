// 전국 등산 지도 타일 생성기 v2 — Overpass 대신 Geofabrik 대한민국 OSM 전체 파일을 내려받아 로컬에서 타일링
// 0.1° 격자(≈11km): 등산로·도로·하천·주차장·봉우리·약수터·쉼터·마을 + DEM(고도 격자 129×129)
// 출처: © OpenStreetMap contributors (ODbL) · 고도: AWS Terrain Tiles(terrarium)
const fs = require("fs"); const path = require("path"); const readline = require("readline"); const { execSync } = require("child_process"); const { PNG } = require("pngjs");

const ROOT = path.join(__dirname, ".."); const OUT = path.join(ROOT, "data", "tiles"); const TMP = path.join(ROOT, ".tmp");
const PEAKS = JSON.parse(fs.readFileSync(path.join(__dirname, "peaks.json"), "utf8"));
const STEP = 0.1, N = 128, Z = 12, MIN_PEAK_H = 100, MARGIN = 0.015;
const PBF_URL = process.env.PBF_URL || "https://download.geofabrik.de/asia/south-korea-latest.osm.pbf";
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(TMP, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tkey = (la, lo) => `${Math.floor(la / STEP + 1e-9)}_${Math.floor(lo / STEP + 1e-9)}`;
const r5 = (v) => Math.round(v * 1e5) / 1e5;

// 1) 대상 타일: 봉우리(100m↑) 포함 타일 + 인접 타일
const want = new Map();
for (const [, , h, la, lo] of PEAKS) { if (h < MIN_PEAK_H) continue; for (const da of [-1, 0, 1]) for (const dl of [-1, 0, 1]) { const k = tkey(la + da * STEP, lo + dl * STEP); if (!want.has(k)) want.set(k, k.split("_").map(Number)); } }
console.log("target tiles:", want.size);

// 2) OSM 추출 (osmium)
function sh(cmd) { console.log("$", cmd); execSync(cmd, { stdio: "inherit", cwd: TMP }); }
const pbf = path.join(TMP, "kr.osm.pbf"), filt = path.join(TMP, "filt.osm.pbf"), gj = path.join(TMP, "filt.geojsonseq");
if (!fs.existsSync(gj)) {
  if (!fs.existsSync(pbf)) sh(`curl -sSL --retry 5 -o kr.osm.pbf "${PBF_URL}"`);
  sh(`osmium tags-filter kr.osm.pbf w/highway=path,footway,track,steps,bridleway,trunk,primary,secondary,tertiary,unclassified,residential w/waterway=river,stream w/natural=water w/amenity=parking n/amenity=parking n/natural=peak n/natural=spring n/amenity=shelter n/place=village,hamlet,town,neighbourhood -o filt.osm.pbf --overwrite`);
  sh(`osmium export filt.osm.pbf -f geojsonseq -o filt.geojsonseq --add-unique-id=type_id --overwrite`);
}

// 3) 지오메트리 → 타일 배분 (타일 경계 밖 MARGIN 이상은 잘라냄)
const tiles = new Map(); // key -> {ways:[], pois:[]}
const T = (k) => { let t = tiles.get(k); if (!t) { t = { ways: [], pois: [] }; tiles.set(k, t); } return t; };
// Douglas-Peucker 단순화 (m 단위 허용오차)
function simplify(pts, tolM) {
  if (pts.length < 3) return pts;
  const tol = tolM / 111320; const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]]; const cosL = Math.cos(pts[0][0] * Math.PI / 180);
  while (stack.length) { const [a, b] = stack.pop(); let md = 0, mi = -1; const ax = pts[a][1] * cosL, ay = pts[a][0], bx = pts[b][1] * cosL, by = pts[b][0]; const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) { const px = pts[i][1] * cosL, py = pts[i][0]; const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0; const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); if (d > md) { md = d; mi = i; } }
    if (md > tol && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); } }
  return pts.filter((_, i) => keep[i]);
}
function kindOf(p) {
  const hw = p.highway;
  if (hw === "footway" && (p.footway === "sidewalk" || p.footway === "crossing")) return null; // 도심 인도·횡단보도 제외
  if (hw === "path" && p.sidewalk) return null;
  if (hw && /^(path|footway|track|steps|bridleway)$/.test(hw)) return ["trail", hw];
  if (hw) return ["road", hw];
  if (p.waterway) return ["water", p.waterway]; if (p.natural === "water") return ["water", "water"];
  if (p.amenity === "parking") return ["parking", "parking"];
  return null;
}
function addWay(id, pts, kind, tag, p) {
  // 걸치는 타일 모두에 (각 타일 범위+MARGIN 안의 점 구간만)
  if (kind === "parking") { // 주차장은 폴리곤 대신 중심점 POI만
    const la = pts.reduce((x, q) => x + q[0], 0) / pts.length, lo = pts.reduce((x, q) => x + q[1], 0) / pts.length; const k = tkey(la, lo);
    if (want.has(k)) T(k).pois.push({ id: "p" + id, lat: r5(la), lng: r5(lo), name: p.name || "주차장", kind: "parking" });
    return;
  }
  pts = simplify(pts, kind === "trail" ? 3 : kind === "road" ? 5 : 8).map((q) => [r5(q[0]), r5(q[1])]);
  const ks = new Set(pts.map((q) => tkey(q[0], q[1])));
  for (const k of ks) {
    if (!want.has(k)) continue;
    const [a, b] = want.get(k); const s = a * STEP - MARGIN, w = b * STEP - MARGIN, n = (a + 1) * STEP + MARGIN, e = (b + 1) * STEP + MARGIN;
    let run = [], part = 0;
    const flush = () => { if (run.length >= 2) { const wid = part ? `${id}_${part}` : id; const o = { id: wid, pts: run, kind, tag }; if (p.name) o.name = p.name; if (p.sac_scale) o.sac = p.sac_scale; T(k).ways.push(o); part++; } run = []; };
    for (let i = 0; i < pts.length; i++) { const q = pts[i]; const inside = q[0] >= s && q[0] <= n && q[1] >= w && q[1] <= e; if (inside) run.push(q); else { if (run.length) { run.push(q); flush(); } if (i + 1 < pts.length) { const nx = pts[i + 1]; if (nx[0] >= s && nx[0] <= n && nx[1] >= w && nx[1] <= e) run.push(q); } } }
    flush();
  }
}
function addNode(id, lat, lng, p) {
  const k = tkey(lat, lng); if (!want.has(k)) return;
  const base = { id, lat: r5(lat), lng: r5(lng) };
  if (p.natural === "peak" && p.name) T(k).pois.push({ ...base, name: p.name, kind: "peak", ele: p.ele ? Number(String(p.ele).replace(/[^0-9.]/g, "")) : undefined });
  else if (p.amenity === "parking") T(k).pois.push({ ...base, name: p.name || "주차장", kind: "parking" });
  else if (p.natural === "spring") T(k).pois.push({ ...base, name: p.name || "약수터", kind: "spring" });
  else if (p.amenity === "shelter") T(k).pois.push({ ...base, name: p.name || "쉼터", kind: "shelter" });
  else if (p.place && p.name) T(k).pois.push({ ...base, name: p.name, kind: "place" });
}
async function ingest() {
  const rl = readline.createInterface({ input: fs.createReadStream(gj), crlfDelay: Infinity }); let n = 0;
  for await (let line of rl) {
    if (line.charCodeAt(0) === 0x1e) line = line.slice(1); if (!line.trim()) continue;
    let f; try { f = JSON.parse(line); } catch { continue; }
    const p = f.properties || {}; const id = String(p["@id"] || f.id || n); const g = f.geometry; if (!g) continue;
    if (g.type === "Point") addNode(id.replace(/^n/, ""), g.coordinates[1], g.coordinates[0], p);
    else if (g.type === "LineString") { const kt = kindOf(p); if (kt) addWay(id.replace(/^w/, ""), g.coordinates.map((c) => [r5(c[1]), r5(c[0])]), kt[0], kt[1], p); }
    else if (g.type === "Polygon") { const kt = kindOf(p); if (kt) addWay(id.replace(/^w/, ""), g.coordinates[0].map((c) => [r5(c[1]), r5(c[0])]), kt[0], kt[1], p); }
    else if (g.type === "MultiPolygon" || g.type === "MultiLineString") { const kt = kindOf(p); if (kt) g.coordinates.forEach((poly, i) => { const ring = g.type === "MultiPolygon" ? poly[0] : poly; addWay(id.replace(/^w/, "") + "m" + i, ring.map((c) => [r5(c[1]), r5(c[0])]), kt[0], kt[1], p); }); }
    if (++n % 200000 === 0) console.log("  features", n);
  }
  console.log("features total", n, "tiles with data", tiles.size);
}

// 4) DEM (terrarium z12)
const demCache = new Map();
async function demTile(x, y) {
  const k = `${x}/${y}`; if (demCache.has(k)) return demCache.get(k);
  const f = path.join(TMP, `dem_${x}_${y}.png`);
  for (let i = 0; i < 4; i++) {
    try {
      let buf; if (fs.existsSync(f)) buf = fs.readFileSync(f); else { const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`); if (r.status === 404) { demCache.set(k, null); return null; } if (!r.ok) throw new Error(r.status); buf = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(f, buf); }
      const png = PNG.sync.read(buf); if (demCache.size > 300) demCache.delete(demCache.keys().next().value); demCache.set(k, png); return png;
    } catch (e) { await sleep(800 * (i + 1)); }
  }
  return null;
}
async function elevAt(lat, lon) {
  const n = 2 ** Z; const xf = ((lon + 180) / 360) * n; const yf = ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  const x = Math.floor(xf), y = Math.floor(yf); const png = await demTile(x, y); if (!png) return null;
  const px = Math.min(255, Math.floor((xf - x) * 256)), py = Math.min(255, Math.floor((yf - y) * 256)); const i = (py * 256 + px) * 4;
  return Math.round(png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768);
}

(async () => {
  await ingest();
  const list = [...want.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let done = 0; const t0 = Date.now();
  for (const [a, b] of list) {
    const k = `${a}_${b}`; const file = path.join(OUT, k + ".json"); const s = a * STEP, w = b * STEP;
    const z = new Array((N + 1) * (N + 1)); let min = 1e9, max = -1e9;
    for (let r = 0; r <= N; r++) for (let c = 0; c <= N; c++) { const v = await elevAt(s + (r * STEP) / N, w + (c * STEP) / N); const vv = v == null ? 0 : v; z[r * (N + 1) + c] = vv; if (vv < min) min = vv; if (vv > max) max = vv; }
    const t = tiles.get(k) || { ways: [], pois: [] };
    fs.writeFileSync(file, JSON.stringify({ v: 3, bbox: [s, w, s + STEP, w + STEP], grid: { lat0: s, lng0: w, dLat: STEP / N, dLng: STEP / N, rows: N + 1, cols: N + 1, z, min, max }, ways: t.ways, pois: t.pois, builtAt: new Date().toISOString() }));
    if (++done % 100 === 0) console.log(`[${done}/${list.length}] ${k} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  const files = fs.readdirSync(OUT).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
  fs.writeFileSync(path.join(OUT, "..", "index.json"), JSON.stringify({ step: STEP, n: N, count: files.length, tiles: files, updatedAt: new Date().toISOString() }));
  console.log("done", files.length, "tiles");
})();
