// 太陽系圖層（單位：AU）的粒子雲：小行星帶、柯伊伯帶、離散盤（真實軌道根數，
// 在 vertex shader 內解克卜勒方程）與奧爾特雲（程序化生成的示意球殼）。
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { AU_KM, DEG } from "~/lib/constants";
import { engine } from "~/lib/engine";
import { OORT_INNER_AU, OORT_OUTER_AU, regions } from "~/lib/regions";
import { useUI } from "~/lib/store";
import { addLabelProvider, nextCandidate } from "./labels";

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface SmallBodyIndex {
  refEpochJd: number;
  mainbelt: { file: string; count: number };
  tno: { file: string; count: number; kuiperCount: number };
}

const ORBIT_VERT = /* glsl */ `
attribute vec3 aPa;   // 半長軸 × 近心點方向
attribute vec3 aQb;   // 半短軸 × 垂直方向
attribute vec3 aEMn;  // (離心率, 參考曆元的平近點角, 平均運動 rad/day)
attribute float aGroup;
uniform vec3 uOffset; // (太陽 − 相機)，AU，由 CPU 以 float64 算好
uniform float uDt;    // 距參考曆元的日數
uniform float uSize;
uniform vec3 uAlpha;
uniform vec3 uColor0;
uniform vec3 uColor1;
uniform vec3 uColor2;
varying vec4 vColor;
const float PI = 3.141592653589793;
void main() {
  float e = aEMn.x;
  float M = mod(aEMn.y + aEMn.z * uDt + PI, 2.0 * PI) - PI;
  float E = e < 0.8 ? M + e * sin(M) : (M >= 0.0 ? PI : -PI);
  for (int k = 0; k < 8; k++) {
    E += (M - (E - e * sin(E))) / (1.0 - e * cos(E));
  }
  vec3 p = aPa * (cos(E) - e) + aQb * sin(E) + uOffset;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uSize;
  vec3 c = aGroup < 0.5 ? uColor0 : (aGroup < 1.5 ? uColor1 : uColor2);
  float a = aGroup < 0.5 ? uAlpha.x : (aGroup < 1.5 ? uAlpha.y : uAlpha.z);
  vColor = vec4(c, a);
}`;

const STATIC_VERT = /* glsl */ `
uniform vec3 uOffset;
uniform float uSize;
uniform float uOpacity;
uniform vec3 uColor;
varying vec4 vColor;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + uOffset, 1.0);
  gl_PointSize = uSize;
  vColor = vec4(uColor, uOpacity);
}`;

