// 擷取所有「已命名」衛星的平均軌道根數、物理參數與發現資訊。
// 來源：JPL SSD sats/elem、sats/phys_par、sats/discovery、NAIF PCK。
// 輸出：public/data/moons/<planet>.json（按母行星分檔，前端按需載入）
//       app/data/moon-index.json（名稱索引，供搜尋與側邊欄使用）
import { join } from "node:path";
import * as cheerio from "cheerio";
import { APP_DATA, PUBLIC_DATA, fetchCached, num, sourceInfo, writeJson } from "./lib/common.mjs";
import { ZH_MOON_PREFIX, romanToInt, zhNumber } from "./lib/zh-names.mjs";
import { fitMoonOrbit, frameFromPole } from "./lib/orbit-fit.mjs";
import { readJson } from "./lib/common.mjs";

// 需先執行 fetch-solar-system.mjs（行星 GM、自轉軸、黃赤交角）
const solar = await readJson(join(APP_DATA, "solar-system.json"));
const OBLIQUITY_DEG = solar.constants.obliquityDeg;
// 軌道擬合用的三個時刻（TDB 儒略日）：2026-07-01、其後 10 日、其後 365 日
const FIT_JDS = [2461222.5, 2461232.5, 2461587.5];

const clean = (s) => s.replace(/\s+/g, " ").trim();
const missing = [];

// ---------- 1. 平均軌道根數 ----------
const elemHtml = await fetchCached("jpl-sats-elem.html", "https://ssd.jpl.nasa.gov/sats/elem/");
const $e = cheerio.load(elemHtml);
const header = $e("#sat_elem thead th")
  .map((_, th) => clean($e(th).text()))
  .get();
const EXPECT = ["ID", "Planet", "Satellite", "Code", "Ephemeris", "Frame", "Epoch (TDB)", "a (km)", "e"];
EXPECT.forEach((h, i) => {
  if (header[i].replaceAll(" ", "") !== h.replaceAll(" ", "")) throw new Error(`sats/elem 欄位改變：第 ${i} 欄是 "${header[i]}"，預期 "${h}"`);
});
if (!/apsis/.test(header[14]) || !/node/.test(header[15]) || !/R\.A\./.test(header[16]) || !/Dec/.test(header[17])) {
  throw new Error("sats/elem 欄位順序改變：" + header.join(" | "));
}

function epochToJd(s) {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(\.\d+)?$/);
  if (!m) throw new Error("無法解析曆元 " + s);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 + 2440587.5 + Number(m[4] ?? 0);
}

const elemRows = [];
$e("#sat_elem tbody tr").each((_, tr) => {
  const c = $e(tr)
    .find("td")
    .map((_, td) => clean($e(td).text()))
    .get();
  if (c.length < 19) return;
  elemRows.push({
    planet: c[1],
    name: c[2],
    naifId: num(c[3]),
    ephemeris: c[4],
    frame: c[5].toLowerCase(),
    epoch: c[6],
    epochJd: epochToJd(c[6]),
    a: num(c[7]), // km
    e: num(c[8]),
    argPeri: num(c[9]), // deg
    meanAnomaly: num(c[10]),
    i: num(c[11]),
    node: num(c[12]),
    periodDays: num(c[13]),
    apsisPeriodYr: num(c[14]), // 近心點幅角進動週期
    nodePeriodYr: num(c[15]), // 升交點進動週期
    poleRaDeg: num(c[16]), // 拉普拉斯面極點（僅 Laplace 座標系）
    poleDecDeg: num(c[17]),
    tiltDeg: num(c[18]),
  });
});
if (elemRows.length < 400) throw new Error(`sats/elem 只解析到 ${elemRows.length} 列`);

// ---------- 2. 發現資料與 IAU 編號 ----------
const discHtml = await fetchCached("jpl-sats-discovery.html", "https://ssd.jpl.nasa.gov/sats/discovery.html");
const $d = cheerio.load(discHtml);
const discovery = new Map(); // "Planet/name" → 資料
let currentPlanet = null;
$d("table.sat-discovery tr").each((_, tr) => {
  const cells = $d(tr)
    .find("td,th")
    .map((_, td) => clean($d(td).text()))
    .get();
  const head = cells.join(" ").match(/Satellites? of (?:Dwarf Planet )?(\w+)/);
  if (head) {
    currentPlanet = head[1];
    return;
  }
  if (!currentPlanet || cells.length < 5 || cells[0] === "IAU number") return;
  const [iauNumber, iauName, provisional, year, discoverer, reference] = cells;
  const rec = {
    iauNumber: iauNumber || null,
    iauName: iauName || null,
    provisional: provisional || null,
    discoveryYear: num(year),
    discoverer: discoverer || null,
    reference: reference || null,
  };
  if (iauName) discovery.set(`${currentPlanet}/${iauName.toLowerCase()}`, rec);
});

