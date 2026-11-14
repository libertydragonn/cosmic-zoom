// 擷取太陽、八大行星、矮行星的軌道根數與物理參數。
// 來源：JPL SSD approx_pos / phys_par、JPL Horizons、JPL SBDB、NAIF PCK。
// 輸出：app/data/solar-system.json
import { join } from "node:path";
import * as cheerio from "cheerio";
import { APP_DATA, fetchCached, htmlToText, num, sourceInfo, writeJson } from "./lib/common.mjs";
import { ZH_BODY } from "./lib/zh-names.mjs";

const missing = [];
const noteMissing = (body, field, why) => missing.push({ body, field, reason: why });

// ---------- 1. 行星軌道根數（Standish, JPL approx_pos） ----------
const PLANET_NAMES = ["Mercury", "Venus", "EM Bary", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"];
const approxHtml = await fetchCached("jpl-approx_pos.html", "https://ssd.jpl.nasa.gov/planets/approx_pos.html");
const approxText = htmlToText(approxHtml);

function parseElementTable(section) {
  const out = {};
  const nums = "([-+]?\\d+\\.\\d+)";
  for (const name of PLANET_NAMES) {
    const re = new RegExp(
      name.replace(" ", "\\s+") + "\\s+" + Array(6).fill(nums).join("\\s+") + "\\s+" + Array(6).fill(nums).join("\\s+"),
    );
    const m = section.match(re);
    if (!m) throw new Error(`approx_pos: 找不到 ${name} 的根數`);
    const v = m.slice(1).map(Number);
    // 每個根數為 [J2000 值, 每世紀變率]
    out[name] = {
      a: [v[0], v[6]], // au
      e: [v[1], v[7]],
      I: [v[2], v[8]], // deg
      L: [v[3], v[9]], // deg
      peri: [v[4], v[10]], // 近日點黃經 deg
      node: [v[5], v[11]], // 升交點黃經 deg
    };
  }
  return out;
}

const iT1 = approxText.lastIndexOf("Table 1");
const iT2a = approxText.lastIndexOf("Table 2a");
const iT2b = approxText.lastIndexOf("Table 2b");
if (iT1 < 0 || iT2a < 0 || iT2b < 0) throw new Error("approx_pos: 頁面結構改變");
const table1 = parseElementTable(approxText.slice(iT1, iT2a));
const table2 = parseElementTable(approxText.slice(iT2a, iT2b));
const table2b = {};
for (const name of ["Jupiter", "Saturn", "Uranus", "Neptune"]) {
  const m = approxText
    .slice(iT2b)
    .match(new RegExp(name + "\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)"));
  if (!m) throw new Error(`approx_pos: 找不到 ${name} 的 Table 2b`);
  table2b[name] = { b: +m[1], c: +m[2], s: +m[3], f: +m[4] };
}
const oblM = approxHtml.match(/23\\rlap\s*\.\{\^\{\\rm o\}\s*(\d+)\}/);
if (!oblM) throw new Error("approx_pos: 找不到黃赤交角");
const obliquityDeg = Number("23." + oblM[1]);

// ---------- 2. 行星與矮行星物理參數（JPL phys_par） ----------
const physHtml = await fetchCached("jpl-planets-phys_par.html", "https://ssd.jpl.nasa.gov/planets/phys_par.html");
const $ = cheerio.load(physHtml);
const PHYS_KEYS = [
  "equatorialRadiusKm",
  "meanRadiusKm",
  "massKg",
  "densityGcm3",
  "rotationPeriodDays",
  "orbitalPeriodYears",
  "v10Mag",
  "geometricAlbedo",
  "equatorialGravityMs2",
  "escapeVelocityKms",
];
const phys = {};
$("table.planet-phys-par").each((_, table) => {
  const headText = $(table).find("thead").text().replace(/\s+/g, " ");
  const massExp = headText.match(/10\s*(\d+)\s*kg/);
  if (!massExp) throw new Error("phys_par: 找不到質量單位");
  const massUnit = 10 ** Number(massExp[1]);
  $(table)
    .find("tbody tr")
    .each((_, tr) => {
      const tds = $(tr).find("td");
      const name = $(tds[0]).text().trim();
      if (!name || tds.length < 11) return;
      const rec = {};
      PHYS_KEYS.forEach((key, i) => {
        const txt = $(tds[i + 1]).text().replace(/\s+/g, " ");
        const value = num(txt.split("[")[0]);
        const sigmaM = txt.match(/±\s*([\d.]+)/);
        if (value == null) {
          noteMissing(name, key, "JPL phys_par 表格此欄為空");
          rec[key] = null;
          return;
        }
        rec[key] = key === "massKg" ? value * massUnit : value;
        if (sigmaM) rec[key + "Sigma"] = key === "massKg" ? Number(sigmaM[1]) * massUnit : Number(sigmaM[1]);
      });
      phys[name] = rec;
    });
});

// ---------- 3. 行星 GM（JPL sats/phys_par 頁內的行星 GM 表） ----------
const satPhysHtml = await fetchCached("jpl-sats-phys_par.html", "https://ssd.jpl.nasa.gov/sats/phys_par/");
const $s = cheerio.load(satPhysHtml);
const planetGM = {};
$s("table.astro-par-table tr").each((_, tr) => {
  const tds = $s(tr).find("td");
  if (tds.length < 2) return;
  const name = $s(tds[0]).text().trim();
  const v = num($s(tds[1]).text());
  if (name && v != null) planetGM[name] = v;
});

// ---------- 4. 自轉軸方向與三軸半徑（NAIF pck00011.tpc） ----------
const pck = await fetchCached("naif-pck00011.tpc", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc");
const pckVals = {};
for (const block of pck.split("\\begindata").slice(1)) {
  const data = block.split("\\begintext")[0];
  for (const m of data.matchAll(/BODY(\d+)_([A-Z_]+)\s*=\s*\(([^)]*)\)/g)) {
    const values = m[3]
      .trim()
      .split(/[\s,]+/)
      .map((x) => Number(x.replace(/D/i, "E")));
    (pckVals[m[1]] ??= {})[m[2]] = values;
  }
}
function poleOf(naifId, name) {
  const b = pckVals[naifId];
  if (!b?.POLE_RA || !b?.POLE_DEC) {
    noteMissing(name, "pole", "NAIF PCK 無自轉軸資料");
    return null;
  }
  // 取 J2000 的值（忽略極緩慢的歲差項）
  const pole = { raDeg: b.POLE_RA[0], decDeg: b.POLE_DEC[0] };
  if (b.PM) pole.rotationDegPerDay = b.PM[1];
  return pole;
}

// ---------- 5. 太陽（JPL Horizons 物件資料頁） ----------
const sunText = await fetchCached(
  "horizons-sun.txt",
  "https://ssd.jpl.nasa.gov/api/horizons.api?format=text&COMMAND='10'&MAKE_EPHEM='NO'&OBJ_DATA='YES'",
);
function sunField(re, label) {
  const m = sunText.match(re);
  if (!m) {
    noteMissing("Sun", label, "Horizons 物件資料頁找不到此欄位");
    return null;
  }
  return Number(m[1]);
}
const sunMass1e24 = sunField(/Mass, 10\^24 kg\s*=\s*~?([\d.]+)/, "massKg");
const sun = {
  id: "sun",
  en: "Sun",
  zh: ZH_BODY.Sun,
  naifId: 10,
  kind: "star",
  phys: {
    meanRadiusKm: sunField(/Vol\. mean radius, km\s*=\s*([\d.]+)/, "meanRadiusKm"),
    massKg: sunMass1e24 == null ? null : sunMass1e24 * 1e24,
    densityGcm3: sunField(/Mean density, g\/cm\^3\s*=\s*([\d.]+)/, "densityGcm3"),
    rotationPeriodDays: sunField(/Adopted sid\. rot\. per\.=\s*([\d.]+)\s*d/, "rotationPeriodDays"),
    effectiveTempK: sunField(/Effective temp, K\s*=\s*([\d.]+)/, "effectiveTempK"),
    equatorialGravityMs2: sunField(/Surface gravity\s*=\s*([\d.]+)/, "equatorialGravityMs2"),
    escapeVelocityKms: sunField(/Escape speed, km\/s\s*=\s*([\d.]+)/, "escapeVelocityKms"),
  },
  gm: sunField(/GM, km\^3\/s\^2\s*=\s*([\d.]+)/, "gm"),
};

// ---------- 6. 天文單位（取自 Horizons 向量表的單位說明） ----------
const auText = await fetchCached(
  "horizons-au-definition.txt",
  "https://ssd.jpl.nasa.gov/api/horizons.api?format=text&COMMAND='399'&OBJ_DATA='NO'&MAKE_EPHEM='YES'&EPHEM_TYPE='VECTORS'&CENTER='500@10'&START_TIME='2000-01-01 12:00'&STOP_TIME='2000-01-02 12:00'&STEP_SIZE='1 d'&REF_PLANE='ECLIPTIC'&OUT_UNITS='AU-D'&VEC_TABLE='2'&CSV_FORMAT='YES'",
);
const auM = auText.match(/1 au\s*=\s*([\d.]+)\s*km/i);
if (!auM) throw new Error("Horizons: 找不到 au 定義");
const auKm = Number(auM[1]);

// ---------- 7. 組合行星 ----------
const PLANETS = [
  ["Mercury", 199, "terrestrial"],
  ["Venus", 299, "terrestrial"],
  ["Earth", 399, "terrestrial"],
  ["Mars", 499, "terrestrial"],
  ["Jupiter", 599, "gasGiant"],
  ["Saturn", 699, "gasGiant"],
  ["Uranus", 799, "iceGiant"],
  ["Neptune", 899, "iceGiant"],
];
const planets = PLANETS.map(([name, naifId, subtype]) => {
  const key = name === "Earth" ? "EM Bary" : name;
  if (!phys[name]) throw new Error(`phys_par: 找不到 ${name}`);
  const radii = pckVals[naifId]?.RADII ?? null;
  if (planetGM[name] == null && name !== "Mercury" && name !== "Venus") noteMissing(name, "gm", "JPL sats/phys_par 無此行星 GM");
  return {
    id: name.toLowerCase(),
    en: name,
    zh: ZH_BODY[name],
    naifId,
    kind: "planet",
    subtype,
    parent: "sun",
    // 地球使用的是地月系質心 (EM Bary) 的根數
    elementsFor: key === "EM Bary" ? "Earth-Moon barycenter" : name,
    elements: {
      short: table1[key], // 適用 1800–2050
      long: { ...table2[key], ...(table2b[name] ? { extra: table2b[name] } : {}) }, // 適用 -3000–3000
    },
    phys: phys[name],
    gm: planetGM[name] ?? null,
    radiiKm: radii,
    pole: poleOf(naifId, name),
  };
});

// ---------- 8. 矮行星與候選（JPL SBDB） ----------
const DWARFS = [
  ["Ceres", "1", "dwarf"],
  ["Pluto", "134340", "dwarf"],
  ["Haumea", "136108", "dwarf"],
  ["Makemake", "136472", "dwarf"],
  ["Eris", "136199", "dwarf"],
  ["Orcus", "90482", "candidate"],
  ["Quaoar", "50000", "candidate"],
  ["Gonggong", "225088", "candidate"],
  ["Sedna", "90377", "candidate"],
];
const dwarfPlanets = [];
for (const [name, des, status] of DWARFS) {
  const text = await fetchCached(
    `sbdb-${name.toLowerCase()}.json`,
    `https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=${des}&full-prec=1&phys-par=1`,
  );
  const j = JSON.parse(text);
  if (!j.object?.fullname?.includes(name)) throw new Error(`SBDB: ${des} 回傳的不是 ${name}: ${j.object?.fullname}`);
  const el = Object.fromEntries(j.orbit.elements.map((e) => [e.name, Number(e.value)]));
  for (const k of ["a", "e", "i", "om", "w", "ma", "n", "per"]) {
    if (!Number.isFinite(el[k])) throw new Error(`SBDB: ${name} 缺少根數 ${k}`);
  }
  const pp = Object.fromEntries((j.phys_par ?? []).map((p) => [p.name, p]));
  const sbdbNum = (k) => (pp[k]?.value != null && Number.isFinite(Number(pp[k].value)) ? Number(pp[k].value) : null);
  // 物理參數優先採用 JPL phys_par 表（五顆矮行星），其餘用 SBDB
  let bodyPhys = phys[name] ?? null;
  let physSource = "JPL SSD planets/phys_par";
  if (!bodyPhys) {
    physSource = "JPL SBDB phys_par";
    const diameter = sbdbNum("diameter");
    const rotH = sbdbNum("rot_per");
    const gm = sbdbNum("GM");
    bodyPhys = {
      meanRadiusKm: diameter == null ? null : diameter / 2,
      massKg: null,
      densityGcm3: sbdbNum("density"),
      rotationPeriodDays: rotH == null ? null : rotH / 24,
      geometricAlbedo: sbdbNum("albedo"),
    };
    if (diameter == null) noteMissing(name, "meanRadiusKm", "SBDB 無直徑資料");
    noteMissing(name, "massKg", gm == null ? "SBDB 無 GM／質量資料" : "SBDB 只提供 GM");
    if (rotH == null) noteMissing(name, "rotationPeriodDays", "SBDB 無自轉週期");
    if (bodyPhys.geometricAlbedo == null) noteMissing(name, "geometricAlbedo", "SBDB 無反照率");
    if (bodyPhys.densityGcm3 == null) noteMissing(name, "densityGcm3", "SBDB 無密度");
    if (gm != null) bodyPhys.gm = gm;
  }
  dwarfPlanets.push({
    id: name.toLowerCase(),
    en: name,
    zh: ZH_BODY[name],
    designation: j.object.fullname.trim(),
    spkId: Number(j.object.spkid),
    kind: "dwarf",
    status, // dwarf = IAU 認定；candidate = 矮行星候選
    orbitClass: j.object.orbit_class?.name ?? null,
    parent: "sun",
    elements: {
      epochJd: Number(j.orbit.epoch),
      a: el.a, // au
      e: el.e,
      i: el.i, // deg，J2000 黃道
      node: el.om,
      argPeri: el.w,
      meanAnomaly: el.ma,
      meanMotionDegPerDay: el.n,
      periodDays: el.per,
    },
    phys: bodyPhys,
    physSource,
    absMagH: sbdbNum("H"),
    pole: name === "Pluto" ? poleOf(999, name) : name === "Ceres" ? poleOf(2000001, name) : null,
  });
}

const retrieved = {};
for (const n of [
  "jpl-approx_pos.html",
  "jpl-planets-phys_par.html",
  "jpl-sats-phys_par.html",
  "naif-pck00011.tpc",
  "horizons-sun.txt",
  "horizons-au-definition.txt",
  "sbdb-ceres.json",
]) {
  retrieved[n] = (await sourceInfo(n))?.retrievedAt ?? null;
}

await writeJson(join(APP_DATA, "solar-system.json"), {
  generatedBy: "scripts/fetch-solar-system.mjs",
  retrieved,
  constants: {
    auKm,
    obliquityDeg, // J2000 黃赤交角，取自 JPL approx_pos 頁
    elementsShortValidYears: [1800, 2050],
    elementsLongValidYears: [-3000, 3000],
  },
  sun,
  planets,
  dwarfPlanets,
  missing,
});
console.log(`行星 ${planets.length}、矮行星/候選 ${dwarfPlanets.length}、缺漏 ${missing.length} 筆`);