const POINT_FRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5 || vColor.a <= 0.002) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * smoothstep(0.5, 0.15, d));
}`;

function buildOrbitGeometry(mainbelt: Float32Array, tno: Float32Array, kuiperCount: number): THREE.BufferGeometry {
  const n = (mainbelt.length + tno.length) / 7;
  const pa = new Float32Array(n * 3);
  const qb = new Float32Array(n * 3);
  const emn = new Float32Array(n * 3);
  const group = new Float32Array(n);
  let k = 0;
  const add = (src: Float32Array, groupOf: (i: number) => number) => {
    for (let i = 0; i < src.length / 7; i++, k++) {
      const a = src[i * 7];
      const e = src[i * 7 + 1];
      const inc = src[i * 7 + 2] * DEG;
      const node = src[i * 7 + 3] * DEG;
      const w = src[i * 7 + 4] * DEG;
      const b = a * Math.sqrt(1 - e * e);
      const cw = Math.cos(w);
      const sw = Math.sin(w);
      const cO = Math.cos(node);
      const sO = Math.sin(node);
      const ci = Math.cos(inc);
      const si = Math.sin(inc);
      pa[k * 3] = a * (cw * cO - sw * sO * ci);
      pa[k * 3 + 1] = a * (cw * sO + sw * cO * ci);
      pa[k * 3 + 2] = a * (sw * si);
      qb[k * 3] = b * (-sw * cO - cw * sO * ci);
      qb[k * 3 + 1] = b * (-sw * sO + cw * cO * ci);
      qb[k * 3 + 2] = b * (cw * si);
      emn[k * 3] = e;
      emn[k * 3 + 1] = src[i * 7 + 5] * DEG;
      emn[k * 3 + 2] = src[i * 7 + 6] * DEG;
      group[k] = groupOf(i);
    }
  };
  add(mainbelt, () => 0);
  add(tno, (i) => (i < kuiperCount ? 1 : 2));
  const g = new THREE.BufferGeometry();
  // position 屬性只為了讓 three 知道頂點數；實際位置在 shader 內計算
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("aPa", new THREE.BufferAttribute(pa, 3));
  g.setAttribute("aQb", new THREE.BufferAttribute(qb, 3));
  g.setAttribute("aEMn", new THREE.BufferAttribute(emn, 3));
  g.setAttribute("aGroup", new THREE.BufferAttribute(group, 1));
  return g;
}

/** 可重現的亂數（mulberry32）。 */
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

/** 奧爾特雲示意：方向均勻、半徑在內外緣之間取對數均勻分佈的球殼。 */
function buildOortGeometry(count: number): THREE.BufferGeometry {
  const rand = rng(20261114);
  const pos = new Float32Array(count * 3);
  const lo = Math.log(OORT_INNER_AU);
  const hi = Math.log(OORT_OUTER_AU);
  for (let i = 0; i < count; i++) {
    const r = Math.exp(lo + (hi - lo) * rand());
    const z = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    pos[i * 3] = r * s * Math.cos(phi);
    pos[i * 3 + 1] = r * s * Math.sin(phi);
    pos[i * 3 + 2] = r * z;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return g;
}

export function SmallBodiesLayer() {
  const [orbitGeo, setOrbitGeo] = useState<THREE.BufferGeometry | null>(null);
  const refEpoch = useRef(0);
  const mobile = typeof window !== "undefined" && window.innerWidth < 768;
  const oortGeo = useMemo(() => buildOortGeometry(mobile ? 25000 : 60000), [mobile]);

  const orbitMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: ORBIT_VERT,
        fragmentShader: POINT_FRAG,
        uniforms: {
          uOffset: { value: new THREE.Vector3() },
          uDt: { value: 0 },
          uSize: { value: 2 },
          uAlpha: { value: new THREE.Vector3(1, 1, 1) },
          uColor0: { value: new THREE.Color("#c9b08c") },
          uColor1: { value: new THREE.Color("#86b9f2") },
          uColor2: { value: new THREE.Color("#c79bf0") },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );
  const oortMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: STATIC_VERT,
        fragmentShader: POINT_FRAG,
        uniforms: {
          uOffset: { value: new THREE.Vector3() },
          uSize: { value: 1.6 },
          uOpacity: { value: 0 },
          uColor: { value: new THREE.Color("#8fc4e8") },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );

  // 小天體資料在背景下載，不阻擋首次繪製
  useEffect(() => {
    let cancelled = false;
    const base = `${import.meta.env.BASE_URL}data/smallbodies/`;
    const setState = useUI.getState().setDataset;
    setState("smallbodies", "loading");
    (async () => {
      try {
        const index = (await (await fetch(base + "index.json")).json()) as SmallBodyIndex;
        const [mb, tno] = await Promise.all(
          [index.mainbelt.file, index.tno.file].map(async (f) => {
            const r = await fetch(base + f);
            if (!r.ok) throw new Error(`HTTP ${r.status} ${f}`);
            return new Float32Array(await r.arrayBuffer());
          }),
        );
        if (cancelled) return;
        refEpoch.current = index.refEpochJd;
        setOrbitGeo(buildOrbitGeometry(mb, tno, index.tno.kuiperCount));
        setState("smallbodies", "ready");
      } catch (err) {
        console.error("載入小天體資料失敗", err);
        if (!cancelled) setState("smallbodies", "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      addLabelProvider(() => {
        const scr = [0, 0, 0];
        for (const r of regions) {
          const px = (r.sizeKm / engine.dist) * engine.pxPerRad;
          if (px < 55 || px > engine.height * 2.2) continue;
          if (!engine.project(r.anchor, scr)) continue;
          const c = nextCandidate();
          c.id = r.id;
          c.zh = r.zh;
          c.en = r.en;
          c.x = scr[0];
          c.y = scr[1];
          c.r = 0;
          c.cls = "lbl-region";
          c.priority = 700;
        }
      }),
    [],
  );

  useFrame(({ gl }) => {
    const L = engine.logDist;
    const cam = engine.camPos;
    const dpr = gl.getPixelRatio();
    // 太陽在日心座標的原點，所以偏移量就是 −相機位置
    const ox = -cam[0] / AU_KM;
    const oy = -cam[1] / AU_KM;
    const oz = -cam[2] / AU_KM;

    const u = orbitMat.uniforms;
    u.uOffset.value.set(ox, oy, oz);
    u.uDt.value = engine.jd - refEpoch.current;
    u.uSize.value = (L > 10.4 ? 1.5 : 2.0) * dpr;
    // 尺度拉遠後依序淡出：小行星帶 → 柯伊伯帶 → 離散盤
    u.uAlpha.value.set(
      0.6 * (1 - smoothstep(10.6, 11.4, L)),
      0.75 * (1 - smoothstep(11.6, 12.5, L)),
      0.8 * (1 - smoothstep(12.2, 13.1, L)),
    );

    const o = oortMat.uniforms;
    o.uOffset.value.set(ox, oy, oz);
    o.uSize.value = 1.5 * dpr;
    // 奧爾特雲：約 300 AU 以上開始出現，到數十光年尺度淡出
    o.uOpacity.value = 0.5 * smoothstep(10.6, 12.2, L) * (1 - smoothstep(13.5, 14.5, L));
  });

  return (
    <>
      <points geometry={oortGeo} material={oortMat} frustumCulled={false} />
      {orbitGeo && <points geometry={orbitGeo} material={orbitMat} frustumCulled={false} />}
    </>
  );
}
