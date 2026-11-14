// 天體登錄表：所有可被選取、搜尋、飛往的對象，以及太陽系天體的位置更新。
// 位置一律是「日心 J2000 黃道座標，單位 km」的 float64。
import solarSystem from "~/data/solar-system.json";
import { AU_KM, DEG, J2000_JD } from "./constants";
import { type Elements, type Mat3, orbitBasis, solveKepler } from "./kepler";

export type EntityKind =
  | "sun"
  | "planet"
  | "dwarf"
  | "moon"
  | "region"
  | "hygstar"
  | "galactic";

export interface Entity {
  id: string;
  zh: string;
  en: string;
  kind: EntityKind;
  /** 日心黃道座標 (km)，每幀更新。 */
  pos: Float64Array;
  radiusKm: number | null;
  parentId: string | null;
  /** 飛往此對象時預設的相機距離 (log10 km)。 */
  viewLogDist: number;
  /** 可拉近的最小相機距離 (log10 km)。 */
  minLogDist: number;
  /** 飛往此對象時偏好的視角（弧度）；省略則維持目前視角。 */
  viewYaw?: number;
  viewPitch?: number;
  /** 搜尋用的別名。 */
  aliases?: string[];
  /** 原始資料紀錄（資訊面板使用）。 */
  data?: unknown;
}

export type OrbitModel = (jd: number, out: Elements) => void;

export interface Body extends Entity {
  kind: "sun" | "planet" | "dwarf" | "moon";
  subtype?: string;
  color: [number, number, number];
  orbit: OrbitModel | null;
  /** 根數參考平面 → 黃道 的矩陣；null 表示根數本身就是黃道座標。 */
  frame: Mat3 | null;
  /** 目前時刻的根數與軌道基底（供位置與軌道線共用）。 */
  el: Elements;
  P: Float64Array;
  Q: Float64Array;
  E: number;
  /** 軌道線取樣數。 */
  orbitSegments: number;
  children: Body[];
}

export const entities = new Map<string, Entity>();
/** 依「母天體在前」排序的太陽系天體。 */
export const bodies: Body[] = [];
const bodyById = new Map<string, Body>();

