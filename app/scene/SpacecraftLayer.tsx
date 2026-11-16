// 人造探測器圖層（單位：km，放在行星系場景）。標記點、軌跡線、標籤。
// 軌跡：目前在日心段時畫完整日心軌跡（過去較亮、未來較暗，飛掠段已換算到當時行星位置）；
// 目前在長期環繞某行星時，另外以「相對該行星」畫出前後一段時間的軌道。
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { getBody } from "~/lib/bodies";
import { engine } from "~/lib/engine";
import { type Craft, LONG_SEGMENT_DAYS, SUBDIV, crafts, evalSegment, orbiterPoint } from "~/lib/spacecraft";
import { ensureSpacecraft, useUI } from "~/lib/store";
import { addLabelProvider, nextCandidate } from "./labels";

const MAX_VERTS = 160000;
/** 環繞期在畫面上顯示的時間範圍（日）。 */
const ORBIT_PAST_DAYS = 120;
const ORBIT_FUTURE_DAYS = 40;

const display = new Map<string, { x: number; y: number; on: boolean }>();
const NO_TRAIL = { pts: new Float64Array(0), t: new Float64Array(0) };
const TWO_PI = Math.PI * 2;
/** 地球衛星中軌道最大者（TESS 遠地點約 37 萬公里）的量級，用來判斷何時下載。 */
const EARTH_EXTENT_KM = 400000;

