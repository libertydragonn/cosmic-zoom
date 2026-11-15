// 天體表面貼圖與自轉模型。
// 來源：USGS Astrogeology 行星地圖服務（WMS）、NASA Photojournal（Cassini 2014 衛星彩色地圖）、
//       USGS Dawn 穀神星 GeoTIFF、STScI MAST 的 Hubble OPAL 全球地圖、PDS Rings Node 的
//       Voyager 2 PPS 土星環掩星剖面、NAIF pck00011.tpc（IAU 自轉模型）。
// 輸出：public/textures/*.jpg|png（等距圓柱投影，左緣＝東經 −180°，向右遞增，上緣＝北緯 90°）、
//       app/data/textures.json、app/data/rotation.json。
import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { APP_DATA, ROOT, fetchCached, writeJson } from "./lib/common.mjs";
import { alignGrid, bestAlignment } from "./lib/map-align.mjs";

sharp.cache(false);
const TEX_DIR = join(ROOT, "public/textures");
await mkdir(TEX_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1. 自轉模型（IAU WGCCRE，經 NAIF pck00011.tpc）
// ---------------------------------------------------------------------------
const pck = await fetchCached("naif-pck00011.tpc", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc");
const pckVals = {};
for (const block of pck.split("\\begindata").slice(1)) {
  const data = block.split("\\begintext")[0];
  for (const m of data.matchAll(/BODY(\d+)_([A-Z_]+)\s*=\s*(\(([^)]*)\)|([-+\d.ED]+))/g)) {
    const raw = m[4] ?? m[5];
    const values = raw
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((x) => Number(x.replace(/D/i, "E")));
    (pckVals[m[1]] ??= {})[m[2]] = values;
  }
}

function rotationOf(naifId) {
  const b = pckVals[naifId];
  if (!b?.POLE_RA || !b?.POLE_DEC || !b?.PM) throw new Error(`PCK 無 ${naifId} 的自轉模型`);
  const rec = { naifId, ra: b.POLE_RA, dec: b.POLE_DEC, pm: b.PM };
  const nra = b.NUT_PREC_RA ?? [];
  const ndec = b.NUT_PREC_DEC ?? [];
  const npm = b.NUT_PREC_PM ?? [];
  const used = Math.max(nra.length, ndec.length, npm.length);
  if (used > 0 && [...nra, ...ndec, ...npm].some((v) => v !== 0)) {
    // 行星系統代號：301→3、501→5、599→5、499→4
    const sys = String(Math.floor(naifId / 100));
    const sysVals = pckVals[sys];
    const degree = sysVals?.MAX_PHASE_DEGREE?.[0] ?? 1;
    const flat = sysVals?.NUT_PREC_ANGLES;
    if (!flat) throw new Error(`PCK 無 BODY${sys}_NUT_PREC_ANGLES`);
    const ang = [];
    for (let i = 0; i < used; i++) ang.push(flat.slice(i * (degree + 1), (i + 1) * (degree + 1)));
    Object.assign(rec, { nra, ndec, npm, ang });
  }
  return rec;
}

// ---------------------------------------------------------------------------
// 2. 影像工具
// ---------------------------------------------------------------------------
/** 讀成 RGBA 8-bit 原始像素。 */
async function loadRgba(input, maxWidth = 4096) {
  const meta = await sharp(input, { limitInputPixels: false }).metadata();
  const { data, info } = await sharp(input, { limitInputPixels: false })
    .resize(Math.min(maxWidth, meta.width), null, { kernel: "lanczos3" })
    .toColourspace("srgb")
    .ensureAlpha()
    .raw({ depth: "uchar" })
    .toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

/** 左右鏡射與水平循環位移：out(x) = src'((x + shift) mod w)，src' 為（必要時）鏡射後的影像。 */
function remap(img, { flip = false, shiftPx = 0 }) {
  const { data, w, h } = img;
  const out = Buffer.alloc(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sx = (((x + shiftPx) % w) + w) % w;
      if (flip) sx = w - 1 - sx;
      data.copy(out, (y * w + x) * 4, (y * w + sx) * 4, (y * w + sx) * 4 + 4);
    }
  }
  return { data: out, w, h };
}

/** 沒有成像的區域（透明）以已成像區域的平均色填補，回傳填補比例。 */
function fillNoData(img) {
  const { data } = img;
  let r = 0, g = 0, b = 0, n = 0, missing = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] >= 128) {
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    } else missing++;
  }
  if (!missing) return 0;
  r /= n; g /= n; b /= n;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) {
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
    data[i + 3] = 255;
  }
  return missing / (missing + n);
}