// ---------- 3. 物理參數 ----------
const physHtml = await fetchCached("jpl-sats-phys_par.html", "https://ssd.jpl.nasa.gov/sats/phys_par/");
const $p = cheerio.load(physHtml);
const phys = new Map(); // naifId → { gm, meanRadiusKm, densityGcm3 }
$p("#sat_phys_par tbody tr").each((_, tr) => {
  const tds = $p(tr).find("td");
  if (tds.length < 6) return;
  const cellNum = (i) => num(clean($p(tds[i]).text()).split(" ")[0]);
  // 每個量有 value/sigma/ref 三欄，或合併在一格內
  const flat = tds.map((_, td) => clean($p(td).text())).get();
  const code = num(flat[2]);
  if (code == null) return;
  if (flat.length >= 12) {
    phys.set(code, { gm: num(flat[3]), meanRadiusKm: num(flat[6]), densityGcm3: num(flat[9]) });
  } else {
    phys.set(code, { gm: cellNum(3), meanRadiusKm: cellNum(4), densityGcm3: cellNum(5) });
  }
});
if (phys.size < 30) throw new Error(`sats/phys_par 只解析到 ${phys.size} 筆`);

// ---------- 4. NAIF PCK 的三軸半徑（補 phys_par 沒有的衛星） ----------
const pck = await fetchCached("naif-pck00011.tpc", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc");
const pckRadii = new Map();
for (const block of pck.split("\\begindata").slice(1)) {
  const data = block.split("\\begintext")[0];
  for (const m of data.matchAll(/BODY(\d+)_RADII\s*=\s*\(([^)]*)\)/g)) {
    pckRadii.set(Number(m[1]), m[2].trim().split(/[\s,]+/).map(Number));
  }
}

// 行星 GM（同一頁的行星 GM 表）
const planetGM = {};
$p("table.astro-par-table tr").each((_, tr) => {
  const tds = $p(tr).find("td");
  if (tds.length < 2) return;
  const v = num($p(tds[1]).text());
  if (v != null) planetGM[clean($p(tds[0]).text())] = v;
});

/** 行星的角動量方向極點：IAU 北極；自轉逆行（如天王星）時取反方向。 */
function spinPole(planetName) {
  const p = [...solar.planets, ...solar.dwarfPlanets].find((x) => x.en === planetName);
  if (!p?.pole) return null;
  if (p.pole.rotationDegPerDay < 0) return { raDeg: (p.pole.raDeg + 180) % 360, decDeg: -p.pole.decDeg };
  return { raDeg: p.pole.raDeg, decDeg: p.pole.decDeg };
}

// 少數衛星的星曆未涵蓋 2026 年（例：土衛三十五 Daphnis 只到 2018-01），改用這組較早的時刻
const FALLBACK_JDS = [2457570.5, 2457580.5, 2457935.5]; // 2016-07-01 起

async function horizonsStates(naifId, centerId, jds = FIT_JDS) {
  const url =
    "https://ssd.jpl.nasa.gov/api/horizons.api?format=text" +
    `&COMMAND='${naifId}'&OBJ_DATA='NO'&MAKE_EPHEM='YES'&EPHEM_TYPE='VECTORS'&CENTER='500@${centerId}'` +
    `&TLIST='${jds.join(",")}'&TLIST_TYPE='JD'&TIME_TYPE='TDB'&REF_PLANE='ECLIPTIC'&OUT_UNITS='KM-S'&VEC_TABLE='2'&CSV_FORMAT='YES'`;
  const text = await fetchCached(`horizons-moons/${naifId}-c${centerId}${jds === FIT_JDS ? "" : "-2016"}.txt`, url);
  const body = text.split("$$SOE")[1]?.split("$$EOE")[0];
  if (!body) return jds === FIT_JDS ? horizonsStates(naifId, centerId, FALLBACK_JDS) : null;
  const rows = body
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(",").map((x) => Number(x)))
    .map((c) => ({ jd: c[0], r: [c[2], c[3], c[4]], v: [c[5], c[6], c[7]] }));
  return rows.length === jds.length && rows.every((r) => r.r.every(Number.isFinite)) ? rows : null;
}

