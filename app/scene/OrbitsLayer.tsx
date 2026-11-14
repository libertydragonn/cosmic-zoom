// 軌道線。每幀以 float64 重新計算「軌道點 − 相機」再轉成 float32，
// 而且第一個頂點就是天體目前的位置，所以拉到很近時軌道線仍會準確穿過天體。
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { type Body, bodies, getBody } from "~/lib/bodies";
import { engine } from "~/lib/engine";
import { useUI } from "~/lib/store";

const MAX_VERTS = 90000;
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Props {
  /** 此圖層負責哪些天體的軌道。 */
  kinds: Body["kind"][];
  /** 圖層單位（1 單位 = 幾 km）。 */
  unitKm: number;
}

export function OrbitsLayer({ kinds, unitKm }: Props) {
  const lineRef = useRef<THREE.LineSegments>(null);
  const state = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(new Float32Array(MAX_VERTS * 3), 3);
    const colors = new THREE.BufferAttribute(new Float32Array(MAX_VERTS * 4), 4);
    positions.setUsage(THREE.DynamicDrawUsage);
    colors.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", positions);
    geometry.setAttribute("color", colors);
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(MAX_VERTS * 2), 1));
    return { geometry, positions, colors, layoutKey: "" };
  }, []);

  useFrame(() => {
    const cam = engine.camPos;
    const pxPerRad = engine.pxPerRad;
    const selectedId = useUI.getState().selectedId;
    const pos = state.positions.array as Float32Array;
    const col = state.colors.array as Float32Array;
    const idx = state.geometry.index!.array as Uint32Array;
    const inv = 1 / unitKm;
    let v = 0;
    let ix = 0;
    let key = "";

    for (let k = 0; k < bodies.length; k++) {
      const b = bodies[k];
      if (!b.orbit || !b.parentId || !kinds.includes(b.kind)) continue;
      const parent = getBody(b.parentId)!;
      const pcx = parent.pos[0] - cam[0];
      const pcy = parent.pos[1] - cam[1];
      const pcz = parent.pos[2] - cam[2];
      const pd = Math.sqrt(pcx * pcx + pcy * pcy + pcz * pcz);
      const orbitPx = (b.el.a / Math.max(pd, 1e-9)) * pxPerRad;
      // 軌道太小（縮成一點）時淡出
      let alpha = smoothstep(b.kind === "moon" ? 10 : 5, b.kind === "moon" ? 30 : 16, orbitPx);
      // 軌道遠大於畫面時（拉近看內側天體）調暗，避免外圍軌道變成滿畫面的線
      const big = smoothstep(1.2, 5, orbitPx / engine.height);
      alpha *= 1 - (b.kind === "moon" ? 0.88 : 0.6) * big;
      if (b.kind === "moon") alpha *= 0.75;
      if (b.kind === "dwarf") alpha *= b.subtype === "candidate" ? 0.5 : 0.7;
      const selected = b.id === selectedId;
      if (selected) alpha = Math.max(alpha, smoothstep(2, 6, orbitPx));
      if (alpha <= 0.003) continue;

      const N = b.orbitSegments;
      if (v + N > MAX_VERTS) break;
      key += b.id + ",";

      const a = b.el.a;
      const e = b.el.e;
      const bb = a * Math.sqrt(1 - e * e);
      const P = b.P;
      const Q = b.Q;
      const step = (Math.PI * 2) / N;
      const cs = Math.cos(step);
      const sn = Math.sin(step);
      let c = Math.cos(b.E);
      let s = Math.sin(b.E);
      const cr = selected ? 1 : 0.35 + 0.65 * b.color[0];
      const cg = selected ? 1 : 0.35 + 0.65 * b.color[1];
      const cb = selected ? 1 : 0.35 + 0.65 * b.color[2];
      const base = v;
      for (let j = 0; j < N; j++) {
        const x = a * (c - e);
        const y = bb * s;
        const o = v * 3;
        pos[o] = (pcx + x * P[0] + y * Q[0]) * inv;
        pos[o + 1] = (pcy + x * P[1] + y * Q[1]) * inv;
        pos[o + 2] = (pcz + x * P[2] + y * Q[2]) * inv;
        // 天體後方的軌跡最亮，往前逐漸變淡
        const f = j / N;
        const o4 = v * 4;
        col[o4] = cr;
        col[o4 + 1] = cg;
        col[o4 + 2] = cb;
        col[o4 + 3] = alpha * (0.1 + 0.9 * f * f);
        idx[ix++] = v;
        idx[ix++] = j === N - 1 ? base : v + 1;
        v++;
        const c2 = c * cs - s * sn;
        s = s * cs + c * sn;
        c = c2;
      }
      // 起點（天體位置）用最亮的值收尾
      col[base * 4 + 3] = alpha;
    }

    // 只上傳實際用到的範圍
    state.positions.clearUpdateRanges();
    state.positions.addUpdateRange(0, v * 3);
    state.colors.clearUpdateRanges();
    state.colors.addUpdateRange(0, v * 4);
    state.positions.needsUpdate = true;
    state.colors.needsUpdate = true;
    if (key !== state.layoutKey) {
      state.layoutKey = key;
      state.geometry.index!.needsUpdate = true;
    }
    state.geometry.setDrawRange(0, ix);
    if (lineRef.current) lineRef.current.visible = ix > 0;
  });

  return (
    <lineSegments ref={lineRef} geometry={state.geometry} frustumCulled={false} renderOrder={1}>
      <lineBasicMaterial vertexColors transparent depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
}