/**
 * 巨行星地圖的缺漏填補（Hubble 看不到的區域在 OPAL 地圖裡是黑色）：
 * 1. 近黑的像素視為未觀測，並把有效區往內縮 erodePx，去掉臨邊附近的彩色條紋；
 * 2. 同一經度上下都有觀測時（例如被土星環擋住的帶狀區），沿緯度線性內插；
 * 3. 極區等外側沒有觀測時，延伸最接近的已觀測緯度帶的平均色。
 * 回傳填補比例。
 */
function fillZonal(img, { erodePx }) {
  const { data, w, h } = img;
  const valid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) valid[i] = Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) > 6 ? 1 : 0;
  // 侵蝕：任一 erodePx 範圍內（上下左右）有無效像素者也視為無效
  if (erodePx > 0) {
    const tmp = new Uint8Array(valid);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!tmp[y * w + x]) continue;
        let ok = 1;
        for (let d = 1; d <= erodePx && ok; d++) {
          if (y - d >= 0 && !tmp[(y - d) * w + x]) ok = 0;
          else if (y + d < h && !tmp[(y + d) * w + x]) ok = 0;
          else if (!tmp[y * w + ((x + d) % w)] || !tmp[y * w + ((x - d + w) % w)]) ok = 0;
        }
        valid[y * w + x] = ok;
      }
  }
  // 各緯度帶的平均色
  const rowMean = new Array(h).fill(null);
  for (let y = 0; y < h; y++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!valid[i]) continue;
      r += data[i * 4]; g += data[i * 4 + 1]; b += data[i * 4 + 2]; n++;
    }
    if (n > w * 0.25) rowMean[y] = [r / n, g / n, b / n];
  }
  const nearestRow = (y) => {
    for (let d = 0; d < h; d++) {
      if (y - d >= 0 && rowMean[y - d]) return rowMean[y - d];
      if (y + d < h && rowMean[y + d]) return rowMean[y + d];
    }
    return [128, 128, 128];
  };
  let filled = 0;
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (valid[y * w + x]) { y++; continue; }
      let y2 = y;
      while (y2 < h && !valid[y2 * w + x]) y2++;
      const above = y > 0 ? (y - 1) * w + x : -1;
      const below = y2 < h ? y2 * w + x : -1;
      for (let yy = y; yy < y2; yy++) {
        const i = yy * w + x;
        let c;
        if (above >= 0 && below >= 0) {
          const t = (yy - y + 1) / (y2 - y + 1);
          c = [0, 1, 2].map((k) => data[above * 4 + k] * (1 - t) + data[below * 4 + k] * t);
        } else c = nearestRow(yy);
        data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2]; data[i * 4 + 3] = 255;
        filled++;
      }
      y = y2;
    }
  }
  return filled / (w * h);
}

/** 降低飽和度：s = 1 不變，s = 0 為灰階（以亮度保留明暗）。 */
function saturate(img, s) {
  const { data } = img;
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    for (let c = 0; c < 3; c++) data[i + c] = Math.max(0, Math.min(255, l + s * (data[i + c] - l)));
  }
}

async function writeJpeg(img, width, file) {
  const height = Math.round(width / 2);
  await sharp(img.data, { raw: { width: img.w, height: img.h, channels: 4 } })
    .removeAlpha()
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .jpeg({ quality: 84, mozjpeg: true })
    .toFile(join(TEX_DIR, file));
  return { file: `textures/${file}`, width, height };
}