// ---------- 5. 組合 ----------
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}
const isProvisional = (name) => /^S[\/_ ]?\d{4}/i.test(name);
const slug = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// 同一顆衛星若有兩組解（例：天衛十五 Puck 有 URA182 與 URA184），採用曆元較新的一組
const latest = new Map();
for (const row of elemRows) {
  const prev = latest.get(row.naifId);
  if (!prev || row.epochJd > prev.epochJd) latest.set(row.naifId, row);
}
const dedupedRows = elemRows.filter((row) => latest.get(row.naifId) === row);

const byPlanet = {};
const unnamed = {};
const index = [];
for (const row of dedupedRows) {
  if (isProvisional(row.name)) {
    unnamed[row.planet] = (unnamed[row.planet] ?? 0) + 1;
    continue;
  }
  for (const k of ["a", "e", "argPeri", "meanAnomaly", "i", "node", "periodDays"]) {
    if (row[k] == null) throw new Error(`${row.planet}/${row.name} 缺少根數 ${k}`);
  }
  const planetId = row.planet.toLowerCase();
  let disc = discovery.get(`${row.planet}/${row.name.toLowerCase()}`) ?? null;
  let jplElemName = null;
  if (!disc) {
    // JPL 兩張表的拼法偶有出入（例：Magaclite / Megaclite），以發現資料表的 IAU 名稱為準
    for (const [key, rec] of discovery) {
      const [planet, name] = key.split("/");
      if (planet === row.planet && editDistance(name, row.name.toLowerCase()) <= 2) {
        disc = rec;
        jplElemName = row.name;
        row.name = rec.iauName;
        break;
      }
    }
  }
  let zh;
  let iauNumberInt = null;
  if (row.planet === "Earth") {
    zh = "月球";
  } else {
    iauNumberInt = disc?.iauNumber ? romanToInt(disc.iauNumber) : null;
    if (iauNumberInt == null) {
      zh = null; // 沒有 IAU 編號就無法依慣例組出中文名，只顯示英文
      missing.push({ body: `${row.planet}/${row.name}`, field: "zh", reason: "JPL 發現資料表查無 IAU 編號，無法組出中文名" });
    } else {
      zh = ZH_MOON_PREFIX[row.planet] + zhNumber(iauNumberInt);
    }
  }
  const p = phys.get(row.naifId) ?? null;
  const radii = pckRadii.get(row.naifId) ?? null;
  let meanRadiusKm = p?.meanRadiusKm ?? null;
  let radiusSource = meanRadiusKm != null ? "JPL SSD sats/phys_par" : null;
  if (meanRadiusKm == null && radii?.length === 3 && radii.every((r) => r > 0)) {
    meanRadiusKm = Math.cbrt(radii[0] * radii[1] * radii[2]);
    radiusSource = "NAIF pck00011（三軸半徑的等體積半徑）";
  }
  if (meanRadiusKm == null) missing.push({ body: `${row.planet}/${row.name}`, field: "meanRadiusKm", reason: "JPL phys_par 與 NAIF PCK 皆無半徑" });
  if (p?.gm == null) missing.push({ body: `${row.planet}/${row.name}`, field: "gm", reason: "JPL phys_par 無 GM／質量" });
  if (!disc) missing.push({ body: `${row.planet}/${row.name}`, field: "discovery", reason: "JPL 發現資料表查無此名稱" });

  // 軌道：由 Horizons 狀態向量在該衛星的參考面內擬合
  let pole = null;
  if (row.frame === "laplace" && row.poleRaDeg != null && row.poleDecDeg != null) {
    pole = { raDeg: row.poleRaDeg, decDeg: row.poleDecDeg };
  } else if (row.frame === "equatorial") {
    pole = spinPole(row.planet);
    if (!pole) throw new Error(`${row.planet} 缺少自轉軸資料`);
  }
  // 冥王星的小衛星繞的是冥王星–凱倫質心：以質心為中心、用兩者的總 GM 擬合。
  // 前端仍把它們畫在冥王星周圍，因此有約 2,100 km（冥王星到質心的距離）的位置近似。
  const aroundBarycenter = row.planet === "Pluto" && row.naifId !== 901;
  const mu = aroundBarycenter ? planetGM.Pluto + (phys.get(901)?.gm ?? NaN) : planetGM[row.planet] + (p?.gm ?? 0);
  if (!Number.isFinite(mu)) throw new Error(`${row.planet} 缺少 GM`);
  const centerId = aroundBarycenter ? 9 : Math.floor(row.naifId / 100) * 100 + 99;
  const states = await horizonsStates(row.naifId, centerId);
  if (!states) {
    missing.push({ body: `${row.planet}/${row.name}`, field: "orbit", reason: "Horizons 未回傳狀態向量，此衛星未收錄" });
    continue;
  }
  const orbit = fitMoonOrbit(
    states,
    pole ? frameFromPole(pole.raDeg, pole.decDeg, OBLIQUITY_DEG) : null,
    mu,
    { periodDays: row.periodDays, nodePeriodYr: row.nodePeriodYr, apsisPeriodYr: row.apsisPeriodYr },
  );
  orbit.poleRaDeg = pole?.raDeg ?? null;
  orbit.poleDecDeg = pole?.decDeg ?? null;

  const id = `${planetId}-${slug(row.name)}`;
  const moon = {
    id,
    en: row.name,
    zh,
    jplElemName,
    naifId: row.naifId,
    iauNumber: disc?.iauNumber ?? null,
    provisional: disc?.provisional ?? null,
    discoveryYear: disc?.discoveryYear ?? null,
    discoverer: disc?.discoverer ?? null,
    // 繪圖與位置計算使用的軌道（Horizons 狀態向量擬合；參考面見 poleRaDeg/poleDecDeg，null＝黃道）
    orbit,
    // JPL 衛星平均根數表的原始值（資訊面板顯示用）
    mean: {
      ephemeris: row.ephemeris,
      frame: row.frame, // ecliptic | equatorial | laplace
      epoch: row.epoch,
      a: row.a,
      e: row.e,
      i: row.i,
      periodDays: row.periodDays,
      apsisPeriodYr: row.apsisPeriodYr,
      nodePeriodYr: row.nodePeriodYr,
      tiltDeg: row.tiltDeg,
    },
    gm: p?.gm ?? null,
    meanRadiusKm,
    radiusSource,
    radiiKm: radii,
    densityGcm3: p?.densityGcm3 ?? null,
  };
  (byPlanet[planetId] ??= []).push(moon);
  index.push({ id, en: row.name, zh, planet: planetId });
}

