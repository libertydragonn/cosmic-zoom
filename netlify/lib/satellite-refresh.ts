// 近地衛星的軌道根數更新（Netlify 排程函式與資料函式共用）。
// 網站內建的資料只預測到擷取後約一兩個月；這裡向 JPL Horizons 取「內建資料結束前 5 日」
// 到 Horizons 目前最新預測為止的每日密切軌道根數，前端再接在內建資料後面。
// 取樣日與內建資料對齊（t0 + k 日），所以可以直接逐列覆蓋。

export interface SatSpec {
  id: string;
  horizonsId: string;
  /** 內建資料第一組根數的時刻（JD）、間隔（日）、組數。 */
  t0: number;
  stepDays: number;
  n: number;
}

export interface LiveSat {
  /** 這段資料第一組根數的時刻（JD，與內建資料對齊）。 */
  t0: number;
  n: number;
  /** Float32 的 a(km)、e、i、Ω、ω、M（弧度，ICRF 赤道面），每組 6 個，base64。 */
  el: string;
  /** 這顆衛星這次成功更新的時間（ISO）。 */
  fetchedAt: string;
}

export interface LiveData {
  updatedAt: string;
  source: string;
  sats: Record<string, LiveSat>;
  /** 這次更新失敗的衛星與原因（仍保留上一次成功的資料）。 */
  errors: Record<string, string>;
}

const API = "https://ssd.jpl.nasa.gov/api/horizons.api";
const DEG = Math.PI / 180;
const MON: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

const jdNow = () => Date.now() / 86400000 + 2440587.5;

function jdFromHorizonsDate(s: string): number | null {
  const m = /(\d{4})-([A-Z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(s);
  if (!m) return null;
  const ms = Date.UTC(+m[1], MON[m[2]], +m[3], +m[4], +m[5], 0) + Number(m[6]) * 1000;
  return ms / 86400000 + 2440587.5;
}

function url(cmd: string, start: number, stop: number): string {
  const q: Record<string, string> = {
    format: "text",
    COMMAND: `'${cmd}'`,
    OBJ_DATA: "'NO'",
    MAKE_EPHEM: "'YES'",
    EPHEM_TYPE: "'ELEMENTS'",
    CENTER: "'500@399'",
    REF_PLANE: "'FRAME'",
    REF_SYSTEM: "'ICRF'",
    OUT_UNITS: "'KM-S'",
    CSV_FORMAT: "'YES'",
    START_TIME: `'JD ${start.toFixed(6)}'`,
    STOP_TIME: `'JD ${stop.toFixed(6)}'`,
    STEP_SIZE: "'1d'",
  };
  return `${API}?${Object.entries(q)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&")}`;
}

interface Row {
  t: number;
  a: number;
  e: number;
  i: number;
  O: number;
  w: number;
  M: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchRows(cmd: string, start: number, stop: number): Promise<{ rows: Row[] } | { after: number } | { error: string }> {
  // Horizons 同時收到太多請求時回 503／429：稍等後重試
  let res: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(url(cmd, start, stop), { signal: AbortSignal.timeout(12000) });
    if (res.status !== 503 && res.status !== 429) break;
    await sleep(1200 * (attempt + 1));
  }
  if (!res || !res.ok) return { error: `HTTP ${res?.status}` };
  const text = await res.text();
  const body = text.split("$$SOE")[1]?.split("$$EOE")[0];
  if (!body) {
    // 要求的結束時間超過 Horizons 的預測範圍
    const after = /after A\.D\. (\S+ \S+)/.exec(text);
    const jd = after ? jdFromHorizonsDate(after[1]) : null;
    if (jd != null) return { after: jd };
    return { error: text.trim().split("\n").slice(-3).join(" ").slice(0, 300) };
  }
  const rows: Row[] = [];
  for (const line of body.trim().split(/\r?\n/)) {
    // 欄位：JDTDB, 日期, EC, QR, IN, OM, W, Tp, N, MA, TA, A, AD, PR
    const v = line.split(",").map((s) => s.trim());
    rows.push({ t: +v[0], e: +v[2], i: +v[4] * DEG, O: +v[5] * DEG, w: +v[6] * DEG, M: +v[9] * DEG, a: +v[11] });
  }
  return { rows };
}

async function refreshOne(s: SatSpec): Promise<LiveSat> {
  // 從內建資料結束前 5 日開始，與內建取樣日對齊
  const k0 = Math.max(0, s.n - 6);
  const start = s.t0 + k0 * s.stepDays;
  // 要求到「現在或內建資料結束，取較晚者」之後 125 日，Horizons 會告知實際預測到哪天
  let stop = Math.max(jdNow(), start) + 125;
  let r = await fetchRows(s.horizonsId, start, stop);
  if ("after" in r) {
    stop = r.after - 1 / 1440;
    if (stop <= start) throw new Error("Horizons 沒有比內建資料更新的預測");
    r = await fetchRows(s.horizonsId, start, stop);
  }
  if ("error" in r) throw new Error(r.error);
  if ("after" in r) throw new Error("Horizons 預測範圍判斷失敗");
  const rows = r.rows;
  if (!rows.length) throw new Error("Horizons 沒有傳回資料");
  // 必須與內建資料對齊、且等間隔
  for (let k = 0; k < rows.length; k++) {
    const expected = s.t0 + (k0 + k) * s.stepDays;
    if (Math.abs(rows[k].t - expected) > 1e-5) throw new Error(`第 ${k} 筆時刻 ${rows[k].t} 與預期 ${expected} 不符`);
    if (![rows[k].a, rows[k].e, rows[k].i, rows[k].O, rows[k].w, rows[k].M].every(Number.isFinite)) throw new Error(`第 ${k} 筆有無效數值`);
  }
  const el = new Float32Array(rows.length * 6);
  rows.forEach((x, k) => el.set([x.a, x.e, x.i, x.O, x.w, x.M], k * 6));
  return {
    t0: rows[0].t,
    n: rows.length,
    el: Buffer.from(el.buffer).toString("base64"),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 更新全部衛星。Horizons 不接受太多同時請求，所以一次只查 2 顆（全部約 10 秒）。
 * 失敗的衛星保留 prev 裡上一次成功的資料，並把原因記在 errors。
 */
export async function refreshSatellites(sats: SatSpec[], prev?: LiveData | null): Promise<LiveData> {
  const out: LiveData = {
    updatedAt: new Date().toISOString(),
    source: "JPL Horizons 每日密切軌道根數（地心、ICRF 赤道面）",
    sats: {},
    errors: {},
  };
  const queue = [...sats];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      try {
        out.sats[s.id] = await refreshOne(s);
      } catch (err) {
        out.errors[s.id] = err instanceof Error ? err.message : String(err);
        const old = prev?.sats?.[s.id];
        if (old) out.sats[s.id] = old;
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return out;
}

/** 從網站的探測器索引取出需要更新的地球衛星。 */
export function satSpecs(index: { craft: { id: string; horizonsId: string; elements?: { t0: number; stepDays: number; n: number } }[] }): SatSpec[] {
  return index.craft
    .filter((c) => c.elements)
    .map((c) => ({ id: c.id, horizonsId: c.horizonsId, t0: c.elements!.t0, stepDays: c.elements!.stepDays, n: c.elements!.n }));
}