/** 讀 GeoTIFF 標籤：回傳左緣經度（度，假設全球覆蓋）。 */
function geotiffLeftLon(buf) {
  const le = buf.toString("ascii", 0, 2) === "II";
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const f64 = (o) => (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  const ifd = u32(4);
  const n = u16(ifd);
  const tags = {};
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), off: e + 8 };
  }
  const val = (t) => (t.type === 3 ? u16(t.off) : u32(t.off));
  const doubles = (t) => Array.from({ length: t.count }, (_, k) => f64(u32(t.off) + k * 8));
  const width = val(tags[256]);
  const scale = doubles(tags[33550]);
  const tie = doubles(tags[33922]);
  const spanX = width * scale[0];
  return { leftLonDeg: ((tie[3] - tie[0] * scale[0]) / spanX) * 360, width, tie, scale };
}

const wms = (map, layer, w) =>
  "https://planetarymaps.usgs.gov/cgi-bin/mapserv?" +
  `map=/maps/${map}_simp_cyl.map&service=WMS&version=1.1.1&request=GetMap&layers=${layer}&styles=` +
  `&srs=EPSG:4326&bbox=-180,-90,180,90&width=${w}&height=${w / 2}&format=image/png&transparent=TRUE`;

async function wmsTitle(map, layer) {
  const caps = await fetchCached(
    `textures/wms-${map.replace("/", "-")}-capabilities.xml`,
    `https://planetarymaps.usgs.gov/cgi-bin/mapserv?map=/maps/${map}_simp_cyl.map&service=WMS&request=GetCapabilities&version=1.1.1`,
  );
  const m = new RegExp(`<Name>${layer}</Name>\\s*<Title>([^<]*)</Title>`).exec(caps);
  if (!m) throw new Error(`WMS ${map} 沒有圖層 ${layer}`);
  return m[1];
}

// ---------------------------------------------------------------------------
// 3. 各天體的貼圖
// ---------------------------------------------------------------------------
const textures = {};
const missing = [];

async function emit(id, img, { hi = false, srcWidth = img.w, ...meta }) {
  const base = Math.min(2048, srcWidth);
  const entry = { ...meta, ...(await writeJpeg(img, base, `${id}.jpg`)) };
  if (hi && srcWidth > 2048) entry.hi = await writeJpeg(img, Math.min(4096, srcWidth), `${id}-hi.jpg`);
  textures[id] = entry;
  console.log(`  ${id}: ${entry.file}${entry.hi ? ` + ${entry.hi.file}` : ""}`);
}

// 3a. USGS WMS（皆為行星中心座標、東經為正，已以火星、月球、地球、木衛一的地標確認）
const WMS_MAPS = [
  { id: "mercury", map: "mercury/mercury", layer: "MESSENGER", w: 4096, hi: true, naif: 199 },
  { id: "earth", map: "earth/earth", layer: "MODIS", w: 4096, hi: true, naif: 399 },
  { id: "mars", map: "mars/mars", layer: "MDIM21_color", w: 4096, hi: true, naif: 499 },
  { id: "earth-moon", map: "earth/moon", layer: "LROC_WAC", w: 4096, hi: true, naif: 301 },
  { id: "jupiter-io", map: "jupiter/io", layer: "SSI_VGR_color", w: 2048, naif: 501 },
  { id: "jupiter-europa", map: "jupiter/europa", layer: "GALILEO_VOYAGER", w: 2048, naif: 502 },
  { id: "jupiter-ganymede", map: "jupiter/ganymede", layer: "GALILEO_VOYAGER", w: 2048, naif: 503 },
  { id: "jupiter-callisto", map: "jupiter/callisto", layer: "GALILEO_VOYAGER", w: 2048, naif: 504 },
  { id: "saturn-phoebe", map: "saturn/phoebe", layer: "CASSINI", w: 1024, naif: 609 },
  { id: "neptune-triton", map: "neptune/triton", layer: "TRITON_VOYAGER2", w: 2048, naif: 801 },
  { id: "pluto", map: "pluto/pluto", layer: "NEWHORIZONS_PLUTO_MOSAIC", w: 2048, naif: 999 },
  { id: "pluto-charon", map: "pluto/charon", layer: "NEWHORIZONS_CHARON_MOSAIC", w: 2048, naif: 901 },
];
for (const t of WMS_MAPS) {
  const url = wms(t.map, t.layer, t.w);
  const buf = await fetchCached(`textures/${t.id}-${t.layer}-${t.w}.png`, url, { binary: true });
  const img = await loadRgba(buf);
  const filled = fillNoData(img);
  if (filled > 0.005) missing.push({ body: t.id, field: "texture", reason: `約 ${(filled * 100).toFixed(0)}% 表面未被探測器拍攝，以已成像區域的平均色填補` });
  await emit(t.id, img, {
    hi: t.hi,
    naifId: t.naif,
    lat: "planetocentric",
    source: `USGS Astrogeology 行星地圖服務：${await wmsTitle(t.map, t.layer)}`,
    url,
    unimagedFraction: Number(filled.toFixed(3)),
  });
}