const retrievedAt = {
  elements: (await sourceInfo("jpl-sats-elem.html"))?.retrievedAt,
  physical: (await sourceInfo("jpl-sats-phys_par.html"))?.retrievedAt,
  discovery: (await sourceInfo("jpl-sats-discovery.html"))?.retrievedAt,
  pck: (await sourceInfo("naif-pck00011.tpc"))?.retrievedAt,
  horizons: (await sourceInfo("horizons-moons/301-c399.txt"))?.retrievedAt,
};

const systems = {};
for (const [planetId, moons] of Object.entries(byPlanet)) {
  moons.sort((a, b) => a.mean.a - b.mean.a);
  const planetName = planetId[0].toUpperCase() + planetId.slice(1);
  await writeJson(
    join(PUBLIC_DATA, "moons", `${planetId}.json`),
    {
      planet: planetId,
      source: "JPL Horizons（狀態向量）; JPL Solar System Dynamics — Planetary Satellite Mean Elements / Physical Parameters / Discovery Circumstances; NAIF pck00011.tpc",
      retrievedAt,
      unnamedExcluded: unnamed[planetName] ?? 0,
      moons,
    },
    { pretty: false },
  );
  systems[planetId] = {
    count: moons.length,
    unnamedExcluded: unnamed[planetName] ?? 0,
    extentKm: Math.max(...moons.map((m) => m.orbit.a * (1 + m.orbit.e))),
  };
}

await writeJson(join(APP_DATA, "moon-index.json"), { retrievedAt, systems, moons: index, missing }, { pretty: false });
console.log(
  Object.entries(systems)
    .map(([k, v]) => `${k}: ${v.count} 顆已命名（另有 ${v.unnamedExcluded} 顆僅有臨時編號，未收錄）`)
    .join("\n"),
);
console.log(`缺漏紀錄 ${missing.length} 筆`);
