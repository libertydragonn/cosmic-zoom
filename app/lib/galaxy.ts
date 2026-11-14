// 銀河系：座標系定義、程序化粒子生成，以及銀河尺度的可選取對象。
//
// 注意：銀河系的粒子是「示意模型」，不是觀測資料。旋臂數量、螺距角、核球與銀暈的
// 尺寸都是為了呈現大致結構而設定的美術參數（列在下方），不可當作量測值引用。
import { type Entity, registerEntity } from "./bodies";
import { DEG, KLY_KM, LY_KM } from "./constants";
import { equatorialToEcliptic } from "./kepler";

/** 太陽到銀河系中心的距離（千光年）。依專案需求採用約 2.6 萬光年。 */
export const SUN_GALACTIC_RADIUS_KLY = 26;

// IAU 銀河座標系定義（J2000 赤道座標）：北銀極與銀心方向。
// 出處：ESA (1997) The Hipparcos and Tycho Catalogues, Vol. 1, §1.5.3。
const NGP_RA = 192.85948;
const NGP_DEC = 27.12825;
const GC_RA = 266.40499;
const GC_DEC = -28.93617;

function unitEcliptic(raDeg: number, decDeg: number): number[] {
  const a = raDeg * DEG;
  const d = decDeg * DEG;
  const out = [0, 0, 0];
  equatorialToEcliptic(Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d), out);
  return out;
}

const gz = unitEcliptic(NGP_RA, NGP_DEC);
const gxRaw = unitEcliptic(GC_RA, GC_DEC);
// 對北銀極方向做一次正交化，消除常數捨入造成的微小偏差
const dotXZ = gxRaw[0] * gz[0] + gxRaw[1] * gz[1] + gxRaw[2] * gz[2];
const gxU = gxRaw.map((v, i) => v - dotXZ * gz[i]);
const gxL = Math.hypot(gxU[0], gxU[1], gxU[2]);
const gx = gxU.map((v) => v / gxL);
const gy = [gz[1] * gx[2] - gz[2] * gx[1], gz[2] * gx[0] - gz[0] * gx[2], gz[0] * gx[1] - gz[1] * gx[0]];

/**
 * 銀河座標基底（以 J2000 黃道座標表示）：
 * x 指向銀心（l=0°）、y 指向銀河自轉方向（l=90°）、z 指向北銀極。
 */
export const GALACTIC_BASIS = { x: gx, y: gy, z: gz };

/** 銀心座標系（原點在銀心，千光年）→ 日心黃道座標（km）。太陽位於 (−R0, 0, 0)。 */
export function galacticToHelioKm(X: number, Y: number, Z: number, out = new Float64Array(3)): Float64Array {
  const hx = X + SUN_GALACTIC_RADIUS_KLY;
  for (let k = 0; k < 3; k++) out[k] = (hx * gx[k] + Y * gy[k] + Z * gz[k]) * KLY_KM;
  return out;
}

/** 銀河系中心的日心位置（km）。 */
export const GALACTIC_CENTER_KM = galacticToHelioKm(0, 0, 0);

