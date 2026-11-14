// 處理 HYG v4.4 星表（CC BY-SA 4.0，astronexus）。
// 選取：肉眼可見（視星等 ≤ 6.5）或距離 25 秒差距以內的恆星；座標轉為 J2000 黃道、單位光年。
// 輸出：public/data/stars/stars.bin（Float32：x, y, z, 絕對星等, B−V 色指數）
//       public/data/stars/stars.json（有名稱或拜耳／佛氏編號的恆星資料）
// 著名恆星的中文名取自 Wikidata 標籤，再以 OpenCC 統一轉成繁體。
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import * as OpenCC from "opencc-js";
import { APP_DATA, PUBLIC_DATA, fetchCached, readJson, sourceInfo, sparql, writeJson } from "./lib/common.mjs";

const HYG_URL = "https://codeberg.org/astronexus/hyg/media/branch/main/data/hyg/CURRENT/hyg_v44.csv.gz";
const MAG_LIMIT = 6.5;
const NEAR_PC = 25;

const solar = await readJson(join(APP_DATA, "solar-system.json"));
const OBL = (solar.constants.obliquityDeg * Math.PI) / 180;
const AU_KM = solar.constants.auKm;
const PC_KM = (AU_KM * 648000) / Math.PI; // IAU 2015 B2
const LY_KM = 299792.458 * 86400 * 365.25; // IAU 光年定義
const LY_PER_PC = PC_KM / LY_KM;

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const gz = await fetchCached("hyg/hyg_v44.csv.gz", HYG_URL, { binary: true });
const lines = gunzipSync(gz).toString("utf8").split(/\r?\n/).filter(Boolean);
const head = parseCsvLine(lines[0]);
const col = Object.fromEntries(head.map((h, i) => [h, i]));
for (const k of ["id", "hip", "hd", "bf", "proper", "dist", "mag", "absmag", "spect", "ci", "x", "y", "z", "con"]) {
  if (!(k in col)) throw new Error(`HYG 缺少欄位 ${k}`);
}

const stars = [];
let unknownDist = 0;
for (let n = 1; n < lines.length; n++) {
  const c = parseCsvLine(lines[n]);
  if (c[col.id] === "0") continue; // 太陽本身，由太陽系圖層繪製
  const dist = Number(c[col.dist]);
  const mag = Number(c[col.mag]);
  if (!Number.isFinite(dist) || !Number.isFinite(mag)) continue;
  if (dist >= 100000) {
    // HYG 以 100000 表示距離不明
    if (mag <= MAG_LIMIT) unknownDist++;
    continue;
  }
  if (!(mag <= MAG_LIMIT || dist <= NEAR_PC)) continue;
  const xe = Number(c[col.x]);
  const ye = Number(c[col.y]);
  const ze = Number(c[col.z]);
  const ci = c[col.ci] === "" ? NaN : Number(c[col.ci]);
  stars.push({
    hyg: Number(c[col.id]),
    hip: c[col.hip] ? Number(c[col.hip]) : null,
    hd: c[col.hd] ? Number(c[col.hd]) : null,
    bf: c[col.bf].trim() || null,
    proper: c[col.proper].trim() || null,
    con: c[col.con].trim() || null,
    spect: c[col.spect].trim() || null,
    mag,
    absmag: Number(c[col.absmag]),
    ci,
    distLy: dist * LY_PER_PC,
    // 赤道 → 黃道（繞 x 軸轉 −ε），秒差距 → 光年
    x: xe * LY_PER_PC,
    y: (Math.cos(OBL) * ye + Math.sin(OBL) * ze) * LY_PER_PC,
    z: (-Math.sin(OBL) * ye + Math.cos(OBL) * ze) * LY_PER_PC,
  });
}
stars.sort((a, b) => a.mag - b.mag); // 亮星在前，行動裝置可只畫前段

