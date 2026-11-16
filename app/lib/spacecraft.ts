// 人造探測器：索引隨程式打包（搜尋、導覽可用），軌跡按需下載。
// 軌跡來自 JPL Horizons，分成數段：日心段直接是日心座標；行星段是「相對該行星」的座標，
// 顯示時加上本專案的行星位置，所以飛掠與環繞軌道會和畫面上的行星對齊。
// 樣本之間以三次 Hermite 內插（位置＋速度）。
// 地球衛星（group = "earth"）改存每日一組的密切軌道根數（ICRF 赤道面），顯示時內插再轉到黃道座標；
// 只有在相機靠近地球或選取這些衛星時才下載。
import craftIndex from "~/data/spacecraft.json";
import solarSystem from "~/data/solar-system.json";
import { type Entity, getBody, heliocentricAt, onBodiesUpdated, registerEntity } from "./bodies";
import { OBLIQUITY } from "./constants";
import { solveKepler } from "./kepler";

interface SegmentMeta {
  center: string;
  t0: number;
  t1: number;
  n: number;
  tOff: number;
  pvOff: number;
}

export type CraftGroup = "deep" | "earth";
export const CRAFT_GROUPS: { id: CraftGroup; zh: string; en: string }[] = [
  { id: "deep", zh: "深空探測", en: "Deep Space" },
  { id: "earth", zh: "環繞地球", en: "Earth Orbit" },
];

export interface CraftRecord {
  id: string;
  /** deep＝深空探測（位置取樣）；earth＝環繞地球（軌道根數）。 */
  group: CraftGroup;
  horizonsId: string;
  horizonsName: string;
  spkSource: string | null;
  /** NASA Eyes 沒有這個探測器時為 null。 */
  eyesId: string | null;
  en: string;
  zh: string | null;
  zhLang: string | null;
  aliases: string[];
  wikidata: string | null;
  launchDate: string | null;
  /** 發射日期未採用時的說明。 */
  launchNote: string | null;
  operators: string[];
  cospar: string | null;
  description: string | null;
  coverage: { start: number; end: number; startIso: string; endIso: string };
  file: string;
  bytes: number;
  segments: SegmentMeta[];
  /** 地球衛星：自 t0 起每 stepDays 日一組，每組 a(km)、e、i、Ω、ω、M（弧度，ICRF 赤道面）。 */
  elements?: { t0: number; stepDays: number; n: number; center: string };
  /** 地球衛星：最近一次由 Netlify 排程自動更新的時間（ISO）；沒有時為 null／undefined。 */
  liveUpdatedAt?: string | null;
}

interface Segment {
  center: string;
  t: Float64Array;
  /** 每點 6 個值：位置 km、速度 km/s（相對 center）。 */
  pv: Float32Array;
  t0: number;
  t1: number;
}

/** 環繞行星超過這麼多天的段落視為「環繞期」，只在當下畫出最近一段，不畫進日心軌跡。 */
export const LONG_SEGMENT_DAYS = 400;

export interface Craft extends Entity {
  kind: "spacecraft";
  rec: CraftRecord;
  segs: Segment[] | null;
  /** 目前時間是否在星曆範圍內。 */
  active: boolean;
  segIndex: number;
  /** 目前所在段的中心天體（"sun" 或行星 id）。 */
  centerId: string;
  /** 相對中心天體的速度（km/s）。 */
  vel: Float64Array;
  color: [number, number, number];
  /** 日心軌跡（含短暫的飛掠段，換算到當時行星位置）；NaN 表示斷開。 */
  trail: { pts: Float64Array; t: Float64Array } | null;
  /** 地球衛星的軌道根數（下載後）。 */
  orb: Float32Array | null;
  /** 地球衛星目前的密切軌道（黃道座標的 P、Q 方向），用來畫軌道線。 */
  osc: { a: number; e: number; E: number; P: Float64Array; Q: Float64Array } | null;
}