// 3b. Cassini 2014 土星衛星彩色地圖（NASA/JPL-Caltech/Space Science Institute）
//     官方說明顏色為「增強色」（含紫外與紅外），這裡把飽和度降到 40%。
//     經度方向以與 USGS 鑲嵌圖的相關性自動判定。
const CASSINI = [
  { id: "saturn-mimas", pia: "PIA18437", ref: ["saturn/mimas", "CASSINI_MIMAS_MOSAIC"], naif: 601 },
  { id: "saturn-enceladus", pia: "PIA18435", ref: ["saturn/enceladus", "CASSINI_100m"], naif: 602 },
  { id: "saturn-tethys", pia: "PIA18439", ref: ["saturn/tethys", "CASSINI"], naif: 603 },
  { id: "saturn-dione", pia: "PIA18434", ref: ["saturn/dione", "CASSINI_VOYAGER"], naif: 604 },
  { id: "saturn-rhea", pia: "PIA18438", ref: ["saturn/rhea", "CASSINI_VOYAGER"], naif: 605 },
  { id: "saturn-iapetus", pia: "PIA18436", ref: ["saturn/iapetus", "CASSINI_VOYAGER"], naif: 608 },
];
const SATURN_MOON_SATURATION = 0.4;
for (const t of CASSINI) {
  const lower = t.pia.toLowerCase();
  const url = `https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/${lower.slice(0, 5)}/${lower}/${t.pia}.jpg`;
  const buf = await fetchCached(`textures/${t.pia}.jpg`, url, { binary: true });
  const refUrl = wms(t.ref[0], t.ref[1], 720);
  const refBuf = await fetchCached(`textures/${t.id}-${t.ref[1]}-720.png`, refUrl, { binary: true });
  // 預期：左緣為東經 0°（向右遞增），即不鏡射、位移 180°。以實測確認後採用整數的 180°。
  const best = bestAlignment(await alignGrid(buf, { mode: "bandpass" }), await alignGrid(refBuf, { mode: "bandpass" }));
  const off = Math.abs(best.shiftDeg - 180);
  const margin = best.corr / Math.max(best.runnerUp, 1e-6);
  console.log(`  ${t.id}: 與 USGS 鑲嵌圖最佳對齊 flip=${best.flip} shift=${best.shiftDeg}° r=${best.corr.toFixed(3)}（次佳 ${best.runnerUp.toFixed(3)}）`);
  if (best.flip || off > 10 || margin < 1.5) throw new Error(`${t.id} 經度方向無法確認，請人工檢查`);
  const page = await fetchCached(`textures/${t.pia}.html`, `https://photojournal.jpl.nasa.gov/catalog/${t.pia}`);
  const title = /<title>([^<]*?)(?: - NASA Science)?<\/title>/.exec(page)?.[1] ?? t.pia;
  let img = await loadRgba(buf);
  img = remap(img, { shiftPx: Math.round(img.w / 2) });
  saturate(img, SATURN_MOON_SATURATION);
  await emit(t.id, img, {
    naifId: t.naif,
    lat: "planetocentric",
    source: `NASA/JPL-Caltech/Space Science Institute：${title}（${t.pia}）`,
    url,
    note: `官方說明顏色為增強色（延伸到紫外與紅外），已將飽和度降為 ${SATURN_MOON_SATURATION * 100}%；左緣為東經 0°，經與 USGS 鑲嵌圖的地形比對確認（最佳位移 ${best.shiftDeg}°，預期 180°）`,
    alignment: { measuredShiftDeg: best.shiftDeg, corr: Number(best.corr.toFixed(3)), runnerUp: Number(best.runnerUp.toFixed(3)) },
  });
}

