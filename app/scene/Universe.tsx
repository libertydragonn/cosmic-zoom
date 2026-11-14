// 3D 主畫面：一個 WebGL canvas，內含四個各自使用不同單位的場景，
// 由遠到近依序繪製（銀河系 → 恆星鄰域 → 太陽系 → 行星系），層間清除深度緩衝。
import { PerformanceMonitor } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { AU_KM, KLY_KM, LY_KM } from "~/lib/constants";
import { getBody } from "~/lib/bodies";
import { engine } from "~/lib/engine";
import { loadMoonSystem, moonSystems } from "~/lib/moons";
import { useUI } from "~/lib/store";
import { BodiesLayer } from "./BodiesLayer";
import { GalaxyLayer } from "./GalaxyLayer";
import { OrbitsLayer } from "./OrbitsLayer";
import { SmallBodiesLayer } from "./SmallBodiesLayer";
import { StarsLayer } from "./StarsLayer";
import { mountLabels, pickAt, updateLabels } from "./labels";

const FOV = 50;

interface LayerDef {
  name: string;
  unitKm: number;
  /** 依相機距離 (km) 回傳 [near, far]（圖層單位）。 */
  range: (distKm: number) => [number, number];
}

// 由遠到近
const LAYERS: LayerDef[] = [
  { name: "galaxy", unitKm: KLY_KM, range: (d) => [Math.max((d / KLY_KM) * 1e-4, 1e-9), 1e5] },
  { name: "stellar", unitKm: LY_KM, range: (d) => [Math.max((d / LY_KM) * 1e-4, 1e-9), 1e8] },
  { name: "solar", unitKm: AU_KM, range: (d) => [Math.max((d / AU_KM) * 1e-4, 1e-9), 1e9] },
  { name: "planetary", unitKm: 1, range: (d) => [Math.max(d * 1e-3, 0.01), 1e14] },
];

function Stage() {
  const scenes = useRef<(THREE.Scene | null)[]>([]);
  const basis = useMemo(() => new THREE.Matrix4(), []);
  const size = useThree((s) => s.size);

  useEffect(() => {
    engine.setViewport(size.width, size.height, FOV);
  }, [size]);

  // 1. 推進時間、更新天體位置與相機（最先執行）
  const frameNo = useRef(0);
  useFrame((_, delta) => {
    engine.tick(Math.min(delta, 0.1));
    // 衛星資料按需載入：某行星的衛星系在畫面上夠大，或該行星被選取／設為目標時才下載
    if (frameNo.current++ % 20 === 0) {
      const ui = useUI.getState();
      const focusId = engine.fly ? engine.fly.toId : engine.targetId;
      for (const planetId in moonSystems) {
        if (ui.moonSystems[planetId]) continue;
        const planet = getBody(planetId);
        if (!planet) continue;
        const d = Math.hypot(
          planet.pos[0] - engine.camPos[0],
          planet.pos[1] - engine.camPos[1],
          planet.pos[2] - engine.camPos[2],
        );
        const px = (moonSystems[planetId].extentKm / Math.max(d, 1)) * engine.pxPerRad;
        if (px > 14 || focusId === planetId || ui.selectedId === planetId) {
          void loadMoonSystem(planetId, (s) => useUI.getState().setMoonSystem(planetId, s));
        }
      }
    }
  }, -10);

  // 2. 各圖層自己的 useFrame（優先度 0）把物件擺到「相對相機」的位置

  // 3. 手動繪製各層
  useFrame(({ gl, camera }) => {
    const cam = camera as THREE.PerspectiveCamera;
    const r = engine.right;
    const u = engine.up;
    const f = engine.fwd;
    basis.set(r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, 0, 0, 0, 1);
    cam.position.set(0, 0, 0);
    cam.quaternion.setFromRotationMatrix(basis);
    cam.updateMatrixWorld();

    gl.autoClear = false;
    gl.clear(true, true, true);
    const dist = engine.dist;
    for (let k = 0; k < LAYERS.length; k++) {
      const scene = scenes.current[k];
      if (!scene) continue;
      const [near, far] = LAYERS[k].range(dist);
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
      gl.clearDepth();
      gl.render(scene, cam);
    }
    updateLabels();
  }, 1);

  return (
    <>
      <scene ref={(s) => void (scenes.current[0] = s)}>
        <GalaxyLayer />
      </scene>
      <scene ref={(s) => void (scenes.current[1] = s)}>
        <StarsLayer />
      </scene>
      <scene ref={(s) => void (scenes.current[2] = s)}>
        <SmallBodiesLayer />
        <OrbitsLayer kinds={["planet", "dwarf"]} unitKm={AU_KM} />
      </scene>
      <scene ref={(s) => void (scenes.current[3] = s)}>
        <BodiesLayer />
        <OrbitsLayer kinds={["moon"]} unitKm={1} />
      </scene>
    </>
  );
}

