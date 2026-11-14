// 除錯用：在衛星根數的曆元時刻，比較軌道面法向量與面內相位。
import { createServer } from "vite";
import { join } from "node:path";
import { readFileSync } from "node:fs";
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
const moonsModule = await server.ssrLoadModule("/app/lib/moons.ts");

const centers = { earth: 399, mars: 499, jupiter: 599, saturn: 699, uranus: 799, neptune: 899, pluto: 999 };
const names = process.argv.slice(2);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(...a);
  return a.map((x) => x / l);
};
const ang = (a, b) => (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;

async function state(command, center, jd) {
  const url =
    "https://ssd.jpl.nasa.gov/api/horizons.api?format=text" +
    `&COMMAND='${command}'&OBJ_DATA='NO'&MAKE_EPHEM='YES'&EPHEM_TYPE='VECTORS'&CENTER='500@${center}'` +
    `&TLIST='${jd}'&TLIST_TYPE='JD'&TIME_TYPE='TDB'&REF_PLANE='ECLIPTIC'&OUT_UNITS='KM-S'&VEC_TABLE='2'&CSV_FORMAT='YES'`;
  const text = await fetchCached(`validate/state-${command}-${center}-${jd}.txt`, url);
  const body = text.split("$$SOE")[1]?.split("$$EOE")[0];
  if (!body) throw new Error(text.slice(0, 600));
  const c = body.trim().split("\n")[0].split(",").map(Number);
  return { r: [c[2], c[3], c[4]], v: [c[5], c[6], c[7]] };
}

for (const [planetId, center] of Object.entries(centers)) {
  moonsModule.addMoonSystem(planetId, JSON.parse(readFileSync(join(PUBLIC_DATA, "moons", `${planetId}.json`), "utf8")));
  const planet = lib.getBody(planetId);
  for (const m of planet.children) {
    if (names.length && !names.includes(m.en)) continue;
    for (const jd of [m.data.orbit.epochJd, m.data.orbit.epochJd + 136, m.data.orbit.epochJd - 3650]) {
      lib.updateBodies(jd);
      const ref = await state(m.data.naifId, center, jd);
      const rel = [m.pos[0] - planet.pos[0], m.pos[1] - planet.pos[1], m.pos[2] - planet.pos[2]];
      const nMine = norm(cross(Array.from(m.P), Array.from(m.Q)));
      const nRef = norm(cross(ref.r, ref.v));
      // 面內相位：把兩個位置向量都投影到 Horizons 的軌道面再比較
      const ex = norm(ref.r);
      const ey = cross(nRef, ex);
      const phase = (Math.atan2(rel[0] * ey[0] + rel[1] * ey[1] + rel[2] * ey[2], rel[0] * ex[0] + rel[1] * ex[1] + rel[2] * ex[2]) * 180) / Math.PI;
      console.log(
        `${planet.en}/${m.en}`.padEnd(22),
        m.data.mean.frame.padEnd(10),
        `jd=${jd}`,
        `法向量差 ${ang(nMine, nRef).toFixed(2)}°`.padEnd(16),
        `相位差 ${phase.toFixed(2)}°`.padEnd(16),
        `距離比 ${(Math.hypot(...rel) / Math.hypot(...ref.r)).toFixed(4)}`,
      );
    }
  }
}
await server.close();