// 3c. 穀神星：USGS 的 Dawn FC 全球鑲嵌圖（GeoTIFF，東經為正）
{
  const url = "https://planetarymaps.usgs.gov/mosaic/Ceres_Dawn_FC_DLR_global_20ppd_Oct2015.tif";
  const buf = await fetchCached("textures/Ceres_Dawn_FC_DLR_global_20ppd_Oct2015.tif", url, { binary: true });
  const geo = geotiffLeftLon(buf);
  let img = await loadRgba(buf);
  // 轉成左緣＝東經 −180°
  const shiftDeg = (((-180 - geo.leftLonDeg) % 360) + 360) % 360;
  img = remap(img, { shiftPx: Math.round((shiftDeg / 360) * img.w) });
  console.log(`  ceres: GeoTIFF 左緣經度 ${geo.leftLonDeg.toFixed(2)}°，位移 ${shiftDeg.toFixed(2)}°`);
  await emit("ceres", img, {
    naifId: 2000001,
    lat: "planetocentric",
    source: "USGS Astrogeology：Ceres Dawn FC Global Mosaic 400m（DLR 製作，2015-10）",
    url,
  });
}

// 3d. 巨行星：Hubble OPAL 全球地圖（行星面緯度）
// 顏色不用 OPAL 的 TIFF 預覽（各濾鏡亮度任意縮放，偏色），而是把三個濾鏡的 FITS 科學資料
// 乘上 README 表列的係數換算成反射率 I/F，以同一個增益映射到 RGB，保留濾鏡間的真實比例。

/** 讀單一 HDU 的 FITS 影像（BITPIX −32）。回傳由上到下的列（第一列為 FITS 的最後一列）。 */
function readFits(buf) {
  let off = 0;
  const head = {};
  for (;;) {
    const card = buf.toString("ascii", off, off + 80);
    off += 80;
    const m = /^(\w+)\s*=\s*('?)([^'\/]*)\2/.exec(card);
    if (m) head[m[1]] = m[3].trim();
    if (card.startsWith("END ")) break;
  }
  off = Math.ceil(off / 2880) * 2880;
  const w = Number(head.NAXIS1), h = Number(head.NAXIS2);
  if (head.BITPIX !== "-32") throw new Error(`FITS BITPIX ${head.BITPIX} 不支援`);
  const scale = Number(head.BSCALE ?? 1), zero = Number(head.BZERO ?? 0);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) out[(h - 1 - y) * w + x] = buf.readFloatBE(off + (y * w + x) * 4) * scale + zero;
  return { data: out, w, h, head };
}

/** FITS 標頭的 EXPSTART／EXPEND（MJD）→「2026-09-14 09:19 至 2026-09-15 03:08 UTC」。 */
function observedRange(head) {
  const s = Number(head.EXPSTART), e = Number(head.EXPEND);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  const fmt = (mjd) => new Date((mjd - 40587) * 86400000).toISOString().slice(0, 16).replace("T", " ");
  return `${fmt(s)} 至 ${fmt(e)} UTC`;
}

/** 兩張同尺寸灰階圖的相關係數（用來確認 FITS 的上下方向與 TIFF 預覽一致）。 */
function correlation(a, b) {
  let ma = 0, mb = 0, n = 0;
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) { ma += a[i]; mb += b[i]; n++; }
  ma /= n; mb /= n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i])) continue;
    ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2;
  }
  return ab / Math.sqrt(aa * bb);
}

const OPAL_ACK =
  "This work used data acquired from the NASA/ESA HST Space Telescope, associated with OPAL program (PI: Simon, GO13937), and archived by the Space Telescope Science Institute, which is operated by the Association of Universities for Research in Astronomy, Inc., under NASA contract NAS 5-26555. All maps are available at http://dx.doi.org/10.17909/T9G593.";