/** 軌跡或軌道根數是否已下載。 */
export const craftLoaded = (c: Craft) => !!(c.segs || c.orb);

// 顯示用顏色
const PALETTE: [number, number, number][] = [
  [1.0, 0.78, 0.42],
  [0.55, 0.85, 1.0],
  [0.95, 0.6, 0.55],
  [0.7, 0.95, 0.6],
  [0.88, 0.72, 1.0],
  [1.0, 0.92, 0.55],
  [0.6, 0.9, 0.85],
];

export const craftIndexMeta = craftIndex as unknown as { retrieved: string; source: string; segmentRule: string };
export const crafts: Craft[] = [];
for (const [i, r] of (craftIndex.craft as unknown as CraftRecord[]).entries()) {
  const c: Craft = {
    id: r.id,
    zh: r.zh ?? r.en,
    en: r.en,
    kind: "spacecraft",
    pos: new Float64Array(3),
    radiusKm: null,
    parentId: null,
    viewLogDist: r.group === "earth" ? 4.4 : 7.2,
    minLogDist: 0.5,
    aliases: r.aliases,
    data: r,
    rec: r,
    segs: null,
    active: false,
    segIndex: 0,
    centerId: "sun",
    vel: new Float64Array(3),
    color: PALETTE[i % PALETTE.length],
    trail: null,
    orb: null,
    osc: null,
  };
  crafts.push(c);
  registerEntity(c);
}
const craftById = new Map(crafts.map((c) => [c.id, c]));
export const getCraft = (id: string) => craftById.get(id);

// ---------- 內插 ----------

/** 在段內以 Hermite 內插；out = [x, y, z, vx, vy, vz]（km、km/s）。t 會限制在段的範圍內。 */
export function evalSegment(seg: Segment, jd: number, out: Float64Array | number[]): void {
  const { t, pv } = seg;
  const n = t.length;
  if (n === 1 || jd <= t[0]) {
    for (let k = 0; k < 6; k++) out[k] = pv[k];
    return;
  }
  if (jd >= t[n - 1]) {
    for (let k = 0; k < 6; k++) out[k] = pv[(n - 1) * 6 + k];
    return;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= jd) lo = mid;
    else hi = mid;
  }
  const h = t[hi] - t[lo];
  const s = (jd - t[lo]) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  const d00 = 6 * s2 - 6 * s;
  const d10 = 3 * s2 - 4 * s + 1;
  const d01 = -6 * s2 + 6 * s;
  const d11 = 3 * s2 - 2 * s;
  const hs = h * 86400;
  const a = lo * 6;
  const b = hi * 6;
  for (let k = 0; k < 3; k++) {
    const p0 = pv[a + k], v0 = pv[a + 3 + k], p1 = pv[b + k], v1 = pv[b + 3 + k];
    out[k] = h00 * p0 + h10 * hs * v0 + h01 * p1 + h11 * hs * v1;
    out[3 + k] = (d00 * p0 + d10 * hs * v0 + d01 * p1 + d11 * hs * v1) / hs;
  }
}

/** 找出 jd 所在的段（超出範圍時取最近的一段）。 */
export function segmentAt(c: Craft, jd: number): number {
  const segs = c.segs!;
  let i = c.segIndex;
  if (segs[i] && jd >= segs[i].t0 && jd <= segs[i].t1) return i;
  for (i = 0; i < segs.length; i++) if (jd <= segs[i].t1) return i;
  return segs.length - 1;
}

const tmp = new Float64Array(6);
const centerTmp = new Float64Array(3);

// ---------- 地球衛星（軌道根數） ----------

const earthRec = solarSystem.planets.find((p) => p.id === "earth")!;
/** 地球 GM（km³/s²），取自 JPL。 */
const GM_EARTH = earthRec.gm as number;
const COS_E = Math.cos(OBLIQUITY);
const SIN_E = Math.sin(OBLIQUITY);
const TWO_PI = Math.PI * 2;
const wrapPi = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));

