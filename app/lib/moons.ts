// 衛星：資料按母行星分檔，需要時才下載（public/data/moons/<planet>.json）。
import moonIndex from "~/data/moon-index.json";
import { type OrbitModel, addBody, getBody, makeBody } from "./bodies";
import { DEG } from "./constants";
import { frameFromPole } from "./kepler";

/** 位置計算用的軌道（由 JPL Horizons 狀態向量擬合，見 scripts/lib/orbit-fit.mjs）。 */
export interface MoonOrbit {
  epochJd: number;
  a: number;
  e: number;
  i: number;
  node: number;
  argPeri: number;
  meanAnomaly: number;
  meanAnomalyRate: number;
  nodeRate: number;
  apsisRate: number;
  /** 進動參考面的極點（ICRF）；null 表示黃道面。 */
  poleRaDeg: number | null;
  poleDecDeg: number | null;
}

export interface MoonRecord {
  id: string;
  en: string;
  zh: string | null;
  jplElemName: string | null;
  naifId: number;
  iauNumber: string | null;
  provisional: string | null;
  discoveryYear: number | null;
  discoverer: string | null;
  orbit: MoonOrbit;
  /** JPL 衛星平均根數表的原始值。 */
  mean: {
    ephemeris: string;
    frame: string;
    epoch: string;
    a: number;
    e: number;
    i: number;
    periodDays: number;
    apsisPeriodYr: number | null;
    nodePeriodYr: number | null;
    tiltDeg: number | null;
  };
  gm: number | null;
  meanRadiusKm: number | null;
  radiusSource: string | null;
  radiiKm: number[] | null;
  densityGcm3: number | null;
}

export interface MoonFile {
  planet: string;
  source: string;
  retrievedAt: Record<string, string>;
  unnamedExcluded: number;
  moons: MoonRecord[];
}

export const moonSystems = moonIndex.systems as Record<string, { count: number; unnamedExcluded: number; extentKm: number }>;
export const moonNameIndex = moonIndex.moons as { id: string; en: string; zh: string | null; planet: string }[];

/** 平均近點角等速增加，升交點與近心點幅角在參考面內等速進動。 */
function moonModel(o: MoonOrbit): OrbitModel {
  return (jd, out) => {
    const dt = jd - o.epochJd;
    out.a = o.a;
    out.e = o.e;
    out.i = o.i * DEG;
    out.node = (o.node + o.nodeRate * dt) * DEG;
    out.argPeri = (o.argPeri + o.apsisRate * dt) * DEG;
    out.M = (o.meanAnomaly + o.meanAnomalyRate * dt) * DEG;
  };
}

const added = new Set<string>();

/** 把一個行星的衛星加入場景（重複呼叫無妨）。 */
export function addMoonSystem(planetId: string, file: MoonFile): void {
  if (added.has(planetId) || !getBody(planetId)) return;
  added.add(planetId);
  for (const m of file.moons) {
    const o = m.orbit;
    addBody(
      makeBody({
        id: m.id,
        zh: m.zh ?? m.en,
        en: m.en,
        kind: "moon",
        parentId: planetId,
        radiusKm: m.meanRadiusKm,
        orbit: moonModel(o),
        frame: o.poleRaDeg != null && o.poleDecDeg != null ? frameFromPole(o.poleRaDeg, o.poleDecDeg) : null,
        orbitSegments: 96,
        data: m,
        aliases: [m.provisional, m.jplElemName].filter((x): x is string => !!x),
      }),
    );
  }
}

const pending = new Map<string, Promise<void>>();

/** 按需下載並加入某行星的衛星。 */
export function loadMoonSystem(planetId: string, onState?: (s: "loading" | "ready" | "error") => void): Promise<void> {
  if (!moonSystems[planetId]) return Promise.resolve();
  const existing = pending.get(planetId);
  if (existing) return existing;
  onState?.("loading");
  const p = fetch(`${import.meta.env.BASE_URL}data/moons/${planetId}.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<MoonFile>;
    })
    .then((file) => {
      addMoonSystem(planetId, file);
      onState?.("ready");
    })
    .catch((err) => {
      console.error(`載入 ${planetId} 衛星資料失敗`, err);
      pending.delete(planetId);
      onState?.("error");
    });
  pending.set(planetId, p);
  return p;
}