// ---------- 中文名（Wikidata） ----------
const toTrad = OpenCC.Converter({ from: "cn", to: "tw" });
// 以 Hipparcos 編號比對 Wikidata 條目（P528 星表代碼 = "HIP n"）。
// 用名稱比對不可靠（例：Sirius 會對到同名歌曲），用星表編號才能確定是同一顆星。
const hips = [...new Set(stars.filter((s) => (s.proper || s.bf) && s.hip != null).map((s) => s.hip))];
const zhByHip = new Map();
const zhLang = new Map();
const BATCH = 150;
for (let i = 0; i < hips.length; i += BATCH) {
  const batch = hips.slice(i, i + BATCH);
  const values = batch.map((h) => `"HIP ${h}"`).join(" ");
  const q = `SELECT ?code ?l (LANG(?l) AS ?lang) WHERE { VALUES ?code { ${values} } ?item wdt:P528 ?code . ?item rdfs:label ?l . FILTER(LANG(?l) IN ("zh-tw","zh-hant","zh-hk","zh")) }`;
  const rows = await sparql(`wikidata/stars-hip-${String(i / BATCH).padStart(2, "0")}.json`, q);
  const pref = ["zh-tw", "zh-hant", "zh-hk", "zh"];
  for (const r of rows) {
    const hip = Number(r.code.value.replace("HIP ", ""));
    const lang = r.lang.value;
    const label = r.l.value;
    // 標籤若只是英文或星表編號（非中文）就略過
    if (!/[一-鿿]/.test(label)) continue;
    const prev = zhLang.get(hip);
    if (prev == null || pref.indexOf(lang) < pref.indexOf(prev)) {
      zhLang.set(hip, lang);
      zhByHip.set(hip, toTrad(label));
    }
  }
}

// ---------- 輸出 ----------
const outDir = join(PUBLIC_DATA, "stars");
await mkdir(outDir, { recursive: true });
const buf = new Float32Array(stars.length * 5);
stars.forEach((s, i) => buf.set([s.x, s.y, s.z, s.absmag, Number.isFinite(s.ci) ? s.ci : NaN], i * 5));
await writeFile(join(outDir, "stars.bin"), Buffer.from(buf.buffer));

const catalog = [];
stars.forEach((s, i) => {
  if (!s.proper && !s.bf) return;
  catalog.push({
    i, // stars.bin 內的索引
    en: s.proper,
    zh: s.hip != null ? (zhByHip.get(s.hip) ?? null) : null,
    bf: s.bf,
    con: s.con,
    hip: s.hip,
    hd: s.hd,
    mag: s.mag,
    absmag: s.absmag,
    spect: s.spect,
    ci: Number.isFinite(s.ci) ? s.ci : null,
    distLy: Number(s.distLy.toPrecision(6)),
  });
});
const noZh = catalog.filter((s) => s.en && !s.zh).map((s) => s.en);

await writeJson(
  join(outDir, "stars.json"),
  {
    source: "HYG Database v4.4 (astronexus) — https://codeberg.org/astronexus/hyg",
    license: "CC BY-SA 4.0",
    retrievedAt: (await sourceInfo("hyg/hyg_v44.csv.gz"))?.retrievedAt,
    zhNameSource: "Wikidata：以 Hipparcos 編號（P528 星表代碼）比對條目，取中文標籤並以 OpenCC 轉為繁體",
    selection: `視星等 ≤ ${MAG_LIMIT} 或距離 ≤ ${NEAR_PC} 秒差距；距離不明者不收`,
    frame: "J2000 黃道座標，原點為太陽，單位光年",
    count: stars.length,
    excludedUnknownDistance: unknownDist,
    properNamesWithoutZh: noZh,
    stars: catalog,
  },
  { pretty: false },
);
console.log(
  `恆星 ${stars.length} 顆；有專名 ${catalog.filter((s) => s.en).length}（其中 ${noZh.length} 顆查無中文名）；有拜耳/佛氏編號 ${catalog.length}；距離不明而未收的亮星 ${unknownDist}`,
);
console.log("最遠:", Math.max(...stars.map((s) => s.distLy)).toFixed(0), "光年");
console.log(catalog.slice(0, 25).map((s) => `${s.en ?? s.bf}=${s.zh ?? "—"}`).join(" "));