const OPAL = [
  // edge：README 對經度方向的描述；leftEastLon＝左緣的東經；eastToRight＝東經是否向右遞增
  { id: "jupiter", dir: "cycle32/jupiter", stem: "jupiter-2025a", color: "f395n-f502n-f631n", readme: "jupiter-2025", naif: 599, hi: true, leftEastLon: 0, eastToRight: true, erode: 0.004 },
  { id: "saturn", dir: "cycle33/saturn", stem: "saturn-2026a", color: "f395n-f502n-f631n", readme: "saturn-2026", naif: 699, leftEastLon: 0, eastToRight: true, erode: 0.01 },
  { id: "uranus", dir: "cycle33/uranus", stem: "uranus-2025a", color: "f657n-f547m-f467m", readme: "uranus-2025", naif: 799, leftEastLon: 0, eastToRight: false, erode: 0.12 },
  { id: "neptune", dir: "cycle33/neptune", stem: "neptune-2026a", color: "f467m-f547m-f657n", readme: "neptune-2026", naif: 899, leftEastLon: 0, eastToRight: true, erode: 0.12 },
];
for (const t of OPAL) {
  const base = `https://archive.stsci.edu/hlsps/opal/${t.dir}`;
  const readme = await fetchCached(`textures/opal-${t.readme}-readme.txt`, `${base}/hlsp_opal_hst_wfc3-uvis_${t.readme}_all_v1_readme.txt`);
  const edge = /\((left|right) edge = [^)]*\)/.exec(readme)?.[0];
  if (!edge) throw new Error(`OPAL ${t.id} README 沒有經度方向說明`);
  // 與程式中的設定核對，README 改變時中止
  const expected = t.eastToRight ? /left edge = (0|360) (System III )?(deg )?W\. longitude, decreasing to the right/ : /right edge = 0 deg E\. longitude, increasing to the left/;
  if (!expected.test(edge)) throw new Error(`OPAL ${t.id} 經度方向與預期不符：${edge}`);
  const acquired = /data were acquired (?:with WFC3\/UVIS )?between (.*?\d{1,2}:\d{2}\s*(?:UT)?\s+(?:and|to)\s+.*?\d{1,2}:\d{2}\s*UT)/.exec(readme);
  // README 的表格：濾鏡、Minnaert k、I/F 換算係數
  const ifScale = {};
  for (const m of readme.matchAll(/^(F\w+)\s+(?:[\d.]+|none)\s+([\d.]+)/gim)) ifScale[m[1].toUpperCase()] = Number(m[2]);
  // 由長波到短波＝紅、綠、藍
  const filters = t.color.split("-").map((f) => f.toUpperCase());
  filters.sort((p, q) => Number(q.match(/\d+/)[0]) - Number(p.match(/\d+/)[0]));
  const bands = [];
  for (const f of filters) {
    if (!ifScale[f]) throw new Error(`OPAL ${t.id} README 沒有 ${f} 的 I/F 係數`);
    const fname = `hlsp_opal_hst_wfc3-uvis_${t.stem}_${f.toLowerCase()}_v1_globalmap.fits`;
    const fits = readFits(await fetchCached(`textures/${fname}`, `${base}/${fname}`, { binary: true }));
    for (let i = 0; i < fits.data.length; i++) fits.data[i] = fits.data[i] > 0 ? fits.data[i] * ifScale[f] : NaN;
    bands.push(fits);
  }
  const { w, h } = bands[0];
  // 以 TIFF 預覽確認 FITS 的上下方向（README 只描述經度）
  const tifName = `hlsp_opal_hst_wfc3-uvis_${t.stem}_${t.color}_v1_globalmap.tif`;
  const tif = await sharp(await fetchCached(`textures/${tifName}`, `${base}/${tifName}`, { binary: true }), { limitInputPixels: false })
    .extractChannel(0)
    .resize(w, h, { fit: "fill" })
    .raw({ depth: "uchar" })
    .toBuffer();
  const flipped = new Float32Array(w * h);
  for (let y = 0; y < h; y++) flipped.set(bands[0].data.subarray(y * w, (y + 1) * w), (h - 1 - y) * w);
  const cKeep = correlation(bands[0].data, tif);
  const cFlip = correlation(flipped, tif);
  console.log(`  ${t.id}: FITS 方向 r=${cKeep.toFixed(3)}，上下翻轉 r=${cFlip.toFixed(3)}`);
  if (Math.max(cKeep, cFlip) < 0.5) throw new Error(`OPAL ${t.id} FITS 與預覽對不上`);
  if (cFlip > cKeep) for (const b of bands) {
    const c = new Float32Array(w * h);
    for (let y = 0; y < h; y++) c.set(b.data.subarray(y * w, (y + 1) * w), (h - 1 - y) * w);
    b.data = c;
  }
  // 共同增益：讓 99.5 百分位的最亮通道約為 0.92（線性），再做 sRGB 編碼
  const peaks = [];
  for (let i = 0; i < w * h; i += 7) {
    const v = Math.max(bands[0].data[i], bands[1].data[i], bands[2].data[i]);
    if (Number.isFinite(v)) peaks.push(v);
  }
  peaks.sort((p, q) => p - q);
  const gain = 0.92 / peaks[Math.floor(peaks.length * 0.995)];
  const srgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const rgb = bands.map((b) => b.data[i]);
    if (rgb.some((v) => !Number.isFinite(v))) continue; // 保持黑色＝未觀測，交給 fillZonal
    for (let k = 0; k < 3; k++) data[i * 4 + k] = Math.max(1, Math.min(255, Math.round(srgb(Math.min(1, rgb[k] * gain)) * 255)));
    data[i * 4 + 3] = 255;
  }
  let img = { data, w, h };
  const url = `${base}/hlsp_opal_hst_wfc3-uvis_${t.stem}_${filters.map((f) => f.toLowerCase()).join("|")}_v1_globalmap.fits`;
  const filled = fillZonal(img, { erodePx: Math.round(t.erode * img.h) });
  if (filled > 0.005)
    missing.push({ body: t.id, field: "texture", reason: `Hubble 觀測時約 ${(filled * 100).toFixed(0)}% 的表面看不到（極區、背光面或被環遮住），以相鄰緯度內插或延伸最接近緯度帶的平均色填補` });
  // 統一成「東經向右遞增」，再把左緣移到東經 −180°
  if (!t.eastToRight) img = remap(img, { flip: true });
  img = remap(img, { shiftPx: Math.round(img.w / 2) });
  await emit(t.id, img, {
    hi: t.hi,
    naifId: t.naif,
    lat: "planetographic",
    source: `Hubble OPAL 全球地圖 ${t.stem}（NASA, ESA, A.A. Simon, M.H. Wong；CC BY 4.0）`,
    observed: observedRange(bands[0].head) ?? (acquired?.[1] ?? "").trim(),
    url,
    longitudeConvention: `README：${edge}`,
    note: `顏色由 ${filters.join("／")} 三個濾鏡的反射率（I/F）分別當作紅／綠／藍，以同一增益映射，是近似真彩色。雲帶會隨時間漂移，貼圖只代表觀測當時的樣貌。`,
    unimagedFraction: Number(filled.toFixed(3)),
    acknowledgment: OPAL_ACK,
  });
}