/** 赤道座標 → 黃道座標（就地轉換）。 */
function eqToEcl(v: Float64Array): void {
  const y = v[1];
  const z = v[2];
  v[1] = y * COS_E + z * SIN_E;
  v[2] = -y * SIN_E + z * COS_E;
}

/**
 * 在相鄰兩組密切根數之間內插。近圓軌道的 ω 與 M 個別不穩定，所以內插的是
 * 「平近點緯度」L = ω + M（以平均運動判斷相差幾圈）與 ω，再相減得到 M。
 * 結果寫入 pos、vel（相對地球、黃道座標，km 與 km/s），並更新 c.osc（畫軌道線用）。
 */
export function computeOrbiter(
  c: Pick<Craft, "rec" | "orb" | "osc">,
  t: number,
  pos: Float64Array | number[],
  vel: Float64Array | number[],
): void {
  const { t0, stepDays, n } = c.rec.elements!;
  const el = c.orb!;
  const x = Math.min(n - 1, Math.max(0, (t - t0) / stepDays));
  const k = Math.min(n - 2, Math.floor(x));
  const f = x - k;
  const A = k * 6;
  const B = (k + 1) * 6;
  const a = el[A] + (el[B] - el[A]) * f;
  const e = el[A + 1] + (el[B + 1] - el[A + 1]) * f;
  const inc = el[A + 2] + (el[B + 2] - el[A + 2]) * f;
  const O = el[A + 3] + wrapPi(el[B + 3] - el[A + 3]) * f;
  const w = el[A + 4] + wrapPi(el[B + 4] - el[A + 4]) * f;
  const LA = el[A + 4] + el[A + 5];
  const LB = el[B + 4] + el[B + 5];
  const nA = Math.sqrt(GM_EARTH / (el[A] * el[A] * el[A])) * 86400;
  const nB = Math.sqrt(GM_EARTH / (el[B] * el[B] * el[B])) * 86400;
  const expected = ((nA + nB) / 2) * stepDays;
  const raw = LB - LA;
  const dL = raw + TWO_PI * Math.round((expected - raw) / TWO_PI);
  const M = LA + dL * f - w;

  const E = solveKepler(M, e);
  const cO = Math.cos(O), sO = Math.sin(O), cw = Math.cos(w), sw = Math.sin(w), ci = Math.cos(inc), si = Math.sin(inc);
  let osc = c.osc;
  if (!osc) osc = c.osc = { a, e, E, P: new Float64Array(3), Q: new Float64Array(3) };
  const P = osc.P;
  const Q = osc.Q;
  P[0] = cO * cw - sO * sw * ci;
  P[1] = sO * cw + cO * sw * ci;
  P[2] = sw * si;
  Q[0] = -cO * sw - sO * cw * ci;
  Q[1] = -sO * sw + cO * cw * ci;
  Q[2] = cw * si;
  eqToEcl(P);
  eqToEcl(Q);
  osc.a = a;
  osc.e = e;
  osc.E = E;
  const b = a * Math.sqrt(1 - e * e);
  const px = a * (Math.cos(E) - e);
  const py = b * Math.sin(E);
  // 速度：dE/dt = n / (1 − e cos E)
  const nRad = Math.sqrt(GM_EARTH / (a * a * a));
  const Edot = nRad / (1 - e * Math.cos(E));
  const vx = -a * Math.sin(E) * Edot;
  const vy = b * Math.cos(E) * Edot;
  for (let j = 0; j < 3; j++) {
    pos[j] = px * P[j] + py * Q[j];
    vel[j] = vx * P[j] + vy * Q[j];
  }
}

/** 地球衛星目前軌道上偏心近點角為 E 的點（相對地球，黃道座標）。 */
export function orbiterPoint(c: Craft, E: number, out: Float64Array | number[]): void {
  const o = c.osc!;
  const x = o.a * (Math.cos(E) - o.e);
  const y = o.a * Math.sqrt(1 - o.e * o.e) * Math.sin(E);
  for (let j = 0; j < 3; j++) out[j] = x * o.P[j] + y * o.Q[j];
}