/** 滑鼠、滾輪、觸控操作。 */
function useControls(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    let downX = 0;
    let downY = 0;
    let downTime = 0;
    let moved = false;
    let lastTap = 0;

    const local = (e: PointerEvent | MouseEvent) => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 33 : 1;
      // 觸控板雙指縮放（ctrlKey）數值較小，放大倍率
      const k = e.ctrlKey ? 0.012 : 0.0018;
      engine.zoomBy(Math.max(-0.6, Math.min(0.6, e.deltaY * unit * k)));
    };
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest(".lbl")) return;
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        downX = e.clientX;
        downY = e.clientY;
        downTime = performance.now();
        moved = false;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        moved = true;
      }
    };
    const onMove = (e: PointerEvent) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pointers.size === 1) {
        if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) moved = true;
        if (moved) engine.rotateBy(-dx * 0.0055, dy * 0.0055);
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0 && d > 0) engine.zoomBy(-Math.log10(d / pinchDist) * 1.6);
        pinchDist = d;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0 && !moved && performance.now() - downTime < 400) {
        const [x, y] = local(e);
        const id = pickAt(x, y);
        const now = performance.now();
        const ui = useUI.getState();
        if (id && now - lastTap < 350 && ui.selectedId === id) ui.flyTo(id);
        else ui.select(id);
        lastTap = now;
      }
    };
    const onLabelClick = (e: MouseEvent) => {
      const lbl = (e.target as HTMLElement).closest<HTMLElement>(".lbl");
      if (!lbl?.dataset.id) return;
      const ui = useUI.getState();
      if (e.detail >= 2) ui.flyTo(lbl.dataset.id);
      else ui.select(lbl.dataset.id);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("click", onLabelClick);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("click", onLabelClick);
    };
  }, [ref]);
}

export default function Universe() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  useControls(wrapRef);
  useEffect(() => mountLabels(labelRef.current!), []);
  // 解析度倍率：從裝置像素比起跳（上限 2），幀率不足時自動調降、恢復後再調回
  const maxDpr = typeof window === "undefined" ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  const [dpr, setDpr] = useState(maxDpr);

  return (
    <div ref={wrapRef} className="absolute inset-0 touch-none select-none overflow-hidden">
      <Canvas
        flat
        dpr={dpr}
        gl={{ antialias: true, logarithmicDepthBuffer: true, powerPreference: "high-performance" }}
        camera={{ fov: FOV, near: 0.01, far: 1e14, position: [0, 0, 0] }}
        onCreated={({ gl }) => gl.setClearColor("#02030a", 1)}
      >
        <PerformanceMonitor
          onDecline={() => setDpr((d) => Math.max(1, d - 0.5))}
          onIncline={() => setDpr((d) => Math.min(maxDpr, d + 0.5))}
        />
        <Stage />
      </Canvas>
      <div ref={labelRef} className="pointer-events-none absolute inset-0 overflow-hidden" />
    </div>
  );
}
