// 產生 DATA_GAPS.md：列出所有「未能從來源取得」的資料，以及被排除的項目。
// 這些欄位在介面上顯示為「無資料」，沒有以任何估計值填補。
import { existsSync, unlinkSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_DATA, PUBLIC_DATA, RAW_DIR, ROOT, SOURCES_FILE, readJson } from "./lib/common.mjs";

const solar = await readJson(join(APP_DATA, "solar-system.json"));
const moonIndex = await readJson(join(APP_DATA, "moon-index.json"));
const small = await readJson(join(PUBLIC_DATA, "smallbodies/index.json"));
const stars = await readJson(join(PUBLIC_DATA, "stars/stars.json"));

// 順便清理 sources.json 內已不存在的快取紀錄
const sources = await readJson(SOURCES_FILE);
for (const name of Object.keys(sources)) {
  if (!existsSync(join(RAW_DIR, name))) delete sources[name];
}
if (existsSync(join(RAW_DIR, "horizons-moons"))) {
  for (const f of readdirSync(join(RAW_DIR, "horizons-moons"))) {
    if (!sources[`horizons-moons/${f}`]) unlinkSync(join(RAW_DIR, "horizons-moons", f));
  }
}
await writeFile(SOURCES_FILE, JSON.stringify(sources, null, 2) + "\n");

const FIELD_ZH = {
  meanRadiusKm: "半徑",
  massKg: "質量",
  gm: "GM／質量",
  densityGcm3: "密度",
  geometricAlbedo: "反照率",
  rotationPeriodDays: "自轉週期",
  discovery: "發現資料",
  zh: "中文名",
  orbit: "軌道（未收錄）",
  pole: "自轉軸",
};

const lines = [];
const out = (s = "") => lines.push(s);
out("# 資料缺漏清單");
out();
out("本檔由 `scripts/report-gaps.mjs` 自動產生。以下項目無法從指定來源取得，介面上顯示為「無資料」，**沒有以估計值或記憶中的數值填補**。");
out();

out("## 太陽、行星、矮行星");
out();
if (solar.missing.length === 0) out("無缺漏。");
else {
  const by = {};
  for (const m of solar.missing) (by[m.body] ??= []).push(`${FIELD_ZH[m.field] ?? m.field}（${m.reason}）`);
  for (const [body, items] of Object.entries(by)) out(`- **${body}**：${items.join("；")}`);
}
out();

out("## 衛星");
out();
out("只收錄有 IAU 正式名稱的衛星。JPL 表中僅有臨時編號而未收錄的數量：");
out();
for (const [planet, sys] of Object.entries(moonIndex.systems)) {
  out(`- ${planet}：收錄 ${sys.count} 顆，未收錄 ${sys.unnamedExcluded} 顆`);
}
out();
const groups = {};
for (const m of moonIndex.missing) (groups[m.field] ??= []).push(m.body);
for (const [field, bodies] of Object.entries(groups)) {
  out(`### 缺${FIELD_ZH[field] ?? field}（${bodies.length} 顆）`);
  out();
  out(bodies.join("、"));
  out();
}
out("矮行星的衛星只有冥王星的五顆在 JPL 衛星表內；鬩神星、妊神星、鳥神星、創神星、亡神星、共工星的衛星不在該表中，因此未收錄。");
out();

out("## 小天體");
out();
out(`- 主小行星帶：JPL SBDB 共 ${small.mainbelt.totalInSbdb} 顆，只取編號最前面的 ${small.mainbelt.count} 顆（略過根數不完整者 ${small.mainbelt.skipped} 顆）。`);
out(`- 海王星外天體：JPL SBDB 共 ${small.tno.totalInSbdb} 顆，收錄 ${small.tno.count} 顆（略過根數不完整或離心率 ≥ 0.995 者 ${small.tno.skipped} 顆）。`);
out("- 奧爾特雲：沒有觀測資料，粒子為程序化生成的示意。");
out();

out("## 恆星");
out();
out(`- 選取條件：${stars.selection}。共 ${stars.count} 顆。`);
out(`- 因 HYG 中距離不明而未收錄的肉眼可見恆星：${stars.excludedUnknownDistance} 顆。`);
out(`- 有專名但在 Wikidata 查無中文標籤、只顯示英文名的恆星（${stars.properNamesWithoutZh.length} 顆）：${stars.properNamesWithoutZh.join("、")}`);
out();

const textures = await readJson(join(APP_DATA, "textures.json"));
// 天體代號 → 中文名
const zhName = {};
for (const b of [...solar.planets, ...solar.dwarfPlanets]) zhName[b.id] = b.zh;
for (const sys of readdirSync(join(PUBLIC_DATA, "moons"))) {
  for (const m of (await readJson(join(PUBLIC_DATA, "moons", sys))).moons) zhName[m.id] = m.zh ?? m.en;
}
const zh = (id) => zhName[id] ?? id;
out("## 表面影像");
out();
out(`有真實表面影像的天體（${Object.keys(textures.bodies).length} 個）：${Object.keys(textures.bodies).map(zh).join("、")}。來源與處理方式見 \`app/data/textures.json\`。`);
out();
for (const m of textures.missing) out(`- **${zh(m.body)}**：${m.reason}`);
out("- 土衛一至土衛五、土衛八（Cassini 2014 彩色地圖）：官方說明為增強色，已將飽和度降為 40%，不是校正過的真彩色。");
out("- 太陽：以臨邊昏暗近似呈現，不是觀測影像。");
out("- 土星環：透明度與明暗由 Voyager 2 掩星的法向光學深度以單次散射近似計算；顏色與整體亮度是顯示用設定。沒有畫出行星與環互相投下的陰影。");
out("- 巨行星的雲帶與大氣特徵會隨時間漂移，Hubble OPAL 地圖只代表觀測當時的樣貌。");
out();

out("## 銀河系");
out();
out("旋臂、核球、銀暈皆為程序化生成的示意模型，參數為美術設定（見 `app/lib/galaxy.ts`），不是觀測資料。太陽到銀心的距離採用專案需求指定的約 2.6 萬光年；太陽相對銀河盤面的高度未取得資料，設為 0。");
out();

await writeFile(join(ROOT, "DATA_GAPS.md"), lines.join("\n"));
console.log(`寫入 DATA_GAPS.md（${lines.length} 行）`);