/** 從相機看向 p 的視線是否被球體（中心 c、半徑 r）擋住。 */
function behindSphere(cam: Float64Array, p: Float64Array, c: Float64Array, r: number): boolean {
  const dx = p[0] - cam[0], dy = p[1] - cam[1], dz = p[2] - cam[2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const ux = dx / len, uy = dy / len, uz = dz / len;
  const ox = c[0] - cam[0], oy = c[1] - cam[1], oz = c[2] - cam[2];
  const tc = ox * ux + oy * uy + oz * uz; // 球心在視線上的投影距離
  if (tc <= 0 || tc >= len) return false;
  const d2 = ox * ox + oy * oy + oz * oz - tc * tc;
  return d2 < r * r;
}

/** 圓形標記點（帶細白框）。 */
function markerTexture(): THREE.Texture {
  const s = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = s;
  const ctx = canvas.getContext("2d")!;
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2 - 4, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,0.7)";
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function SpacecraftLayer() {
  const show = useUI((s) => s.showSpacecraft);
  const lineRef = useRef<THREE.LineSegments>(null);
  const pointsRef = useRef<THREE.Points>(null);
  const marker = useMemo(markerTexture, []);
  const state = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(new Float32Array(MAX_VERTS * 3), 3);
    const colors = new THREE.BufferAttribute(new Float32Array(MAX_VERTS * 4), 4);
    positions.setUsage(THREE.DynamicDrawUsage);
    colors.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", positions);
    geometry.setAttribute("color", colors);
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(MAX_VERTS * 2), 1));
    const pGeo = new THREE.BufferGeometry();
    const pPos = new THREE.BufferAttribute(new Float32Array(crafts.length * 3), 3);
    const pCol = new THREE.BufferAttribute(new Float32Array(crafts.length * 3), 3);
    pPos.setUsage(THREE.DynamicDrawUsage);
    pGeo.setAttribute("position", pPos);
    pGeo.setAttribute("color", pCol);
    return { geometry, positions, colors, pGeo, pPos, pCol, out: new Float64Array(6), earthRequested: false };
  }, []);

  useEffect(
    () =>
      addLabelProvider(() => {
        const ui = useUI.getState();
        if (!ui.showSpacecraft) return;
        for (const c of crafts) {
          if (ui.hiddenCraft.includes(c.id)) continue;
          const d = display.get(c.id);
          if (!d || !d.on) continue;
          const cand = nextCandidate();
          cand.id = c.id;
          cand.zh = c.zh;
          cand.en = c.en;
          cand.x = d.x;
          cand.y = d.y;
          cand.r = 2;
          cand.cls = "lbl-craft";
          cand.priority = 640;
        }
      }),
    [],
  );

  useFrame(() => {
    const line = lineRef.current;
    const points = pointsRef.current;
    if (!line || !points) return;
    if (!show) {
      line.visible = points.visible = false;
      for (const d of display.values()) d.on = false;
      return;
    }
    const cam = engine.camPos;
    const jd = engine.jd;
    const { selectedId, hiddenCraft, trailMode } = useUI.getState();
    const focusId = engine.fly ? engine.fly.toId : engine.targetId;
    const pos = state.positions.array as Float32Array;
    const col = state.colors.array as Float32Array;
    const idx = state.geometry.index!.array as Uint32Array;
    const pp = state.pPos.array as Float32Array;
    const pc = state.pCol.array as Float32Array;
    let v = 0;
    let ix = 0;
    let np = 0;
    const scr = [0, 0, 0];

    const pushLine = (x: number, y: number, z: number, c: Craft, alpha: number, connect: boolean) => {
      if (v >= MAX_VERTS) return;
      const o = v * 3;
      pos[o] = x - cam[0];
      pos[o + 1] = y - cam[1];
      pos[o + 2] = z - cam[2];
      const o4 = v * 4;
      col[o4] = c.color[0];
      col[o4 + 1] = c.color[1];
      col[o4 + 2] = c.color[2];
      col[o4 + 3] = alpha;
      if (connect && v > 0) {
        idx[ix++] = v - 1;
        idx[ix++] = v;
      }
      v++;
    };

    // 地球衛星：相機靠近地球（衛星軌道在畫面上夠大）或選取／飛往地球、地球衛星時才下載
    const earth = getBody("earth")!.pos;
    const ex = earth[0] - cam[0];
    const ey = earth[1] - cam[1];
    const ez = earth[2] - cam[2];
    const earthDist = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (!state.earthRequested) {
      const wantsEarth =
        (EARTH_EXTENT_KM / Math.max(earthDist, 1)) * engine.pxPerRad > 20 ||
        focusId === "earth" ||
        crafts.some((c) => c.rec.group === "earth" && (c.id === focusId || c.id === selectedId));
      if (wantsEarth) {
        state.earthRequested = true;
        void ensureSpacecraft("earth").catch(() => {
          state.earthRequested = false;
        });
      }
    }
    const earthR = getBody("earth")!.radiusKm ?? 6371;

    for (const c of crafts) {
      let d = display.get(c.id);
      if (!d) display.set(c.id, (d = { x: 0, y: 0, on: false }));
      d.on = false;
      if (!c.active || hiddenCraft.includes(c.id)) continue;
      const selected = c.id === selectedId;
      const boost = selected ? 1.7 : 1;
      // 「僅選取的」模式：只畫被選取或正在飛往／對準的探測器的軌跡
      const drawTrail = trailMode === "all" || selected || c.id === focusId;

      // 地球衛星：軌道在畫面上太小（會疊在地球上）時不顯示；畫目前的密切軌道
      if (c.orb && c.osc) {
        const orbitPx = (c.osc.a / Math.max(earthDist, 1)) * engine.pxPerRad;
        if (orbitPx < 8 && !selected && c.id !== focusId) continue;
        if (drawTrail) {
          const N = 180;
          for (let j = 0; j <= N; j++) {
            orbiterPoint(c, c.osc.E - (TWO_PI * j) / N, state.out);
            // 衛星位置最亮，沿軌道往後逐漸變淡
            const alpha = (0.6 * (1 - j / N) + 0.06) * boost;
            pushLine(earth[0] + state.out[0], earth[1] + state.out[1], earth[2] + state.out[2], c, Math.min(alpha, 1), j > 0);
          }
        }
        pp[np * 3] = c.pos[0] - cam[0];
        pp[np * 3 + 1] = c.pos[1] - cam[1];
        pp[np * 3 + 2] = c.pos[2] - cam[2];
        pc[np * 3] = c.color[0];
        pc[np * 3 + 1] = c.color[1];
        pc[np * 3 + 2] = c.color[2];
        np++;
        // 被地球擋住時不貼標籤（標記點本身由深度測試遮住）
        d.on = engine.project(c.pos, scr) && !behindSphere(cam, c.pos, earth, earthR);
        d.x = scr[0];
        d.y = scr[1];
        continue;
      }
      if (!c.segs || !c.trail) continue;

      // 1. 日心軌跡
      const { pts, t } = drawTrail ? c.trail : NO_TRAIL;
      let connect = false;
      const t0 = c.rec.coverage.start;
      for (let k = 0; k < t.length; k++) {
        if (Number.isNaN(t[k])) {
          connect = false;
          continue;
        }
        const past = t[k] <= jd;
        // 過去：越接近現在越亮；未來：固定較暗
        const f = past ? (t[k] - t0) / Math.max(jd - t0, 1e-6) : 0;
        const alpha = (past ? 0.12 + 0.43 * f : 0.22) * boost;
        pushLine(pts[k * 3], pts[k * 3 + 1], pts[k * 3 + 2], c, Math.min(alpha, 1), connect);
        connect = true;
      }

      // 2. 長期環繞某行星：以行星目前位置為中心畫前後一段時間
      const seg = c.segs[c.segIndex];
      if (drawTrail && seg.center !== "sun" && seg.t1 - seg.t0 > LONG_SEGMENT_DAYS) {
        const center = getBody(seg.center)!.pos;
        const a = Math.max(seg.t0, jd - ORBIT_PAST_DAYS);
        const b = Math.min(seg.t1, jd + ORBIT_FUTURE_DAYS);
        let first = true;
        const st = seg.t;
        for (let k = 0; k < st.length - 1; k++) {
          if (st[k + 1] < a || st[k] > b) continue;
          for (let j = 0; j < SUBDIV; j++) {
            const tt = st[k] + ((st[k + 1] - st[k]) * j) / SUBDIV;
            if (tt < a || tt > b) continue;
            evalSegment(seg, tt, state.out);
            const past = tt <= jd;
            const f = past ? (tt - a) / Math.max(jd - a, 1e-6) : 0;
            const alpha = (past ? 0.1 + 0.5 * f : 0.22) * boost;
            pushLine(center[0] + state.out[0], center[1] + state.out[1], center[2] + state.out[2], c, Math.min(alpha, 1), !first);
            first = false;
          }
        }
      }

      // 3. 標記點
      pp[np * 3] = c.pos[0] - cam[0];
      pp[np * 3 + 1] = c.pos[1] - cam[1];
      pp[np * 3 + 2] = c.pos[2] - cam[2];
      pc[np * 3] = c.color[0];
      pc[np * 3 + 1] = c.color[1];
      pc[np * 3 + 2] = c.color[2];
      np++;
      d.on = engine.project(c.pos, scr);
      d.x = scr[0];
      d.y = scr[1];
    }

    state.positions.clearUpdateRanges();
    state.positions.addUpdateRange(0, v * 3);
    state.colors.clearUpdateRanges();
    state.colors.addUpdateRange(0, v * 4);
    state.positions.needsUpdate = true;
    state.colors.needsUpdate = true;
    state.geometry.index!.needsUpdate = true;
    state.geometry.setDrawRange(0, ix);
    line.visible = ix > 0;
    state.pPos.needsUpdate = true;
    state.pCol.needsUpdate = true;
    state.pGeo.setDrawRange(0, np);
    points.visible = np > 0;
  });

  return (
    <>
      <lineSegments ref={lineRef} geometry={state.geometry} frustumCulled={false} renderOrder={1}>
        <lineBasicMaterial vertexColors transparent depthWrite={false} toneMapped={false} />
      </lineSegments>
      <points ref={pointsRef} geometry={state.pGeo} frustumCulled={false} renderOrder={2}>
        <pointsMaterial map={marker} size={8} sizeAttenuation={false} vertexColors transparent alphaTest={0.3} depthWrite={false} toneMapped={false} />
      </points>
    </>
  );
}