// ---------------------------------------------------------------------------
// 4. 土星環：Voyager 2 PPS δ Sco 掩星的法向不透明度剖面（10 km 解析度）
// ---------------------------------------------------------------------------
let ring;
{
  const base = "https://pds-rings.seti.org/holdings/volumes/VG_28xx/VG_2801/EASYDATA/KM010";
  const label = await fetchCached("textures/VG_2801-PS1P01.LBL", `${base}/PS1P01.LBL`);
  const tab = await fetchCached("textures/VG_2801-PS1P01.TAB", `${base}/PS1P01.TAB`);
  // 欄位名稱取自 LBL 的 COLUMN 物件：半徑、平均訊號、訊號誤差、法向不透明度中位數、下限、上限
  const names = [...label.matchAll(/OBJECT\s*=\s*COLUMN\s+NAME\s*=\s*(\w+)/g)].map((m) => m[1]);
  const iTau = names.indexOf("MEDIAN_NORMAL_OPACITY");
  const iSig = names.indexOf("MEAN_SIGNAL");
  if (names[0] !== "RING_INTERCEPT_RADIUS" || iTau < 0 || iSig < 0) throw new Error(`土星環剖面欄位與預期不同：${names.join(",")}`);
  const rows = tab
    .trim()
    .split(/\r?\n/)
    .map((l) => l.split(",").map(Number));
  const r0 = rows[0][0];
  const r1 = rows[rows.length - 1][0];
  const N = 2048;
  const px = Buffer.alloc(N * 4);
  let unconstrained = 0;
  for (let i = 0; i < N; i++) {
    // 每個像素取其涵蓋半徑內各樣本的平均穿透率
    const a = r0 + ((r1 - r0) * i) / N;
    const b = r0 + ((r1 - r0) * (i + 1)) / N;
    let trans = 0, n = 0;
    for (const row of rows) {
      if (row[0] < a || row[0] >= b) continue;
      // LBL：無法約束的樣本平均訊號為 0；不透光的樣本不透明度為 99
      if (row[iSig] === 0) { unconstrained++; continue; }
      let tau = row[iTau];
      if (tau >= 99) tau = 6;
      trans += Math.exp(-Math.max(0, tau));
      n++;
    }
    const opacity = n ? 1 - trans / n : 0;
    const v = Math.round(opacity * 255);
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 255;
    px[i * 4 + 3] = v;
  }
  await sharp(px, { raw: { width: N, height: 1, channels: 4 } }).png().toFile(join(TEX_DIR, "saturn-ring.png"));
  ring = {
    file: "textures/saturn-ring.png",
    innerKm: r0,
    outerKm: r1,
    source: "PDS Rings Node：Voyager 2 PPS δ Sco 掩星剖面 VG_2801 KM010/PS1P01（1981-08-26，10 km 解析度）",
    url: `${base}/PS1P01.TAB`,
    note: "Alpha 通道＝法向不透明度 1 − exp(−τ)；τ 無法約束的樣本略過。畫面上的透明度與明暗由 τ 以單次散射近似計算，顏色與整體亮度為顯示用設定。",
    unconstrainedSamples: unconstrained,
  };
  console.log(`  saturn ring: ${r0}–${r1} km，${rows.length} 筆，無法約束 ${unconstrained} 筆`);
}