/** 更新所有已載入探測器在 jd 的位置（天體位置更新後呼叫）。 */
export function updateSpacecraft(jd: number): void {
  for (let k = 0; k < crafts.length; k++) {
    const c = crafts[k];
    if (c.orb) {
      const cov = c.rec.coverage;
      c.active = jd >= cov.start && jd <= cov.end;
      computeOrbiter(c, Math.min(cov.end, Math.max(cov.start, jd)), c.pos, c.vel);
      const earth = getBody("earth")!.pos;
      c.pos[0] += earth[0];
      c.pos[1] += earth[1];
      c.pos[2] += earth[2];
      c.centerId = "earth";
      continue;
    }
    if (!c.segs) continue;
    const cov = c.rec.coverage;
    c.active = jd >= cov.start && jd <= cov.end;
    // 星曆範圍外：停在最近的端點（仍可作為相機目標，但畫面上不顯示）
    const t = Math.min(cov.end, Math.max(cov.start, jd));
    const i = segmentAt(c, t);
    c.segIndex = i;
    const seg = c.segs[i];
    evalSegment(seg, t, tmp);
    c.centerId = seg.center;
    if (seg.center === "sun") {
      c.pos[0] = tmp[0];
      c.pos[1] = tmp[1];
      c.pos[2] = tmp[2];
    } else {
      const p = getBody(seg.center)!.pos;
      c.pos[0] = p[0] + tmp[0];
      c.pos[1] = p[1] + tmp[1];
      c.pos[2] = p[2] + tmp[2];
    }
    c.vel[0] = tmp[3];
    c.vel[1] = tmp[4];
    c.vel[2] = tmp[5];
  }
}
onBodiesUpdated(updateSpacecraft);

// ---------- 軌跡線 ----------

/** 每個取樣間隔再細分的點數（以 Hermite 曲線繪製，不用直線連接取樣點）。 */
export const SUBDIV = 6;

/** 建立日心軌跡：日心段原樣，短暫的行星段換算到當時的行星位置；長的環繞期略過（斷開）。 */
function buildTrail(c: Craft): void {
  const pts: number[] = [];
  const ts: number[] = [];
  const out = [0, 0, 0, 0, 0, 0];
  for (const seg of c.segs!) {
    const long = seg.center !== "sun" && seg.t1 - seg.t0 > LONG_SEGMENT_DAYS;
    if (long) {
      pts.push(NaN, NaN, NaN);
      ts.push(NaN);
      continue;
    }
    for (let k = 0; k < seg.t.length; k++) {
      const last = k === seg.t.length - 1;
      const steps = last ? 1 : SUBDIV;
      for (let j = 0; j < steps; j++) {
        const tt = last ? seg.t[k] : seg.t[k] + ((seg.t[k + 1] - seg.t[k]) * j) / SUBDIV;
        evalSegment(seg, tt, out);
        if (seg.center !== "sun" && heliocentricAt(seg.center, tt, centerTmp)) {
          out[0] += centerTmp[0];
          out[1] += centerTmp[1];
          out[2] += centerTmp[2];
        }
        pts.push(out[0], out[1], out[2]);
        ts.push(tt);
      }
    }
  }
  c.trail = { pts: Float64Array.from(pts), t: Float64Array.from(ts) };
}

// ---------- 載入 ----------

const loading: Partial<Record<CraftGroup, Promise<void>>> = {};

/** 自動更新的近地衛星資料最近一次更新時間（ISO）；沒有取得時為 null。 */
export let liveElementsUpdatedAt: string | null = null;

function base64ToFloat32(s: string): Float32Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  return new Float32Array(bytes.buffer);
}

