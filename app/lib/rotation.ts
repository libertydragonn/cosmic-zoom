// IAU 自轉模型（NAIF pck00011.tpc）：計算天體本體座標 → J2000 黃道座標的旋轉。
// 本體座標：x 指向本初子午線（東經 0°）與赤道交點，z 指向 IAU 北極，y = z × x（東經 90°）。
import rotationData from "~/data/rotation.json";
import { DEG, J2000_JD, OBLIQUITY } from "./constants";

export interface RotationModel {
  /** 北極赤經（度）：ra[0] + ra[1]·T + ra[2]·T²（T：自 J2000 起的儒略世紀） */
  ra: number[];
  /** 北極赤緯（度） */
  dec: number[];
  /** 本初子午線角 W（度）：pm[0] + pm[1]·d + pm[2]·d²（d：自 J2000 起的日數） */
  pm: number[];
  /** 週期項係數：赤經用 sin、赤緯用 cos、W 用 sin */
  nra?: number[];
  ndec?: number[];
  npm?: number[];
  /** 週期項的角度多項式（度，以 T 為變數） */
  ang?: number[][];
}

const models = (rotationData as { bodies: Record<string, RotationModel> }).bodies;

export function rotationModel(id: string): RotationModel | undefined {
  return models[id];
}

const poly = (c: number[], t: number) => c[0] + (c[1] ?? 0) * t + (c[2] ?? 0) * t * t;
const COS_E = Math.cos(OBLIQUITY);
const SIN_E = Math.sin(OBLIQUITY);

/**
 * 寫入 out（長度 9，行主序：out[0..2]＝本體 x 軸、out[3..5]＝y 軸、out[6..8]＝z 軸，
 * 皆以 J2000 黃道座標表示）。jd 視為 TDB。
 */
export function bodyFrame(m: RotationModel, jd: number, out: Float64Array | number[]): void {
  const d = jd - J2000_JD;
  const T = d / 36525;
  let ra = poly(m.ra, T);
  let dec = poly(m.dec, T);
  let W = poly(m.pm, d);
  if (m.ang) {
    for (let i = 0; i < m.ang.length; i++) {
      const a = m.ang[i];
      const th = (a[0] + a[1] * T + (a[2] ?? 0) * T * T) * DEG;
      const s = Math.sin(th);
      ra += (m.nra?.[i] ?? 0) * s;
      dec += (m.ndec?.[i] ?? 0) * Math.cos(th);
      W += (m.npm?.[i] ?? 0) * s;
    }
  }
  const al = ra * DEG;
  const de = dec * DEG;
  const w = (W % 360) * DEG;
  const ca = Math.cos(al), sa = Math.sin(al), cd = Math.cos(de), sd = Math.sin(de);
  const cw = Math.cos(w), sw = Math.sin(w);
  // ICRF 中：北極 z、升交點方向 n（赤經 α+90°）、m = z × n
  const zx = cd * ca, zy = cd * sa, zz = sd;
  const nx = -sa, ny = ca; // nz = 0
  const mx = -sd * ca, my = -sd * sa, mz = cd;
  const xx = nx * cw + mx * sw, xy = ny * cw + my * sw, xz = mz * sw;
  const yx = -nx * sw + mx * cw, yy = -ny * sw + my * cw, yz = mz * cw;
  // 赤道 → 黃道
  out[0] = xx;
  out[1] = xy * COS_E + xz * SIN_E;
  out[2] = -xy * SIN_E + xz * COS_E;
  out[3] = yx;
  out[4] = yy * COS_E + yz * SIN_E;
  out[5] = -yy * SIN_E + yz * COS_E;
  out[6] = zx;
  out[7] = zy * COS_E + zz * SIN_E;
  out[8] = -zy * SIN_E + zz * COS_E;
}

/** 黃道座標中的方向 v（天體 → 觀測者）換算成行星中心經緯度（東經為正，度）。 */
export function subPoint(frame: ArrayLike<number>, v: ArrayLike<number>): { lonE: number; lat: number } {
  const n = Math.hypot(v[0], v[1], v[2]);
  const x = (frame[0] * v[0] + frame[1] * v[1] + frame[2] * v[2]) / n;
  const y = (frame[3] * v[0] + frame[4] * v[1] + frame[5] * v[2]) / n;
  const z = (frame[6] * v[0] + frame[7] * v[1] + frame[8] * v[2]) / n;
  return { lonE: ((Math.atan2(y, x) / DEG) % 360 + 360) % 360, lat: Math.asin(Math.max(-1, Math.min(1, z))) / DEG };
}
