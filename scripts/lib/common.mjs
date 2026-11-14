// 資料擷取腳本共用工具：下載、快取原始檔、記錄來源與擷取時間。
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const RAW_DIR = join(ROOT, "data/raw");
export const SOURCES_FILE = join(ROOT, "data/sources.json");
export const APP_DATA = join(ROOT, "app/data");
export const PUBLIC_DATA = join(ROOT, "public/data");

const USER_AGENT = "astro-viewer-data-script/1.0";
const FORCE = process.argv.includes("--force");

async function loadSources() {
  if (!existsSync(SOURCES_FILE)) return {};
  return JSON.parse(await readFile(SOURCES_FILE, "utf8"));
}

/**
 * 下載 url 並存到 data/raw/<name>；已存在則直接讀取（加 --force 重新下載）。
 * 每次實際下載都會把網址、時間、雜湊寫入 data/sources.json。
 */
export async function fetchCached(name, url, { binary = false, headers = {}, method = "GET", body } = {}) {
  const file = join(RAW_DIR, name);
  if (!FORCE && existsSync(file)) {
    return binary ? readFile(file) : readFile(file, "utf8");
  }
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { "User-Agent": USER_AGENT, ...headers },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, buf);
      const sources = await loadSources();
      sources[name] = {
        url,
        retrievedAt: new Date().toISOString(),
        bytes: buf.length,
        sha256: createHash("sha256").update(buf).digest("hex"),
      };
      await writeFile(SOURCES_FILE, JSON.stringify(sources, null, 2) + "\n");
      return binary ? buf : buf.toString("utf8");
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`下載失敗 ${url}: ${lastErr?.message}`);
}

export async function sourceInfo(name) {
  const sources = await loadSources();
  return sources[name] ?? null;
}

export async function writeJson(file, data, { pretty = true } = {}) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, pretty ? 2 : 0) + "\n");
  console.log(`寫入 ${file.replace(ROOT, ".")}`);
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/** 把 HTML 片段轉成純文字（保留換行）。 */
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&plusmn;|&pm;/g, "±")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ");
}

/** 解析數字；無法解析時回傳 null（絕不補值）。 */
export function num(s) {
  if (s == null) return null;
  const m = String(s).replace(/,/g, "").match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : null;
}

/** Wikidata SPARQL 查詢（結果快取到 data/raw）。 */
export async function sparql(cacheName, query) {
  const url = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(query);
  const text = await fetchCached(cacheName, url, { headers: { Accept: "application/sparql-results+json" } });
  return JSON.parse(text).results.bindings;
}

/**
 * 從 Wikidata 標籤挑出繁體中文名稱。
 * 只接受明確標示為繁體的語言代碼；只有 zh（未標示繁簡）時另外回報，由呼叫端決定。
 */
export function pickZh(labels) {
  for (const lang of ["zh-tw", "zh-hant", "zh-hk", "zh-mo"]) {
    if (labels[lang]) return { zh: labels[lang], zhLang: lang };
  }
  if (labels.zh) return { zh: labels.zh, zhLang: "zh" };
  return { zh: null, zhLang: null };
}
