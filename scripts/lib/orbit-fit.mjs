// 由 JPL Horizons 的狀態向量推導衛星軌道根數。
//
// 為什麼不直接用 JPL「衛星平均根數表」的角度：實測發現該表部分列（特別是土星系）
// 的 ω、M、node 與 Horizons 星曆對不上（軌道面方向正確，但面內相位差可達上百度）。
// 所以這裡的做法是：
//   1. 向 Horizons 取三個時刻的行星中心狀態向量（黃道 J2000）。
//   2. 轉到該衛星的進動參考面（表列的拉普拉斯面極點、行星赤道，或黃道），算出密切根數。
//   3. 用三個時刻的相位求出平均運動；進動週期採用 JPL 表列值，方向由一年間的實際變化判定。
// 這樣曆元時刻的位置與 Horizons 完全一致，之後依平均運動與進動外推。

const DEG = Math.PI / 180;
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mod360 = (x) => ((x % 360) + 360) % 360;
const wrap180 = (x) => {
  const y = mod360(x);
  return y > 180 ? y - 360 : y;
};

/** 參考面極點（ICRF 赤經赤緯）→「參考面座標 → J2000 黃道」矩陣（與 app/lib/kepler.ts 相同）。 */
export function frameFromPole(raDeg, decDeg, obliquityDeg) {
  const a = raDeg * DEG;
  const d = decDeg * DEG;
  const c = Math.cos(obliquityDeg * DEG);
  const s = Math.sin(obliquityDeg * DEG);
  const toEcl = (v) => [v[0], c * v[1] + s * v[2], -s * v[1] + c * v[2]];
  const z = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
  const x = [-Math.sin(a), Math.cos(a), 0];
  const y = cross(z, x);
  return [toEcl(x), toEcl(y), toEcl(z)]; // 三個基底向量（黃道座標）
}

/** 狀態向量 → 密切克卜勒根數（角度為度）。 */
export function elementsFromState(r, v, mu) {
  const h = cross(r, v);
  const hn = Math.hypot(...h);
  const rn = Math.hypot(...r);
  const evec = cross(v, h).map((x, i) => x / mu - r[i] / rn);
  const e = Math.hypot(...evec);
  const i = Math.acos(Math.max(-1, Math.min(1, h[2] / hn)));
  const a = 1 / (2 / rn - dot(v, v) / mu);
  // 升交點方向；軌道面幾乎與參考面重合時以 x 軸代替
  let nvec = [-h[1], h[0], 0];
  let nn = Math.hypot(...nvec);
  if (nn < 1e-12 * hn) {
    nvec = [1, 0, 0];
    nn = 1;
  }
  const node = Math.atan2(nvec[1], nvec[0]);
  // 以「升交點方向」與「軌道面內垂直方向」為基底量角度
  const nhat = nvec.map((x) => x / nn);
  const mhat = cross(h.map((x) => x / hn), nhat);
  const u = Math.atan2(dot(r, mhat), dot(r, nhat)); // 真緯度引數
  let w = 0;
  let nu = u;
  if (e > 1e-9) {
    w = Math.atan2(dot(evec, mhat), dot(evec, nhat));
    nu = u - w;
  }
  const E = 2 * Math.atan2(Math.sqrt(Math.max(0, 1 - e)) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
  const M = E - e * Math.sin(E);
  return { a, e, i: i / DEG, node: mod360(node / DEG), argPeri: mod360(w / DEG), meanAnomaly: mod360(M / DEG) };
}

/**
 * @param states [{jd, r, v}] 三個時刻（T0、T0+短間隔、T0+長間隔），黃道座標 km、km/s
 * @param basis  參考面基底（frameFromPole 的結果），黃道面則為 null
 * @param mu     GM（km³/s²）
 * @param table  JPL 表列的 { periodDays, nodePeriodYr, apsisPeriodYr }
 */
export function fitMoonOrbit(states, basis, mu, table) {
  const toFrame = (x) => (basis ? [dot(x, basis[0]), dot(x, basis[1]), dot(x, basis[2])] : x);
  const els = states.map((s) => elementsFromState(toFrame(s.r), toFrame(s.v), mu));
  const el0 = els[0];
  if (!(el0.a > 0) || !(el0.e < 1)) throw new Error("非橢圓軌道");
  const retro = el0.i >= 90;
  // 相位：順行用 Ω+ω+M（傾角接近 0 時仍穩定），逆行用 ω+M
  const phase = (el) => (retro ? el.argPeri + el.meanAnomaly : el.node + el.argPeri + el.meanAnomaly);
  const dt1 = states[1].jd - states[0].jd;
  const dt2 = states[2].jd - states[0].jd;
  const n0 = 360 / table.periodDays;
  const n1 = n0 + wrap180(phase(els[1]) - phase(el0) - n0 * dt1) / dt1;
  const phaseRate = n1 + wrap180(phase(els[2]) - phase(el0) - n1 * dt2) / dt2;

  // 進動率：大小取 JPL 表列週期；方向在一年內變化夠大時用實測，否則用攝動理論的慣例
  const cosI = Math.cos(el0.i * DEG);
  function signedRate(periodYr, measuredDelta, wellDefined, theorySign) {
    if (!periodYr) return { rate: 0, basis: "none" };
    const mag = 360 / (periodYr * 365.25);
    if (wellDefined && mag * dt2 > 3 && mag * dt2 < 150) {
      const plus = Math.abs(wrap180(measuredDelta - mag * dt2));
      const minus = Math.abs(wrap180(measuredDelta + mag * dt2));
      return { rate: plus <= minus ? mag : -mag, basis: "measured" };
    }
    return { rate: theorySign * mag, basis: "theory" };
  }
  const sinI = Math.sin(el0.i * DEG);
  const nodeFit = signedRate(table.nodePeriodYr, els[2].node - el0.node, sinI > 0.02, cosI >= 0 ? -1 : 1);
  const apsisFit = signedRate(
    table.apsisPeriodYr,
    els[2].argPeri - el0.argPeri,
    sinI > 0.02 && el0.e > 0.02 && els[2].e > 0.02,
    cosI * cosI > 0.2 ? 1 : -1,
  );
  const meanAnomalyRate = phaseRate - apsisFit.rate - (retro ? 0 : nodeFit.rate);
  return {
    epochJd: states[0].jd,
    a: el0.a,
    e: el0.e,
    i: el0.i,
    node: el0.node,
    argPeri: el0.argPeri,
    meanAnomaly: el0.meanAnomaly,
    meanAnomalyRate, // deg/day
    nodeRate: nodeFit.rate, // deg/day（帶正負號）
    apsisRate: apsisFit.rate,
    rateBasis: { node: nodeFit.basis, apsis: apsisFit.basis },
  };
}