// ---------------------------------------------------------------------------
// 5. 輸出
// ---------------------------------------------------------------------------
const rotation = { source: "IAU WGCCRE 自轉模型，經 NAIF pck00011.tpc", bodies: {} };
for (const [id, t] of Object.entries(textures)) rotation.bodies[id] = rotationOf(t.naifId);
rotation.bodies.saturn ??= rotationOf(699);
rotation.bodies.sun = rotationOf(10);

const NO_MAP = [
  { body: "金星", reason: "可見光下只看得到雲頂，沒有全球雲頂地圖；Magellan 雷達圖是地表，不是肉眼所見，因此維持雲層的單色" },
  { body: "土衛六", reason: "可見光下被橘色霧霾覆蓋；Cassini 的地表圖是近紅外影像，不是肉眼所見，因此維持單色" },
  { body: "天衛一至天衛五", reason: "Voyager 2 只拍到約南半球；找不到可確認經度方向的全球投影鑲嵌圖" },
  { body: "火衛一、火衛二", reason: "形狀很不規則，貼在球體上會失真；USGS 的火衛一資料是暈渲地形圖而非影像" },
  { body: "其他衛星與矮行星", reason: "沒有探測器近距離成像，無全球地圖" },
  { body: "太陽以外的恆星", reason: "除少數超巨星的干涉儀模糊影像外，沒有恆星表面圖；以有效溫度對應的顏色顯示" },
];

await writeJson(join(APP_DATA, "textures.json"), {
  generatedBy: "scripts/fetch-textures.mjs",
  convention: "等距圓柱投影；u=0 為東經 −180°、向右遞增；v 上緣為北緯 90°；北極為 IAU 定義的北極",
  bodies: textures,
  saturnRing: ring,
  missing: [...missing, ...NO_MAP],
});
await writeJson(join(APP_DATA, "rotation.json"), rotation);
