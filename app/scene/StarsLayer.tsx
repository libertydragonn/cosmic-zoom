// 恆星鄰域圖層（單位：光年）。HYG 恆星以 Points 繪製；
// 亮度依「從相機看到的視星等」計算，所以飛近一顆星時它會變亮。
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { LY_KM, PC_KM } from "~/lib/constants";
import { engine } from "~/lib/engine";
import { type StarEntity, loadStars } from "~/lib/stars";
import { useUI } from "~/lib/store";
import { addLabelProvider, nextCandidate } from "./labels";

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const LY_PER_PC = PC_KM / LY_KM;

const VERT = /* glsl */ `
attribute float aAbsMag;
attribute vec3 aColor;
uniform vec3 uOffset;   // −相機位置（光年），由 CPU 以 float64 算好
uniform float uRefPc;   // 星等的參考距離
uniform float uDpr;
uniform float uOpacity;
uniform float uBoost;   // 星際尺度下額外調亮的星等數
varying vec4 vColor;
void main() {
  vec3 p = position + uOffset;
  float dPc = max(length(p) / ${LY_PER_PC.toFixed(6)}, 1e-7);
  // 從相機看到的星等（以 uRefPc 取代標準的 10 秒差距，讓拉遠時恆星不至於全部暗掉）
  float m = aAbsMag + 5.0 * log(dPc / uRefPc) / 2.302585 - uBoost;
  float b = pow(10.0, -0.4 * (m - 2.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(2.8 * pow(b, 0.3), 1.5, 16.0) * uDpr;
  vColor = vec4(aColor, clamp(2.4 * pow(b, 0.55), 0.1, 1.0) * uOpacity);
}`;

const FRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0 || vColor.a <= 0.002) discard;
  float core = smoothstep(1.0, 0.0, d);
  gl_FragColor = vec4(vColor.rgb, vColor.a * core * core);
}`;

/** B−V 色指數 → 近似的 RGB（美術用的近似，不是光度學計算）。 */
function colorFromBV(bv: number, out: Float32Array, o: number): void {
  const stops: [number, number, number, number][] = [
    [-0.35, 0.62, 0.72, 1.0],
    [0.0, 0.8, 0.86, 1.0],
    [0.3, 1.0, 0.98, 0.96],
    [0.65, 1.0, 0.94, 0.8],
    [1.0, 1.0, 0.84, 0.62],
    [1.5, 1.0, 0.7, 0.45],
    [2.0, 1.0, 0.56, 0.36],
  ];
  const x = Number.isFinite(bv) ? Math.min(2, Math.max(-0.35, bv)) : 0.6;
  let k = 0;
  while (k < stops.length - 2 && x > stops[k + 1][0]) k++;
  const a = stops[k];
  const b = stops[k + 1];
  const t = (x - a[0]) / (b[0] - a[0]);
  out[o] = a[1] + (b[1] - a[1]) * t;
  out[o + 1] = a[2] + (b[2] - a[2]) * t;
  out[o + 2] = a[3] + (b[3] - a[3]) * t;
}

export function StarsLayer() {
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const entities = useRef<StarEntity[]>([]);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uOffset: { value: new THREE.Vector3() },
          uRefPc: { value: 10 },
          uDpr: { value: 1 },
          uOpacity: { value: 1 },
          uBoost: { value: 0 },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const setState = useUI.getState().setDataset;
    setState("stars", "loading");
    loadStars()
      .then((data) => {
        if (cancelled) return;
        const n = data.count;
        const pos = new Float32Array(n * 3);
        const mag = new Float32Array(n);
        const col = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          pos[i * 3] = data.buffer[i * 5];
          pos[i * 3 + 1] = data.buffer[i * 5 + 1];
          pos[i * 3 + 2] = data.buffer[i * 5 + 2];
          mag[i] = data.buffer[i * 5 + 3];
          colorFromBV(data.buffer[i * 5 + 4], col, i * 3);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        g.setAttribute("aAbsMag", new THREE.BufferAttribute(mag, 1));
        g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
        entities.current = data.entities;
        setGeometry(g);
        setState("stars", "ready");
      })
      .catch((err) => {
        console.error("載入恆星資料失敗", err);
        if (!cancelled) setState("stars", "error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      addLabelProvider(() => {
        const L = engine.logDist;
        if (L > 16.3) return;
        const scr = [0, 0, 0];
        const refPc = Math.max(10, (engine.dist / PC_KM) * 0.3);
        const list = entities.current;
        // 在太陽系內時只標最亮的幾顆，避免蓋住行星
        // 超過數百光年後所有恆星擠在太陽附近，只留最亮的幾顆
        const limit = L < 11 ? 0.6 : L < 12.5 ? 1.6 : L < 14.9 ? 3.4 : L < 15.5 ? 0.6 : -2.2;
        for (let k = 0; k < list.length; k++) {
          const s = list[k];
          if (!engine.project(s.pos, scr)) continue;
          if (scr[0] < 0 || scr[0] > engine.width || scr[1] < 0 || scr[1] > engine.height) continue;
          const m = s.data.absmag + 5 * Math.log10(Math.max(scr[2] / PC_KM, 1e-7) / refPc);
          const c = nextCandidate();
          c.id = s.id;
          c.zh = s.zh;
          c.en = s.en;
          c.x = scr[0];
          c.y = scr[1];
          c.r = 3;
          c.cls = "lbl-star";
          c.priority = 300 - m * 15 + (s.named ? 0 : -60);
          c.show = s.named && m < limit;
          c.pickable = m < 6.5;
        }
      }),
    [],
  );

  useFrame(({ gl }) => {
    const u = material.uniforms;
    const cam = engine.camPos;
    u.uOffset.value.set(-cam[0] / LY_KM, -cam[1] / LY_KM, -cam[2] / LY_KM);
    u.uRefPc.value = Math.max(10, (engine.dist / PC_KM) * 0.3);
    u.uDpr.value = gl.getPixelRatio();
    // 離開太陽系後，多數恆星本身很暗，調亮約 3 個星等讓鄰近恆星的分佈看得出來
    u.uBoost.value = 3 * smoothstep(12.3, 13.8, engine.logDist);
    // 到銀河系尺度時，鄰近恆星縮成太陽附近的一小團，逐漸淡出交給銀河圖層
    u.uOpacity.value = 1 - smoothstep(15.3, 16.5, engine.logDist);
  });

  if (!geometry) return null;
  return <points geometry={geometry} material={material} frustumCulled={false} />;
}