// ---------- 示意模型參數（美術設定） ----------
export const GALAXY_MODEL = {
  discRadiusKly: 52,
  discScaleLengthKly: 11,
  discScaleHeightKly: 0.5,
  armCount: 4,
  armPitchDeg: 12.5,
  armStartRadiusKly: 9,
  barHalfLengthKly: 9,
  barAngleDeg: 25,
  bulgeSigmaKly: [3.2, 2.2, 1.8],
  haloRadiusKly: 110,
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GalaxyParticles {
  position: Float32Array; // 銀心座標，千光年
  color: Float32Array;
  size: Float32Array; // 千光年
}

/** 生成銀河系粒子：旋臂、盤面、棒狀核球、銀暈。 */
export function generateGalaxy(count: number): GalaxyParticles {
  const rand = rng(8675309);
  const gauss = () => {
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const M = GALAXY_MODEL;
  const position = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const k = Math.tan(M.armPitchDeg * DEG);
  const barAngle = Math.PI - M.barAngleDeg * DEG; // 棒的近端朝向太陽一側、偏向正銀經
  let n = 0;
  const put = (x: number, y: number, z: number, r: number, g: number, b: number, s: number) => {
    position[n * 3] = x;
    position[n * 3 + 1] = y;
    position[n * 3 + 2] = z;
    color[n * 3] = r;
    color[n * 3 + 1] = g;
    color[n * 3 + 2] = b;
    size[n] = s;
    n++;
  };

  const nArm = Math.floor(count * 0.5);
  const nDisc = Math.floor(count * 0.22);
  const nBulge = Math.floor(count * 0.2);
  const nHalo = count - nArm - nDisc - nBulge;

  // 旋臂：對數螺線 r = r0·exp(k·θ)，四條臂等角分佈，寬度隨半徑增加
  const thetaMax = Math.log(M.discRadiusKly / M.armStartRadiusKly) / k;
  for (let i = 0; i < nArm; i++) {
    const arm = Math.floor(rand() * M.armCount);
    // 靠內側密度較高
    const t = Math.pow(rand(), 1.35) * thetaMax;
    const r0 = M.armStartRadiusKly * Math.exp(k * t);
    const theta = barAngle + (arm * 2 * Math.PI) / M.armCount + t;
    const width = 0.7 + r0 * 0.045;
    const r = r0 + gauss() * width;
    const th = theta + (gauss() * width * 0.35) / r0;
    const z = gauss() * M.discScaleHeightKly * 0.55;
    const young = rand();
    if (young < 0.07) put(r * Math.cos(th), r * Math.sin(th), z, 1.0, 0.55, 0.7, 0.32); // 恆星形成區（粉紅）
    else if (young < 0.6) put(r * Math.cos(th), r * Math.sin(th), z, 0.62, 0.75, 1.0, 0.26); // 年輕藍白星
    else put(r * Math.cos(th), r * Math.sin(th), z, 0.9, 0.9, 1.0, 0.22);
  }

  // 盤面：指數衰減的瀰漫恆星
  for (let i = 0; i < nDisc; i++) {
    let r = 0;
    do {
      r = -Math.log(1 - rand()) * M.discScaleLengthKly;
    } while (r > M.discRadiusKly);
    const th = rand() * 2 * Math.PI;
    const z = gauss() * M.discScaleHeightKly;
    put(r * Math.cos(th), r * Math.sin(th), z, 1.0, 0.9, 0.74, 0.22);
  }

  // 棒狀核球：沿棒軸拉長的高斯分佈，偏黃橘色的年老恆星
  const cb = Math.cos(barAngle);
  const sb = Math.sin(barAngle);
  for (let i = 0; i < nBulge; i++) {
    const inBar = rand() < 0.45;
    const a = gauss() * (inBar ? M.barHalfLengthKly * 0.5 : M.bulgeSigmaKly[0]);
    const b = gauss() * (inBar ? 1.3 : M.bulgeSigmaKly[1]);
    const z = gauss() * (inBar ? 0.8 : M.bulgeSigmaKly[2]);
    put(a * cb - b * sb, a * sb + b * cb, z, 1.0, 0.82, 0.52, 0.24);
  }

  // 銀暈：稀疏的球狀分佈，密度向外快速下降
  for (let i = 0; i < nHalo; i++) {
    const r = 6 * Math.pow(M.haloRadiusKly / 6, Math.pow(rand(), 1.6));
    const zc = rand() * 2 - 1;
    const ph = rand() * 2 * Math.PI;
    const s = Math.sqrt(1 - zc * zc);
    put(r * s * Math.cos(ph), r * s * Math.sin(ph), r * zc * 0.85, 1.0, 0.72, 0.5, 0.3);
  }
  return { position, color, size };
}

// 俯瞰銀河盤面的視角：從北銀極方向往太陽一側傾斜約 35°
const tilt = 35 * DEG;
const viewDir = [0, 1, 2].map((k) => gz[k] * Math.cos(tilt) - gx[k] * Math.sin(tilt));
const OVERVIEW_YAW = Math.atan2(viewDir[1], viewDir[0]);
const OVERVIEW_PITCH = Math.asin(viewDir[2]);

// ---------- 銀河尺度的對象 ----------
export interface GalacticEntity extends Entity {
  kind: "galactic";
  description: string;
  /** 標籤在相機距離介於此範圍（log10 km）時顯示。 */
  labelRange: [number, number];
}

function galactic(init: {
  id: string;
  zh: string;
  en: string;
  at: [number, number, number];
  viewKly: number;
  labelRange: [number, number];
  description: string;
  overview?: boolean;
}): GalacticEntity {
  const e: GalacticEntity = {
    id: init.id,
    zh: init.zh,
    en: init.en,
    kind: "galactic",
    pos: galacticToHelioKm(...init.at),
    radiusKm: null,
    parentId: null,
    viewLogDist: Math.log10(init.viewKly * KLY_KM),
    minLogDist: Math.log10(50 * LY_KM),
    description: init.description,
    labelRange: init.labelRange,
  };
  if (init.overview) {
    e.viewYaw = OVERVIEW_YAW;
    e.viewPitch = OVERVIEW_PITCH;
  }
  registerEntity(e);
  return e;
}

const MODEL_NOTE = "銀河系的粒子為程序化生成的示意模型，僅呈現大致結構，不是逐顆恆星的觀測資料。";

export const galacticEntities: GalacticEntity[] = [
  galactic({
    id: "milky-way",
    zh: "銀河系",
    en: "Milky Way",
    at: [0, 0, 0],
    viewKly: 170,
    overview: true,
    labelRange: [17.6, 99],
    description: `我們所在的棒旋星系。太陽位於盤面上，距銀河系中心約 2.6 萬光年。${MODEL_NOTE}`,
  }),
  galactic({
    id: "galactic-center",
    zh: "銀河系中心",
    en: "Galactic Center",
    at: [0, 0, 0],
    viewKly: 30,
    labelRange: [15.2, 17.6],
    description: `銀河系的中心，位於人馬座方向。周圍是由年老恆星組成的棒狀核球。${MODEL_NOTE}`,
  }),
  galactic({
    id: "galactic-bulge",
    zh: "核球",
    en: "Bulge",
    at: [-2.5, -5.5, 0],
    viewKly: 45,
    labelRange: [16.6, 17.7],
    description: `銀河系中央恆星密集的區域，呈棒狀，以年老、偏黃的恆星為主。${MODEL_NOTE}`,
  }),
  galactic({
    id: "spiral-arms",
    zh: "旋臂",
    en: "Spiral Arms",
    at: [22, 27, 0],
    viewKly: 130,
    overview: true,
    labelRange: [16.8, 18.0],
    description: `從核球向外延伸的螺旋狀結構，聚集了年輕的藍色恆星與恆星形成區。${MODEL_NOTE}`,
  }),
  galactic({
    id: "galactic-halo",
    zh: "銀暈",
    en: "Halo",
    at: [-8, 20, 48],
    viewKly: 200,
    overview: true,
    labelRange: [17.4, 99],
    description: `包圍銀河盤面的稀疏球狀區域，散佈著年老恆星與球狀星團。${MODEL_NOTE}`,
  }),
];
