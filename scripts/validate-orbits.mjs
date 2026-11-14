// 驗證：把專案實際使用的軌道計算程式（app/lib）與 JPL Horizons 的向量星曆比對。
// 用法：node scripts/validate-orbits.mjs [--moons]
import { createServer } from "vite";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { PUBLIC_DATA, ROOT, fetchCached } from "./lib/common.mjs";

const server = await createServer({
  configFile: false,
  root: ROOT,
  resolve: { alias: { "~": join(ROOT, "app") } },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  logLevel: "error",
});
const lib = await server.ssrLoadModule("/app/lib/bodies.ts");

const DATES = [
  ["1900-01-01", 2415020.5],
  ["2000-01-01", 2451544.5],
  ["2026-11-14", 2461358.5],
];

async function horizonsVector(command, center, date) {
  const next = new Date(Date.parse(date + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  const url =
    "https://ssd.jpl.nasa.gov/api/horizons.api?format=text" +
    `&COMMAND='${encodeURIComponent(command)}'&OBJ_DATA='NO'&MAKE_EPHEM='YES'&EPHEM_TYPE='VECTORS'&CENTER='${center}'` +
    `&START_TIME='${date}'&STOP_TIME='${next}'&STEP_SIZE='2 d'&REF_PLANE='ECLIPTIC'&OUT_UNITS='KM-S'&VEC_TABLE='1'&CSV_FORMAT='YES'`;
  const text = await fetchCached(`validate/${command.replace(/\W/g, "")}-${center.replace("@", "_")}-${date}.txt`, url);
  const body = text.split("$$SOE")[1]?.split("$$EOE")[0];
  if (!body) throw new Error(`Horizons 無資料: ${command} ${date}\n${text.slice(0, 400)}`);
  const cols = body.trim().split("\n")[0].split(",");
  return [Number(cols[2]), Number(cols[3]), Number(cols[4])];
}

function compare(mine, ref) {
  const dot = mine[0] * ref[0] + mine[1] * ref[1] + mine[2] * ref[2];
  const lm = Math.hypot(...mine);
  const lr = Math.hypot(...ref);
  const ang = (Math.acos(Math.min(1, Math.max(-1, dot / (lm * lr)))) * 180) / Math.PI;
  return { angDeg: ang, distErrPct: ((lm - lr) / lr) * 100 };
}

const rows = [];
const helio = lib.bodies.filter((b) => b.kind === "planet" || b.kind === "dwarf");
for (const b of helio) {
  // 地球的根數是地月系質心，所以與 Horizons 的質心 (3) 比對
  const command = b.id === "earth" ? "3" : b.kind === "planet" ? String(b.data.naifId) : `DES=${b.data.spkId};`;
  for (const [date, jd] of DATES) {
    lib.updateBodies(jd);
    const ref = await horizonsVector(command, "500@10", date);
    rows.push({ body: b.en, date, ...compare(Array.from(b.pos), ref) });
  }
}

if (process.argv.includes("--moons")) {
  const moonsModule = await server.ssrLoadModule("/app/lib/moons.ts");
  const planetCenters = { earth: 399, mars: 499, jupiter: 599, saturn: 699, uranus: 799, neptune: 899, pluto: 999 };
  const SAMPLE = new Set([
    "Moon", "Phobos", "Deimos", "Io", "Europa", "Ganymede", "Callisto", "Himalia", "Carme", "Mimas", "Titan",
    "Iapetus", "Phoebe", "Miranda", "Titania", "Oberon", "Sycorax", "Triton", "Nereid", "Proteus", "Charon", "Hydra",
  ]);
  for (const [planetId, center] of Object.entries(planetCenters)) {
    const file = join(PUBLIC_DATA, "moons", `${planetId}.json`);
    if (!existsSync(file)) continue;
    moonsModule.addMoonSystem(planetId, JSON.parse(readFileSync(file, "utf8")));
    const planet = lib.getBody(planetId);
    for (const m of planet.children) {
      if (!SAMPLE.has(m.en)) continue;
      for (const [date, jd] of DATES.slice(1)) {
        lib.updateBodies(jd);
        const ref = await horizonsVector(String(m.data.naifId), `500@${center}`, date);
        const rel = [m.pos[0] - planet.pos[0], m.pos[1] - planet.pos[1], m.pos[2] - planet.pos[2]];
        // 軌道面法向量的夾角比相位更能反映座標系是否正確
        rows.push({ body: `${planet.en}/${m.en}`, date, ...compare(rel, ref) });
      }
    }
  }
}

console.table(
  rows.map((r) => ({ 天體: r.body, 日期: r.date, "方向誤差(°)": r.angDeg.toFixed(3), "距離誤差(%)": r.distErrPct.toFixed(3) })),
);
await server.close();
