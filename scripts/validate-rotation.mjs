// 驗證：把專案的自轉模型（app/lib/rotation.ts）算出的「地心看到的星下點」經緯度，
// 與 JPL Horizons 的 ObsSub-LON / ObsSub-LAT 比對。
// 用法：node scripts/validate-rotation.mjs
import { createServer } from "vite";
import { join } from "node:path";
import { ROOT, fetchCached, readJson } from "./lib/common.mjs";

const server = await createServer({
  configFile: false,
  root: ROOT,
  resolve: { alias: { "~": join(ROOT, "app") } },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  logLevel: "error",
});
const rot = await server.ssrLoadModule("/app/lib/rotation.ts");
const { OBLIQUITY } = await server.ssrLoadModule("/app/lib/constants.ts");
const solar = await readJson(join(ROOT, "app/data/solar-system.json"));
// Horizons 的緯度是橢球上的行星面緯度，比較前需用三軸半徑換算
const moonRadii = {};
for (const sys of ["earth", "jupiter", "saturn", "neptune", "pluto"]) {
  for (const m of (await readJson(join(ROOT, `public/data/moons/${sys}.json`))).moons) {
    if (m.radiiKm?.length === 3) moonRadii[m.id] = [(m.radiiKm[0] + m.radiiKm[1]) / 2, 0, m.radiiKm[2]];
  }
}

const TARGETS = [
  ["mercury", "199"],
  ["earth-moon", "301"],
  ["mars", "499"],
  ["jupiter", "599"],
  ["jupiter-io", "501"],
  ["jupiter-callisto", "504"],
  ["saturn", "699"],
  ["saturn-iapetus", "608"],
  ["uranus", "799"],
  ["neptune", "899"],
  ["neptune-triton", "801"],
  ["pluto", "999"],
  ["pluto-charon", "901"],
];
const DATES = ["2000-01-01", "2026-11-14", "2045-06-01"];

async function horizons(cmd, date) {
  const next = new Date(Date.parse(date + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  const url =
    "https://ssd.jpl.nasa.gov/api/horizons.api?format=text" +
    `&COMMAND='${cmd}'&OBJ_DATA='NO'&MAKE_EPHEM='YES'&EPHEM_TYPE='OBSERVER'&CENTER='500@399'` +
    `&START_TIME='${date}'&STOP_TIME='${next}'&STEP_SIZE='2 d'&QUANTITIES='1,14,21'&ANG_FORMAT='DEG'&CSV_FORMAT='YES'&TIME_TYPE='TT'`;
  const text = await fetchCached(`validate/rot-${cmd}-${date}.txt`, url);
  const header = text.split("$$SOE")[0];
  const cols = header.trim().split("\n").filter((l) => l.includes("R.A.")).pop().split(",").map((s) => s.trim());
  const row = text.split("$$SOE")[1].split("$$EOE")[0].trim().split("\n")[0].split(",").map((s) => s.trim());
  const get = (name) => Number(row[cols.findIndex((c) => c.startsWith(name))]);
  const jdTT = 2451545 + (Date.parse(date + "T00:00:00Z") - Date.parse("2000-01-01T12:00:00Z")) / 86400000;
  return { ra: get("R.A."), dec: get("DEC"), lon: get("ObsSub-LON"), lat: get("ObsSub-LAT"), ltMin: get("1-way_down_LT"), jdTT, header };
}

const DEG = Math.PI / 180;
const frame = new Float64Array(9);
let worst = 0;
let printedConvention = false;
for (const [id, cmd] of TARGETS) {
  const model = rot.rotationModel(id);
  if (!model) throw new Error(`rotation.json 沒有 ${id}`);
  const radii = solar.planets.find((p) => p.id === id)?.radiiKm ?? moonRadii[id];
  for (const date of DATES) {
    const h = await horizons(cmd, date);
    if (!printedConvention) {
      const note = /ObsSub-LON & ObsSub-LAT[\s\S]*?(?=\n\s*\n)/.exec(h.header)?.[0];
      if (note) console.log(note.replace(/\s+/g, " ").slice(0, 600) + "\n");
      printedConvention = true;
    }
    // 目標 → 觀測者方向（黃道座標）：天球赤道方向取反再轉到黃道
    const ra = h.ra * DEG, de = h.dec * DEG;
    const ex = -Math.cos(de) * Math.cos(ra), ey = -Math.cos(de) * Math.sin(ra), ez = -Math.sin(de);
    const v = [ex, ey * Math.cos(OBLIQUITY) + ez * Math.sin(OBLIQUITY), -ey * Math.sin(OBLIQUITY) + ez * Math.cos(OBLIQUITY)];
    // 光行時：用光離開目標時的自轉角
    rot.bodyFrame(model, h.jdTT - h.ltMin / 1440, frame);
    const sp = rot.subPoint(frame, v);
    let lat = sp.lat;
    if (radii) lat = Math.atan(Math.tan(lat * DEG) * (radii[0] / radii[2]) ** 2) / DEG; // 換成行星面（planetodetic）緯度
    // Horizons 的經度：依標頭說明，正向自轉天體用西經；比較時兩種都換成東經
    const dE = ((sp.lonE - h.lon + 540) % 360) - 180;
    const dW = ((sp.lonE + h.lon + 540) % 360) - 180;
    const dLon = Math.abs(dE) < Math.abs(dW) ? dE : dW;
    const conv = Math.abs(dE) < Math.abs(dW) ? "E" : "W";
    const dLat = lat - h.lat;
    worst = Math.max(worst, Math.abs(dLon) * Math.cos(h.lat * DEG), Math.abs(dLat));
    console.log(
      `${id.padEnd(17)} ${date}  本專案 經${sp.lonE.toFixed(2).padStart(7)}° 緯${lat.toFixed(2).padStart(7)}°  ` +
        `Horizons 經${h.lon.toFixed(2).padStart(7)}°(${conv}) 緯${h.lat.toFixed(2).padStart(7)}°  差 ${dLon.toFixed(2)}° / ${dLat.toFixed(2)}°`,
    );
  }
}
console.log(`\n最大差異（換算成大圓角度）：${worst.toFixed(2)}°`);
await server.close();