/**
 * 取得 Netlify 排程函式每日向 Horizons 更新的近地衛星根數，接在內建資料後面（逐日對齊、覆蓋重疊部分），
 * 並延長星曆範圍。取不到（本機開發、函式或 Horizons 暫時失敗）時沿用內建資料，不影響顯示。
 */
async function mergeLiveElements(base: string): Promise<void> {
  try {
    const res = await fetch(`${base}.netlify/functions/satellites`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) return;
    const live = (await res.json()) as { updatedAt?: string; sats?: Record<string, { t0: number; n: number; el: string; fetchedAt?: string }> };
    for (const c of crafts) {
      const l = live.sats?.[c.id];
      const meta = c.rec.elements;
      if (!l || !meta || !c.orb) continue;
      const k0 = Math.round((l.t0 - meta.t0) / meta.stepDays);
      // 必須與內建資料的取樣日對齊，且中間不能有空缺
      if (k0 < 0 || k0 > meta.n || Math.abs(l.t0 - (meta.t0 + k0 * meta.stepDays)) > 1e-5) continue;
      const add = base64ToFloat32(l.el);
      if (add.length !== l.n * 6) continue;
      const n = Math.max(meta.n, k0 + l.n);
      const merged = new Float32Array(n * 6);
      merged.set(c.orb.subarray(0, Math.min(meta.n, k0) * 6));
      merged.set(add, k0 * 6);
      c.orb = merged;
      meta.n = n;
      const end = meta.t0 + (n - 1) * meta.stepDays;
      c.rec.coverage.end = end;
      c.rec.coverage.endIso = new Date((end - 2440587.5) * 86400000).toISOString();
      c.rec.liveUpdatedAt = l.fetchedAt ?? live.updatedAt ?? null;
    }
    liveElementsUpdatedAt = live.updatedAt ?? null;
  } catch {
    // 沿用內建資料
  }
}
export function groupLoaded(group: CraftGroup): boolean {
  return crafts.every((c) => c.rec.group !== group || craftLoaded(c));
}

/** 下載一組探測器的資料：deep（深空，頁面載入後即下載）或 earth（地球衛星，靠近地球時才下載）。 */
export function loadSpacecraft(group: CraftGroup, onState?: (s: "loading" | "ready" | "error") => void): Promise<void> {
  const existing = loading[group];
  if (existing) return existing;
  onState?.("loading");
  const base = import.meta.env.BASE_URL ?? "/";
  const p = Promise.all(
    crafts
      .filter((c) => c.rec.group === group)
      .map(async (c) => {
        const res = await fetch(base + c.rec.file);
        if (!res.ok) throw new Error(`${c.rec.file}: HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (c.rec.elements) {
          c.orb = new Float32Array(buf, 0, c.rec.elements.n * 6);
          return;
        }
        c.segs = c.rec.segments.map((s) => ({
          center: s.center,
          t: new Float64Array(buf, s.tOff, s.n),
          pv: new Float32Array(buf, s.pvOff, s.n * 6),
          t0: s.t0,
          t1: s.t1,
        }));
        buildTrail(c);
      }),
  )
    .then(() => (group === "earth" ? mergeLiveElements(base) : undefined))
    .then(
    () => onState?.("ready"),
    (err) => {
      delete loading[group];
      onState?.("error");
      throw err;
    },
  );
  loading[group] = p;
  return p;
}

/** NASA Eyes on the Solar System 的探測器頁面（帶入目前模擬時間）。呼叫前先確認 eyesId 不為 null。 */
export function eyesUrl(c: Craft, jd: number): string {
  const iso = new Date((jd - 2440587.5) * 86400000).toISOString();
  // ISO 時間只含數字與 -:.TZ，可直接放在網址的 # 之後（Eyes 用 YYYY-MM-DDTHH:mm:ss.SSSZ）
  return `https://eyes.nasa.gov/apps/solar-system/#/${c.rec.eyesId}?time=${iso}`;
}