export function getBody(id: string): Body | undefined {
  return bodyById.get(id);
}
export function getEntity(id: string): Entity | undefined {
  return entities.get(id);
}
export function registerEntity(e: Entity): void {
  entities.set(e.id, e);
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// 顯示用顏色（美術設定，非資料）
const BODY_COLORS: Record<string, string> = {
  sun: "#fff4d6",
  mercury: "#9a8f86",
  venus: "#e6c88f",
  earth: "#4f8fe0",
  mars: "#cf6a41",
  jupiter: "#d9b48c",
  saturn: "#e6d19c",
  uranus: "#9fdbe3",
  neptune: "#4d74e8",
  ceres: "#a69f95",
  pluto: "#d2b79b",
  haumea: "#d9d9de",
  makemake: "#d9a98a",
  eris: "#e3e3e3",
  orcus: "#b5b5bd",
  quaoar: "#c49a7e",
  gonggong: "#c9806a",
  sedna: "#cf6f55",
};
export const MOON_COLOR = "#b4b2ad";

function newElements(): Elements {
  return { a: 0, e: 0, i: 0, node: 0, argPeri: 0, M: 0 };
}

export function makeBody(init: {
  id: string;
  zh: string;
  en: string;
  kind: Body["kind"];
  subtype?: string;
  parentId: string | null;
  radiusKm: number | null;
  color?: string;
  orbit: OrbitModel | null;
  frame?: Mat3 | null;
  orbitSegments?: number;
  data?: unknown;
  aliases?: string[];
}): Body {
  const r = init.radiusKm;
  const body: Body = {
    id: init.id,
    zh: init.zh,
    en: init.en,
    kind: init.kind,
    subtype: init.subtype,
    parentId: init.parentId,
    radiusKm: r,
    pos: new Float64Array(3),
    viewLogDist: r ? Math.log10(r * (init.kind === "sun" ? 9 : 6)) : init.kind === "moon" ? 3 : 4.5,
    minLogDist: r ? Math.log10(r * 1.25) : 1.5,
    color: hexToRgb(init.color ?? BODY_COLORS[init.id] ?? MOON_COLOR),
    orbit: init.orbit,
    frame: init.frame ?? null,
    el: newElements(),
    P: new Float64Array(3),
    Q: new Float64Array(3),
    E: 0,
    orbitSegments: init.orbitSegments ?? 256,
    children: [],
    data: init.data,
    aliases: init.aliases,
  };
  return body;
}

export function addBody(body: Body): void {
  if (bodyById.has(body.id)) return;
  bodies.push(body);
  bodyById.set(body.id, body);
  entities.set(body.id, body);
  if (body.parentId) bodyById.get(body.parentId)?.children.push(body);
}

// ---------- 軌道模型 ----------

type ElementRate = number[];
interface PlanetTable {
  a: ElementRate;
  e: ElementRate;
  I: ElementRate;
  L: ElementRate;
  peri: ElementRate;
  node: ElementRate;
  extra?: { b: number; c: number; s: number; f: number };
}

const [SHORT_FROM, SHORT_TO] = solarSystem.constants.elementsShortValidYears;
const [LONG_FROM, LONG_TO] = solarSystem.constants.elementsLongValidYears;

export function yearOfJd(jd: number): number {
  return 2000 + (jd - J2000_JD) / 365.25;
}

/** 目前時間是否超出 JPL 近似根數的適用範圍。 */
export function planetElementsOutOfRange(jd: number): boolean {
  const y = yearOfJd(jd);
  return y < LONG_FROM || y > LONG_TO;
}

/** JPL「Approximate Positions of the Planets」的根數加變率模型。 */
function planetModel(short: PlanetTable, long: PlanetTable): OrbitModel {
  return (jd, out) => {
    const T = (jd - J2000_JD) / 36525;
    const year = 2000 + T * 100;
    const t = year >= SHORT_FROM && year <= SHORT_TO ? short : long;
    const peri = t.peri[0] + t.peri[1] * T;
    const node = t.node[0] + t.node[1] * T;
    let M = t.L[0] + t.L[1] * T - peri;
    if (t.extra) {
      const x = t.extra;
      M += x.b * T * T + x.c * Math.cos(x.f * T * DEG) + x.s * Math.sin(x.f * T * DEG);
    }
    out.a = (t.a[0] + t.a[1] * T) * AU_KM;
    out.e = t.e[0] + t.e[1] * T;
    out.i = (t.I[0] + t.I[1] * T) * DEG;
    out.node = node * DEG;
    out.argPeri = (peri - node) * DEG;
    out.M = M * DEG;
  };
}

/** JPL SBDB 的固定克卜勒根數（單一曆元）。 */
function sbdbModel(el: {
  epochJd: number;
  a: number;
  e: number;
  i: number;
  node: number;
  argPeri: number;
  meanAnomaly: number;
  meanMotionDegPerDay: number;
}): OrbitModel {
  return (jd, out) => {
    out.a = el.a * AU_KM;
    out.e = el.e;
    out.i = el.i * DEG;
    out.node = el.node * DEG;
    out.argPeri = el.argPeri * DEG;
    out.M = (el.meanAnomaly + el.meanMotionDegPerDay * (jd - el.epochJd)) * DEG;
  };
}

// ---------- 建立太陽、行星、矮行星 ----------

const sunRec = solarSystem.sun;
addBody(
  makeBody({
    id: "sun",
    zh: sunRec.zh,
    en: sunRec.en,
    kind: "sun",
    parentId: null,
    radiusKm: sunRec.phys.meanRadiusKm,
    orbit: null,
    data: sunRec,
    aliases: ["Sol", "日"],
  }),
);

for (const p of solarSystem.planets) {
  addBody(
    makeBody({
      id: p.id,
      zh: p.zh,
      en: p.en,
      kind: "planet",
      subtype: p.subtype,
      parentId: "sun",
      radiusKm: p.phys.meanRadiusKm,
      orbit: planetModel(p.elements.short as PlanetTable, p.elements.long as PlanetTable),
      data: p,
    }),
  );
}

for (const d of solarSystem.dwarfPlanets) {
  addBody(
    makeBody({
      id: d.id,
      zh: d.zh,
      en: d.en,
      kind: "dwarf",
      subtype: d.status,
      parentId: "sun",
      radiusKm: d.phys.meanRadiusKm ?? null,
      orbit: sbdbModel(d.elements),
      data: d,
      aliases: [d.designation],
    }),
  );
}

// ---------- 位置更新 ----------

/** 更新所有太陽系天體在 jd 時刻的日心位置（母天體必須排在前面）。 */
export function updateBodies(jd: number): void {
  for (let k = 0; k < bodies.length; k++) {
    const b = bodies[k];
    if (!b.orbit) {
      b.pos[0] = b.pos[1] = b.pos[2] = 0;
      continue;
    }
    const el = b.el;
    b.orbit(jd, el);
    orbitBasis(el, b.frame, b.P, b.Q);
    const E = solveKepler(el.M, el.e);
    b.E = E;
    const x = el.a * (Math.cos(E) - el.e);
    const y = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
    const parent = b.parentId ? bodyById.get(b.parentId) : undefined;
    const px = parent ? parent.pos[0] : 0;
    const py = parent ? parent.pos[1] : 0;
    const pz = parent ? parent.pos[2] : 0;
    b.pos[0] = px + x * b.P[0] + y * b.Q[0];
    b.pos[1] = py + x * b.P[1] + y * b.Q[1];
    b.pos[2] = pz + x * b.P[2] + y * b.Q[2];
  }
}
