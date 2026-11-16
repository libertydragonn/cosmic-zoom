// 人造探測器的軌跡與基本資料。
// 軌跡：JPL Horizons 向量星曆（NASA Eyes on the Solar System 使用的也是 JPL 的探測器星曆）。
//   - 平常存日心座標；進入行星 1.5 倍希爾半徑內改存「以該行星為中心」的座標，
//     這樣飛掠與環繞軌道在畫面上會和本專案的行星位置對齊。
//   - 行星附近的最近點另外以細步長取樣，再以 Hermite 內插誤差為準精簡取樣點。
// 名稱與發射資料：Wikidata（發射日期須在 Horizons 星曆起點前 60 日到後 3 日之間）。
// 地球衛星：低軌道一圈只要約 90 分鐘，不適合存位置取樣，改存 Horizons 的密切軌道根數
//   （ICRF 赤道座標、每日一組），顯示時內插。
// 連結：NASA Eyes on the Solar System 的探測器頁（ID 取自 Eyes 網頁程式內的實體清單）。
// 輸出：app/data/spacecraft.json（索引，隨程式打包）、public/data/spacecraft/<id>.bin（按需下載）
import * as OpenCC from "opencc-js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { APP_DATA, PUBLIC_DATA, ROOT, fetchCached, pickZh, readJson, sparql, writeJson } from "./lib/common.mjs";

const OUT = join(PUBLIC_DATA, "spacecraft");
await mkdir(OUT, { recursive: true });
const toTrad = OpenCC.Converter({ from: "cn", to: "tw" });

// Horizons 編號以 horizons_lookup API 查得；Eyes ID 見 eyes.nasa.gov/apps/solar-system/app.js
const CRAFT = [
  { id: "voyager-1", horizons: "-31", eyes: "sc_voyager_1", search: "Voyager 1" },
  { id: "voyager-2", horizons: "-32", eyes: "sc_voyager_2", search: "Voyager 2" },
  { id: "pioneer-10", horizons: "-23", eyes: "sc_pioneer_10", search: "Pioneer 10" },
  { id: "pioneer-11", horizons: "-24", eyes: "sc_pioneer_11", search: "Pioneer 11" },
  { id: "new-horizons", horizons: "-98", eyes: "sc_new_horizons", search: "New Horizons" },
  { id: "parker-solar-probe", horizons: "-96", eyes: "sc_parker_solar_probe", search: "Parker" },
  { id: "cassini", horizons: "-82", eyes: "sc_cassini", search: "Cassini" },
  { id: "juno", horizons: "-61", eyes: "sc_juno", search: "Juno" },
  { id: "jwst", horizons: "-170", eyes: "sc_jwst", search: "Webb" },
  { id: "lucy", horizons: "-49", eyes: "sc_lucy", search: "Lucy" },
  { id: "psyche", horizons: "-255", eyes: "sc_psyche", search: "Psyche" },
  { id: "europa-clipper", horizons: "-159", eyes: "sc_europa_clipper", search: "Europa Clipper" },
  { id: "juice", horizons: "-28", eyes: "sc_juice", search: "Jupiter Icy Moons Explorer" },
];

const LAST_JD = 2488069.5; // 2100-01-01：本專案行星近似軌道的適用範圍內
const DAY_S = 86400;

// ---------------------------------------------------------------------------
// 本專案的行星位置模型（判斷探測器何時靠近行星）
// ---------------------------------------------------------------------------
const server = await createServer({
  configFile: false,
  root: ROOT,
  resolve: { alias: { "~": join(ROOT, "app") } },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  logLevel: "error",
});
const lib = await server.ssrLoadModule("/app/lib/bodies.ts");
const solar = await readJson(join(APP_DATA, "solar-system.json"));
const AU = solar.constants.auKm;
const sunMass = solar.sun.phys.massKg;
const PLANETS = solar.planets.map((p) => ({
  id: p.id,
  naif: p.naifId,
  radiusKm: p.phys.equatorialRadiusKm ?? p.phys.meanRadiusKm,
  // 希爾半徑 ≈ a (m / 3M☉)^(1/3)
  hillKm: p.elements.short.a[0] * AU * Math.cbrt(p.phys.massKg / (3 * sunMass)),
}));

