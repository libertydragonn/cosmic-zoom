// 克卜勒軌道計算。所有運算皆為 float64。
import { DEG, OBLIQUITY } from "./constants";

/** 某一時刻的軌道根數（角度為弧度，a 為 km）。 */
export interface Elements {
  a: number;
  e: number;
  i: number;
  node: number;
  argPeri: number;
  M: number;
}

export type Vec3 = Float64Array;
/** 3×3 矩陣（列優先），把參考平面座標轉成 J2000 黃道座標。 */
export type Mat3 = Float64Array;

const TWO_PI = Math.PI * 2;

/** 解克卜勒方程 M = E − e·sin E（牛頓法）。 */
export function solveKepler(M: number, e: number): number {
  let m = M % TWO_PI;
  if (m > Math.PI) m -= TWO_PI;
  else if (m < -Math.PI) m += TWO_PI;
  // 高離心率時以 π 為起點較穩定
  let E = e < 0.8 ? m + e * Math.sin(m) : m >= 0 ? Math.PI : -Math.PI;
  for (let k = 0; k < 60; k++) {
    const dE = (m - (E - e * Math.sin(E))) / (1 - e * Math.cos(E));
    E += dE;
    if (Math.abs(dE) < 1e-13) break;
  }
  return E;
}

/**
 * 計算軌道平面內的兩個基底向量 P（指向近心點）與 Q（垂直於 P），
 * 並轉到 J2000 黃道座標。軌道上的點 = a(cos E − e)·P + a√(1−e²)·sin E·Q。
 */
export function orbitBasis(el: Elements, frame: Mat3 | null, P: Vec3, Q: Vec3): void {
  const cw = Math.cos(el.argPeri);
  const sw = Math.sin(el.argPeri);
  const cO = Math.cos(el.node);
  const sO = Math.sin(el.node);
  const ci = Math.cos(el.i);
  const si = Math.sin(el.i);
  const px = cw * cO - sw * sO * ci;
  const py = cw * sO + sw * cO * ci;
  const pz = sw * si;
  const qx = -sw * cO - cw * sO * ci;
  const qy = -sw * sO + cw * cO * ci;
  const qz = cw * si;
  if (frame) {
    P[0] = frame[0] * px + frame[1] * py + frame[2] * pz;
    P[1] = frame[3] * px + frame[4] * py + frame[5] * pz;
    P[2] = frame[6] * px + frame[7] * py + frame[8] * pz;
    Q[0] = frame[0] * qx + frame[1] * qy + frame[2] * qz;
    Q[1] = frame[3] * qx + frame[4] * qy + frame[5] * qz;
    Q[2] = frame[6] * qx + frame[7] * qy + frame[8] * qz;
  } else {
    P[0] = px;
    P[1] = py;
    P[2] = pz;
    Q[0] = qx;
    Q[1] = qy;
    Q[2] = qz;
  }
}

/** ICRF 赤道座標向量轉 J2000 黃道座標。 */
export function equatorialToEcliptic(x: number, y: number, z: number, out: Vec3 | number[], offset = 0): void {
  const c = Math.cos(OBLIQUITY);
  const s = Math.sin(OBLIQUITY);
  out[offset] = x;
  out[offset + 1] = c * y + s * z;
  out[offset + 2] = -s * y + c * z;
}

/**
 * 由參考平面的極點（ICRF 赤經、赤緯，度）建立「參考平面 → J2000 黃道」矩陣。
 * x 軸為該平面在 ICRF 赤道上的升交點（赤經 = 極點赤經 + 90°），
 * 與 JPL 衛星平均根數表的升交點定義一致。
 */
export function frameFromPole(raDeg: number, decDeg: number): Mat3 {
  const a = raDeg * DEG;
  const d = decDeg * DEG;
  const z = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  const x = [-Math.sin(a), Math.cos(a), 0];
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const ex = [0, 0, 0];
  const ey = [0, 0, 0];
  const ez = [0, 0, 0];
  equatorialToEcliptic(x[0], x[1], x[2], ex);
  equatorialToEcliptic(y[0], y[1], y[2], ey);
  equatorialToEcliptic(z[0], z[1], z[2], ez);
  // 欄向量為 ex、ey、ez
  return new Float64Array([ex[0], ey[0], ez[0], ex[1], ey[1], ez[1], ex[2], ey[2], ez[2]]);
}
