// 驗證：用專案實際使用的內插程式（app/lib/spacecraft.ts 的 evalSegment）讀精簡後的軌跡檔，
// 在「不是取樣點」的時刻計算位置，與 JPL Horizons 重新查詢的結果比對。
// 用法：node scripts/validate-spacecraft.mjs
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { APP_DATA, PUBLIC_DATA, ROOT, fetchCached, readJson } from "./lib/common.mjs";

const server = await createServer({
  configFile: false,
  root: ROOT,
  resolve: { alias: { "~": join(ROOT, "app") } },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  logLevel: "error",
});
const lib = await server.ssrLoadModule("/app/lib/spacecraft.ts");
const index = await readJson(join(APP_DATA, "spacecraft.json"));
const solar = await readJson(join(APP_DATA, "solar-system.json"));
const naif = Object.fromEntries(solar.planets.map((p) => [p.id, p.naifId]));

async function horizons(cmd, center, jd) {
  const url =
    "https://ssd.jpl.nasa.gov/api/horizons.api?format=text" +
    `&COMMAND='${cmd}'&OBJ_DATA='NO'&MAKE_EPHEM='YES'&EPHEM_TYPE='VECTORS'&CENTER='${center}'` +
    `&TLIST='${jd.toFixed(6)}'&REF_PLANE='ECLIPTIC'&REF_SYSTEM='ICRF'&OUT_UNITS='KM-S'&VEC_TABLE='2'&VEC_CORR='NONE'&CSV_FORMAT='YES'`;
  const text = await fetchCached(`validate/sc-${cmd}-${center.replace("@", "_")}-${jd.toFixed(4)}.txt`, url);
  const row = text.split("$$SOE")[1]?.split("$$EOE")[0]?.trim().split(",").map((s) => s.trim());
  if (!row) throw new Error(`Horizons 無資料 ${cmd} ${jd}\n${text.slice(-300)}`);
  return [Number(row[2]), Number(row[3]), Number(row[4])];
}

// 每個探測器取 6 個時刻：涵蓋期間內的固定比例，刻意避開取樣點
const FRACTIONS = [0.0137, 0.211, 0.4033, 0.6071, 0.8123, 0.9871];
let worstRel = 0;
let worstKm = 0;
const OBL = (await server.ssrLoadModule("/app/lib/constants.ts")).OBLIQUITY;
for (const c of index.craft.filter((x) => x.elements)) {
  // 地球衛星：用 computeOrbiter（軌道根數內插）與 Horizons 地心向量比對
  const buf = (await readFile(join(PUBLIC_DATA, "spacecraft", `${c.id}.bin`))).buffer;
  const fake = { rec: c, orb: new Float32Array(buf, 0, c.elements.n * 6), osc: null };
  const parts = [];
  for (const f of FRACTIONS) {
    const jd = c.coverage.start + (c.coverage.end - c.coverage.start) * f + 0.3721;
    if (jd > c.coverage.end) continue;
    const p = [0, 0, 0];
    lib.computeOrbiter(fake, jd, p, [0, 0, 0]);
    const ref = await horizons(c.horizonsId, "500@399", jd); // 黃道座標
    const err = Math.hypot(p[0] - ref[0], p[1] - ref[1], p[2] - ref[2]);
    worstKm = Math.max(worstKm, err);
    parts.push(`${err.toFixed(1)} km`);
  }
  console.log(`${c.id.padEnd(20)} ${parts.join("  ")}`);
}
void OBL;
console.log(`地球衛星最大誤差：${worstKm.toFixed(1)} km\n`);
for (const c of index.craft.filter((x) => !x.elements)) {
  const buf = (await readFile(join(PUBLIC_DATA, "spacecraft", `${c.id}.bin`))).buffer;
  const segs = c.segments.map((s) => ({
    center: s.center,
    t: new Float64Array(buf, s.tOff, s.n),
    pv: new Float32Array(buf, s.pvOff, s.n * 6),
    t0: s.t0,
    t1: s.t1,
  }));
  const parts = [];
  for (const f of FRACTIONS) {
    const jd = c.coverage.start + (c.coverage.end - c.coverage.start) * f;
    const seg = segs.find((s) => jd >= s.t0 && jd <= s.t1) ?? segs[segs.length - 1];
    const out = [0, 0, 0, 0, 0, 0];
    lib.evalSegment(seg, jd, out);
    const center = seg.center === "sun" ? "500@10" : `500@${naif[seg.center]}`;
    const ref = await horizons(c.horizonsId, center, jd);
    const err = Math.hypot(out[0] - ref[0], out[1] - ref[1], out[2] - ref[2]);
    const rel = err / Math.hypot(...ref);
    worstRel = Math.max(worstRel, rel);
    parts.push(`${seg.center === "sun" ? "日心" : seg.center} ${(rel * 100).toFixed(4)}%`);
  }
  console.log(`${c.id.padEnd(20)} ${parts.join("  ")}`);
}
console.log(`\n最大誤差：到中心距離的 ${(worstRel * 100).toFixed(4)}%`);
await server.close();