// ---------------------------------------------------------------------------
// Horizons
// ---------------------------------------------------------------------------
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function jdFromHorizonsDate(s) {
  const m = /(\d{4})-([A-Z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(s);
  if (!m) throw new Error(`無法解析日期 ${s}`);
  const ms = Date.UTC(+m[1], MON[m[2]], +m[3], +m[4], +m[5], 0) + Number(m[6]) * 1000;
  return ms / 86400000 + 2440587.5;
}
const isoFromJd = (jd) => new Date((jd - 2440587.5) * 86400000).toISOString();
const calFromJd = (jd) => isoFromJd(jd).replace("T", " ").slice(0, 23);

function horizonsUrl(cmd, center, params) {
  const q = Object.entries({
    format: "text",
    COMMAND: `'${cmd}'`,
    OBJ_DATA: "'NO'",
    MAKE_EPHEM: "'YES'",
    EPHEM_TYPE: "'VECTORS'",
    CENTER: `'${center}'`,
    REF_PLANE: "'ECLIPTIC'",
    REF_SYSTEM: "'ICRF'",
    OUT_UNITS: "'KM-S'",
    VEC_TABLE: "'2'",
    VEC_CORR: "'NONE'",
    CSV_FORMAT: "'YES'",
    ...params,
  })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `https://ssd.jpl.nasa.gov/api/horizons.api?${q}`;
}

/** 取一段向量星曆，回傳 [{t, p:[x,y,z], v:[vx,vy,vz]}]；失敗時回傳 Horizons 的錯誤文字。 */
async function vectors(cacheName, cmd, center, startJd, stopJd, step) {
  const url = horizonsUrl(cmd, center, {
    START_TIME: `'JD ${startJd.toFixed(6)}'`,
    STOP_TIME: `'JD ${stopJd.toFixed(6)}'`,
    STEP_SIZE: `'${step}'`,
  });
  const text = await fetchCached(`spacecraft/${cacheName}.txt`, url);
  const body = text.split("$$SOE")[1]?.split("$$EOE")[0];
  if (!body) return { error: text, rows: [], header: text };
  const rows = [];
  for (const line of body.trim().split(/\r?\n/)) {
    const c = line.split(",").map((s) => s.trim());
    rows.push({ t: Number(c[0]), p: [Number(c[2]), Number(c[3]), Number(c[4])], v: [Number(c[5]), Number(c[6]), Number(c[7])] });
  }
  return { rows, header: text.split("$$SOE")[0] };
}

/** 由 Horizons 的錯誤訊息取得星曆涵蓋期間。 */
async function coverage(c) {
  const probe = async (name, a, b) => {
    const r = await vectors(`${c.id}-cov-${name}`, c.horizons, "500@10", a, b, "100000d");
    return r.error ?? "";
  };
  const before = await probe("start", 2433282.5, 2433283.5); // 1950-01-01
  const m1 = /prior to A\.D\. (\S+ \S+)/.exec(before);
  if (!m1) throw new Error(`${c.id}：無法取得星曆起點\n${before.slice(-400)}`);
  // 前後各縮一分鐘，避免 JD 四捨五入後落在星曆範圍外
  const start = jdFromHorizonsDate(m1[1]) + 1 / 1440;
  const after = await probe("end", LAST_JD + 3650, LAST_JD + 3651);
  const m2 = /after A\.D\. (\S+ \S+)/.exec(after);
  const end = m2 ? Math.min(jdFromHorizonsDate(m2[1]) - 1 / 1440, LAST_JD) : LAST_JD;
  return { start, end };
}

// ---------------------------------------------------------------------------
// 取樣與精簡
// ---------------------------------------------------------------------------
/** 三次 Hermite 內插（p、v 單位 km、km/s；t 單位日）。 */
function hermite(a, b, t, out) {
  const h = b.t - a.t;
  const s = (t - a.t) / h;
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const hs = h * DAY_S;
  for (let k = 0; k < 3; k++) out[k] = h00 * a.p[k] + h10 * hs * a.v[k] + h01 * b.p[k] + h11 * hs * b.v[k];
  return out;
}

/** 只保留「以 Hermite 內插重建時誤差超過容許值」所需的點。容許值與到中心的距離成比例。 */
function decimate(rows, relTol = 2e-4, maxSpan = 3000) {
  if (rows.length <= 2) return rows;
  const keep = [rows[0]];
  const tmp = [0, 0, 0];
  let i = 0;
  while (i < rows.length - 1) {
    let j = i + 1;
    while (j + 1 < rows.length && j + 1 - i <= maxSpan) {
      const cand = j + 1;
      let ok = true;
      for (let k = i + 1; k < cand && ok; k++) {
        hermite(rows[i], rows[cand], rows[k].t, tmp);
        const r = Math.hypot(...rows[k].p);
        const err = Math.hypot(tmp[0] - rows[k].p[0], tmp[1] - rows[k].p[1], tmp[2] - rows[k].p[2]);
        if (err > Math.max(relTol * r, 1)) ok = false;
      }
      if (!ok) break;
      j = cand;
    }
    keep.push(rows[j]);
    i = j;
  }
  return keep;
}

function sortUnique(rows) {
  rows.sort((a, b) => a.t - b.t);
  return rows.filter((r, k) => k === 0 || r.t - rows[k - 1].t > 1e-7);
}

// ---------------------------------------------------------------------------
// Wikidata
// ---------------------------------------------------------------------------
async function wikidataEntities(ids, cacheName) {
  const url =
    "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels|descriptions|claims|aliases" +
    `&languages=en|zh|zh-tw|zh-hant|zh-hk|zh-cn|zh-hans&ids=${ids.join("|")}`;
  return JSON.parse(await fetchCached(`spacecraft/wikidata-${cacheName}.json`, url)).entities;
}
const claimTime = (e, p) => e.claims?.[p]?.[0]?.mainsnak?.datavalue?.value?.time ?? null;
const claimItems = (e, p) => (e.claims?.[p] ?? []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
const claimString = (e, p) => e.claims?.[p]?.[0]?.mainsnak?.datavalue?.value ?? null;
const labelsOf = (e) => Object.fromEntries(Object.entries(e.labels ?? {}).map(([k, v]) => [k, v.value]));
const CN_DIGITS = "〇一二三四五六七八九";
/** 「航海家1號」→ 另加「航海家一號」，方便以中文數字搜尋。 */
const digitVariant = (s) => (/[一-鿿]\d號?$/.test(s) ? s.replace(/\d/g, (d) => CN_DIGITS[+d]) : null);

async function metadata(c, start) {
  // 找發射日期（P619）在星曆起點前 60 日到後 3 日之間、英文名含關鍵字的條目
  const day = (jd) => isoFromJd(jd).slice(0, 10);
  const rows = await sparql(
    `spacecraft/wd-launch-${c.id}.json`,
    // 地球衛星的星曆常在入軌、展開後才開始，所以往前放寬到 60 日
    `SELECT ?item ?label WHERE { ?item wdt:P619 ?d . FILTER(?d >= "${day(start - 60)}T00:00:00Z"^^xsd:dateTime && ?d <= "${day(start + 3)}T23:59:59Z"^^xsd:dateTime) ?item rdfs:label ?label . FILTER(lang(?label) = "en") }`,
  );
  const key = c.search.toLowerCase();
  const match =
    rows.find((r) => r.label.value.toLowerCase() === key) ?? rows.find((r) => r.label.value.toLowerCase().includes(key));
  let best = null;
  if (match) {
    const qid = match.item.value.split("/").pop();
    best = (await wikidataEntities([qid], c.id))[qid];
  } else {
    // 條目沒有發射日期時：以英文名完全相同、且 COSPAR 編號（P247）的年份與星曆起點年份相同者為準
    const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=10&search=${encodeURIComponent(c.search)}`;
    const hits = JSON.parse(await fetchCached(`spacecraft/wikisearch-${c.id}.json`, url)).search ?? [];
    const exact = hits.filter((h) => h.label?.toLowerCase() === key).map((h) => h.id);
    if (exact.length) {
      const ents = await wikidataEntities(exact, `cand-${c.id}`);
      const year = isoFromJd(start).slice(0, 4);
      best = exact.map((id) => ents[id]).find((e) => claimString(e, "P247")?.startsWith(`${year}-`)) ?? null;
      if (best) console.log(`  （Wikidata 條目無發射日期，改以英文名與 COSPAR 年份 ${year} 比對：${best.id}）`);
    }
  }
  if (!best) return null;
  const labels = labelsOf(best);
  let { zh, zhLang } = pickZh(labels);
  // 一律經 OpenCC 轉成臺灣繁體（Wikidata 部分繁體語言標籤實際上是簡體字）
  if (zh) zh = toTrad(zh);
  if (!zh && labels["zh-cn"]) {
    zh = toTrad(labels["zh-cn"]);
    zhLang = "zh-cn（OpenCC 轉繁）";
  }
  const aliasSet = new Set();
  for (const lang of ["zh", "zh-cn", "zh-hans", "zh-hk", "zh-hant", "zh-tw"]) {
    if (labels[lang]) aliasSet.add(toTrad(labels[lang]));
    for (const a of best.aliases?.[lang] ?? []) aliasSet.add(toTrad(a.value));
  }
  for (const a of [...aliasSet]) {
    const v = digitVariant(a);
    if (v) aliasSet.add(v);
  }
  if (zh) {
    const v = digitVariant(zh);
    if (v) aliasSet.add(v);
  }
  aliasSet.delete(zh);
  for (const a of best.aliases?.en ?? []) aliasSet.add(a.value);
  const operatorIds = claimItems(best, "P137");
  let operators = [];
  if (operatorIds.length) {
    const ops = await wikidataEntities(operatorIds, `ops-${c.id}`);
    operators = operatorIds.map((id) => {
      const l = labelsOf(ops[id]);
      const p = pickZh(l);
      return p.zh ? toTrad(p.zh) : (l.en ?? id);
    });
  }
  // 發射日期不在星曆起點前 60 日到後 3 日之間時不採用（例：先驅者10號的 Wikidata 年份有誤）
  let launchDate = claimTime(best, "P619")?.slice(1, 11) ?? null;
  let launchNote = null;
  if (launchDate) {
    const jd = Date.parse(`${launchDate}T00:00:00Z`) / 86400000 + 2440587.5;
    if (jd > start + 3 || start - jd > 60) {
      launchNote = `Wikidata 的發射日期 ${launchDate} 與 Horizons 星曆起點 ${isoFromJd(start).slice(0, 10)} 不符，未採用`;
      console.log(`  ⚠ ${launchNote}`);
      launchDate = null;
    }
  }
  const rawDesc = best.descriptions?.["zh-tw"]?.value ?? best.descriptions?.["zh-hant"]?.value ?? best.descriptions?.zh?.value ?? null;
  const desc = rawDesc ? toTrad(rawDesc) : null;
  return {
    wikidata: best.id,
    en: labels.en ?? null,
    zh,
    zhLang,
    aliases: [...aliasSet].filter(Boolean),
    launchDate,
    launchNote,
    operators,
    cospar: claimString(best, "P247"),
    description: desc,
  };
}

// ---------------------------------------------------------------------------
// 主程式
// ---------------------------------------------------------------------------
// --only=voyager-1,juno：只更新指定探測器（其餘沿用既有 index.json）
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const prevIndex = only ? await readJson(join(APP_DATA, "spacecraft.json")).catch(() => ({ craft: [] })) : { craft: [] };
const index = [];
for (const c of CRAFT) {
  if (only && !only.includes(c.id)) {
    const prev = prevIndex.craft.find((x) => x.id === c.id);
    if (prev) index.push(prev);
    continue;
  }
  const cov = await coverage(c);
  console.log(`${c.id}：星曆 ${calFromJd(cov.start)} – ${calFromJd(cov.end)}`);

  // 1. 日心、每日一點（分段請求，每段 ≤ 20000 行）
  let helio = [];
  let header = "";
  for (let a = cov.start; a < cov.end; a += 20000) {
    const b = Math.min(cov.end, a + 20000);
    const r = await vectors(`${c.id}-helio-${Math.round(a)}`, c.horizons, "500@10", a, b, "1d");
    if (r.error) throw new Error(`${c.id} 日心星曆失敗：${r.error.slice(-300)}`);
    header ||= r.header;
    helio.push(...r.rows);
  }
  helio = sortUnique(helio);
  const spk = /\{source:\s*([^}]+)\}/.exec(header)?.[1]?.trim() ?? null;
  const horizonsName = /Target body name:\s*(.+?)\s{2,}/.exec(header)?.[1] ?? c.search;

  // 2. 依「最近的行星且在希爾半徑內」切段（進入 1.5 倍、離開 2 倍，避免來回切換）
  const near = new Array(helio.length).fill("sun");
  let current = "sun";
  for (let k = 0; k < helio.length; k++) {
    lib.updateBodies(helio[k].t);
    let best = null;
    let bestRatio = Infinity;
    for (const p of PLANETS) {
      const pos = lib.getBody(p.id).pos;
      const d = Math.hypot(helio[k].p[0] - pos[0], helio[k].p[1] - pos[1], helio[k].p[2] - pos[2]);
      const ratio = d / p.hillKm;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        best = p.id;
      }
    }
    if (current === "sun") {
      if (bestRatio < 1.5) current = best;
    } else {
      const p = PLANETS.find((q) => q.id === current);
      const pos = lib.getBody(current).pos;
      const d = Math.hypot(helio[k].p[0] - pos[0], helio[k].p[1] - pos[1], helio[k].p[2] - pos[2]);
      if (d / p.hillKm > 2) current = bestRatio < 1.5 ? best : "sun";
    }
    near[k] = current;
  }
  const runs = [];
  for (let k = 0; k < helio.length; k++) {
    const last = runs[runs.length - 1];
    if (last && last.center === near[k]) last.b = k;
    else runs.push({ center: near[k], a: k, b: k });
  }

  // 3. 各段取樣
  const segments = [];
  for (const run of runs) {
    const t0 = run.a === 0 ? cov.start : helio[run.a].t;
    const t1 = run.b === helio.length - 1 ? cov.end : helio[run.b + 1]?.t ?? cov.end;
    let rows;
    if (run.center === "sun") {
      rows = helio.filter((r) => r.t >= t0 - 1e-9 && r.t <= t1 + 1e-9);
      // 近日點在 0.4 AU 內時（帕克太陽探測器），每日取樣跟不上，前後 2 日以 20 分鐘補取樣
      const extra = [];
      for (let k = 1; k + 1 < rows.length; k++) {
        const r = Math.hypot(...rows[k].p);
        if (r < 0.4 * AU && r <= Math.hypot(...rows[k - 1].p) && r <= Math.hypot(...rows[k + 1].p)) {
          const a = Math.max(t0, rows[k].t - 2);
          const b = Math.min(t1, rows[k].t + 2);
          const res = await vectors(`${c.id}-sun-peri-${Math.round(rows[k].t * 100)}`, c.horizons, "500@10", a, b, "20m");
          if (!res.error) extra.push(...res.rows);
        }
      }
      if (extra.length) {
        console.log(`  日心段：近日點補取樣 ${extra.length} 點`);
        rows = sortUnique([...rows, ...extra]);
      }
    } else {
      const p = PLANETS.find((q) => q.id === run.center);
      const center = `500@${p.naif}`;
      const span = t1 - t0;
      const stepDays = Math.max(10 / 1440, Math.min(1, span / 20000));
      const stepMin = Math.max(1, Math.round(stepDays * 1440));
      const coarse = await vectors(`${c.id}-${p.id}-${Math.round(t0 * 10)}-${stepMin}m`, c.horizons, center, t0, t1, `${stepMin}m`);
      if (coarse.error) throw new Error(`${c.id} ${p.id} 星曆失敗：${coarse.error.slice(-300)}`);
      rows = coarse.rows;
      // 近拱點（距離的局部極小、且在 30 倍行星半徑內）附近以細步長補取樣
      const minima = [];
      for (let k = 1; k + 1 < rows.length; k++) {
        const r = Math.hypot(...rows[k].p);
        if (r < 30 * p.radiusKm && r <= Math.hypot(...rows[k - 1].p) && r <= Math.hypot(...rows[k + 1].p)) minima.push(rows[k].t);
      }
      const half = 2 * stepDays;
      const fineMin = Math.max(1, Math.round((4 * stepDays * 1440) / 160));
      const extra = [];
      const queue = [...minima];
      const workers = Array.from({ length: 4 }, async () => {
        while (queue.length) {
          const tm = queue.shift();
          const a = Math.max(t0, tm - half);
          const b = Math.min(t1, tm + half);
          if (b - a < 2 * fineMin / 1440) continue;
          const r = await vectors(`${c.id}-${p.id}-peri-${Math.round(tm * 1000)}-${fineMin}m`, c.horizons, center, a, b, `${fineMin}m`);
          if (!r.error) extra.push(...r.rows);
        }
      });
      await Promise.all(workers);
      rows = sortUnique([...rows, ...extra]);
      console.log(`  ${p.id} 段 ${calFromJd(t0).slice(0, 10)} – ${calFromJd(t1).slice(0, 10)}：步長 ${stepMin} 分，近拱點 ${minima.length} 處`);
    }
    const kept = decimate(rows);
    segments.push({ center: run.center, rows: kept, raw: rows.length });
  }

  // 4. 寫出二進位：每段 Float64 時間（JD）＋ Float32 位置速度（km、km/s）
  const parts = [];
  let offset = 0;
  const segMeta = [];
  for (const s of segments) {
    const n = s.rows.length;
    const t = new Float64Array(n);
    const pv = new Float32Array(n * 6);
    s.rows.forEach((r, k) => {
      t[k] = r.t;
      pv.set([...r.p, ...r.v], k * 6);
    });
    const tOff = offset;
    parts.push(Buffer.from(t.buffer));
    offset += t.byteLength;
    const pvOff = offset;
    parts.push(Buffer.from(pv.buffer));
    offset += pv.byteLength;
    const pad = (8 - (offset % 8)) % 8;
    if (pad) {
      parts.push(Buffer.alloc(pad));
      offset += pad;
    }
    segMeta.push({ center: s.center, t0: s.rows[0].t, t1: s.rows[n - 1].t, n, tOff, pvOff, rawSamples: s.raw });
  }
  const file = `${c.id}.bin`;
  await writeFile(join(OUT, file), Buffer.concat(parts));

  const meta = await metadata(c, cov.start);
  if (!meta) console.log(`  ⚠ Wikidata 找不到發射日期相符的條目，名稱與發射資料留空`);
  index.push({
    id: c.id,
    group: "deep",
    horizonsId: c.horizons,
    horizonsName,
    spkSource: spk,
    eyesId: c.eyes,
    en: meta?.en ?? horizonsName.replace(/\s*\(spacecraft\)/, ""),
    zh: meta?.zh ?? null,
    zhLang: meta?.zhLang ?? null,
    aliases: meta?.aliases ?? [],
    wikidata: meta?.wikidata ?? null,
    launchDate: meta?.launchDate ?? null,
    launchNote: meta?.launchNote ?? null,
    operators: meta?.operators ?? [],
    cospar: meta?.cospar ?? null,
    description: meta?.description ?? null,
    coverage: { start: cov.start, end: cov.end, startIso: isoFromJd(cov.start), endIso: isoFromJd(cov.end) },
    file: `data/spacecraft/${file}`,
    bytes: offset,
    segments: segMeta,
  });
  console.log(`  → ${segMeta.length} 段，${segMeta.reduce((s, x) => s + x.n, 0)} 點，${(offset / 1024).toFixed(0)} KB；${meta?.zh ?? "（無中文名）"}`);
}

// ---------------------------------------------------------------------------
// 地球衛星：等間隔的密切軌道根數
// ---------------------------------------------------------------------------
const EARTH_SATS = [
  { id: "iss", horizons: "-125544", eyes: "sc_iss", search: "International Space Station" },
  { id: "tiangong", horizons: "-148274", eyes: null, search: "Tiangong" },
  { id: "hubble", horizons: "-48", eyes: "sc_hubble_space_telescope", search: "Hubble Space Telescope" },
  { id: "chandra", horizons: "-151", eyes: "sc_chandra", search: "Chandra X-ray Observatory" },
  { id: "tess", horizons: "-95", eyes: "sc_tess", search: "Transiting Exoplanet Survey Satellite" },
  { id: "nustar", horizons: "-138358", eyes: "sc_nustar", search: "Nuclear Spectroscopic Telescope Array" },
  { id: "sdo", horizons: "-136395", eyes: "sc_sdo", search: "Solar Dynamics Observatory" },
  { id: "terra", horizons: "-125994", eyes: "sc_terra", search: "Terra" },
  { id: "aqua", horizons: "-127424", eyes: "sc_aqua", search: "Aqua" },
  { id: "aura", horizons: "-128376", eyes: "sc_aura", search: "Aura" },
  { id: "goes-16", horizons: "-141866", eyes: null, search: "GOES-16" },
];
const DEG = Math.PI / 180;

/** 等間隔的密切根數（地心、ICRF 赤道面）。回傳 [{t, a, e, i, O, w, M}]（角度為弧度）。 */
async function elementRows(c, start, end, stepLabel, stepDays) {
  const out = [];
  const chunk = 20000 * stepDays;
  for (let a = start; a < end; a += chunk) {
    const b = Math.min(end, a + chunk);
    const url = horizonsUrl(c.horizons, "500@399", {
      EPHEM_TYPE: "'ELEMENTS'",
      REF_PLANE: "'FRAME'",
      START_TIME: `'JD ${a.toFixed(6)}'`,
      STOP_TIME: `'JD ${b.toFixed(6)}'`,
      STEP_SIZE: `'${stepLabel}'`,
    });
    const text = await fetchCached(`spacecraft/${c.id}-el-${stepLabel}-${Math.round(a)}-${Math.round(b)}.txt`, url);
    const body = text.split("$$SOE")[1]?.split("$$EOE")[0];
    if (!body) throw new Error(`${c.id} 軌道根數失敗：${text.slice(-300)}`);
    for (const line of body.trim().split(/\r?\n/)) {
      const v = line.split(",").map((s) => s.trim());
      // 欄位：JDTDB, 日期, EC, QR, IN, OM, W, Tp, N, MA, TA, A, AD, PR
      out.push({ t: +v[0], e: +v[2], i: +v[4] * DEG, O: +v[5] * DEG, w: +v[6] * DEG, M: +v[9] * DEG, a: +v[11] });
    }
  }
  return sortUnique(out);
}

for (const c of EARTH_SATS) {
  if (only && !only.includes(c.id)) {
    const prev = prevIndex.craft.find((x) => x.id === c.id);
    if (prev) index.push(prev);
    continue;
  }
  const cov = await coverage(c);
  // 每日一組。實測內插誤差：國際太空站最大約 11 km、GOES-16 約 5 km、
  // 高橢圓軌道的錢德拉約 72 km、TESS 約 130 km（相對軌道大小都在 0.5% 以內）
  const [stepLabel, stepDays] = ["1d", 1];
  const rows = await elementRows(c, cov.start, cov.end, stepLabel, stepDays);
  // 確認等間隔（執行時以 t0 + k·step 還原時間，不另存）
  for (let k = 1; k < rows.length; k++) {
    if (Math.abs(rows[k].t - rows[k - 1].t - stepDays) > 1e-6) throw new Error(`${c.id} 根數不是等間隔：第 ${k} 筆`);
  }
  const el = new Float32Array(rows.length * 6);
  rows.forEach((r, k) => el.set([r.a, r.e, r.i, r.O, r.w, r.M], k * 6));
  const file = `${c.id}.bin`;
  await writeFile(join(OUT, file), Buffer.from(el.buffer));
  const header = (await vectors(`${c.id}-cov-start`, c.horizons, "500@10", 2433282.5, 2433283.5, "100000d")).header ?? "";
  const horizonsName = /Target body name:\s*(.+?)\s{2,}/.exec(header)?.[1] ?? c.search;
  const meta = await metadata(c, cov.start);
  if (!meta) console.log(`  ⚠ Wikidata 找不到相符的條目，名稱與發射資料留空`);
  index.push({
    id: c.id,
    group: "earth",
    horizonsId: c.horizons,
    horizonsName,
    spkSource: null,
    eyesId: c.eyes,
    en: meta?.en ?? horizonsName.replace(/\s*\(spacecraft\)/, ""),
    zh: meta?.zh ?? null,
    zhLang: meta?.zhLang ?? null,
    aliases: meta?.aliases ?? [],
    wikidata: meta?.wikidata ?? null,
    launchDate: meta?.launchDate ?? null,
    launchNote: meta?.launchNote ?? null,
    operators: meta?.operators ?? [],
    cospar: meta?.cospar ?? null,
    description: meta?.description ?? null,
    coverage: { start: rows[0].t, end: rows[rows.length - 1].t, startIso: isoFromJd(rows[0].t), endIso: isoFromJd(rows[rows.length - 1].t) },
    file: `data/spacecraft/${file}`,
    bytes: el.byteLength,
    segments: [],
    elements: { t0: rows[0].t, stepDays, n: rows.length, center: "earth", frame: "ICRF 赤道面" },
  });
  console.log(`${c.id}：${calFromJd(rows[0].t).slice(0, 10)} – ${calFromJd(rows[rows.length - 1].t).slice(0, 10)}，每 ${stepLabel} 一組共 ${rows.length} 組，${(el.byteLength / 1024).toFixed(0)} KB；${meta?.zh ?? "（無中文名）"}`);
}

// 同系列命名一致：例如「航海家1號」有臺灣用語標籤（zh-tw）而 2 號沒有時，
// 2 號沿用同一系列的中文字頭，原本的 Wikidata 名稱保留為搜尋別名。
for (const c of index) {
  if (!c.zh || c.zhLang === "zh-tw") continue;
  const stem = c.en.replace(/\s*\d+$/, "");
  const num = /(\d+)$/.exec(c.en)?.[1];
  if (!num || stem === c.en) continue;
  const sib = index.find((x) => x !== c && x.zhLang === "zh-tw" && x.en.replace(/\s*\d+$/, "") === stem && /\d+號$/.test(x.zh));
  if (!sib) continue;
  const zhStem = sib.zh.replace(/\d+號$/, "");
  const renamed = `${zhStem}${num}號`;
  if (renamed === c.zh) continue;
  c.aliases = [c.zh, ...c.aliases.filter((a) => a !== renamed)];
  const v = digitVariant(renamed);
  if (v && !c.aliases.includes(v)) c.aliases.push(v);
  console.log(`  名稱一致化：${c.zh} → ${renamed}（依 ${sib.zh} 的 zh-tw 標籤）`);
  c.zh = renamed;
  c.zhLang = `zh-tw（依同系列 ${sib.en}）`;
}

await writeJson(join(APP_DATA, "spacecraft.json"), {
  generatedBy: "scripts/fetch-spacecraft.mjs",
  retrieved: new Date().toISOString().slice(0, 10),
  source: "JPL Horizons 向量星曆（黃道 J2000、ICRF、無光行差修正）；名稱與發射資料：Wikidata",
  segmentRule: "進入行星 1.5 倍希爾半徑內改以該行星為中心，離開 2 倍時改回日心",
  craft: index,
});
await server.close();
