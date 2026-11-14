// 行星系圖層（單位：km）。太陽、行星、矮行星、衛星的球體。
// 每幀以 float64 計算「天體 − 相機」，再寫入 InstancedMesh 的矩陣（相機恆在原點）。
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { type Body, bodies, getBody } from "~/lib/bodies";
import { engine } from "~/lib/engine";
import { addLabelProvider, nextCandidate } from "./labels";

const CAPACITY = 1024;
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 放大顯示模式下，各類天體在螢幕上的最小半徑（像素）。 */
const MIN_PX: Record<Body["kind"], number> = { sun: 5, planet: 3.6, dwarf: 2.6, moon: 2.1 };
const LABEL_ORBIT_PX: Record<Body["kind"], number> = { sun: 0, planet: 16, dwarf: 16, moon: 24 };
const LABEL_PRIORITY: Record<Body["kind"], number> = { sun: 900, planet: 800, dwarf: 600, moon: 400 };
const LABEL_CLASS: Record<Body["kind"], string> = {
  sun: "lbl-sun",
  planet: "lbl-planet",
  dwarf: "lbl-dwarf",
  moon: "lbl-moon",
};

/** 每個天體本幀的顯示資訊，供標籤與點選使用。 */
interface Display {
  x: number;
  y: number;
  rPx: number;
  orbitPx: number;
  onScreen: boolean;
}
const display = new Map<string, Display>();

function glowTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,250,235,1)");
  g.addColorStop(0.08, "rgba(255,240,200,0.85)");
  g.addColorStop(0.25, "rgba(255,200,120,0.28)");
  g.addColorStop(0.6, "rgba(255,160,80,0.06)");
  g.addColorStop(1, "rgba(255,140,60,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function BodiesLayer() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const sunRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Sprite>(null);
  const lightRef = useRef<THREE.PointLight>(null);
  const glowMap = useMemo(glowTexture, []);
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), c: new THREE.Color(), p: [0, 0, 0] as number[] }), []);

  useEffect(() => {
    const mesh = meshRef.current!;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, tmp.c.setRGB(1, 1, 1));
    mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
  }, [tmp]);

  useEffect(
    () =>
      addLabelProvider(() => {
        const far = engine.logDist > 16.4; // 銀河系尺度時由銀河圖層標示太陽位置
        for (let k = 0; k < bodies.length; k++) {
          const b = bodies[k];
          const d = display.get(b.id);
          if (!d || !d.onScreen) continue;
          const c = nextCandidate();
          c.id = b.id;
          c.zh = b.zh;
          c.en = b.en;
          c.x = d.x;
          c.y = d.y;
          c.r = d.rPx;
          c.cls = LABEL_CLASS[b.kind];
          c.priority = LABEL_PRIORITY[b.kind] + (b.radiusKm ? Math.log10(b.radiusKm) * 8 : 0) - (b.subtype === "candidate" ? 60 : 0);
          const wanted = b.kind === "sun" ? !far : d.orbitPx > LABEL_ORBIT_PX[b.kind];
          c.show = wanted;
          c.pickable = wanted;
        }
      }),
    [],
  );

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const cam = engine.camPos;
    const pxPerRad = engine.pxPerRad;
    const enlarged = engine.enlarged;
    const arr = mesh.instanceMatrix.array as Float32Array;
    let n = 0;
    const scr = tmp.p;

    for (let k = 0; k < bodies.length; k++) {
      const b = bodies[k];
      const rx = b.pos[0] - cam[0];
      const ry = b.pos[1] - cam[1];
      const rz = b.pos[2] - cam[2];
      const dist = Math.sqrt(rx * rx + ry * ry + rz * rz);

      // 軌道在螢幕上的大小，決定小天體是否顯示
      let orbitPx = Infinity;
      if (b.parentId) {
        const parent = getBody(b.parentId)!;
        const pd = Math.hypot(parent.pos[0] - cam[0], parent.pos[1] - cam[1], parent.pos[2] - cam[2]);
        orbitPx = (b.el.a / Math.max(pd, 1e-9)) * pxPerRad;
      }

      const real = b.radiusKm ?? 0;
      let shown = real;
      if (enlarged) {
        const fade = b.kind === "sun" ? 1 : smoothstep(b.kind === "moon" ? 5 : 2.5, b.kind === "moon" ? 14 : 8, orbitPx);
        const minR = (dist * MIN_PX[b.kind] * fade) / pxPerRad;
        if (minR > shown) shown = minR;
      }

      let d = display.get(b.id);
      if (!d) display.set(b.id, (d = { x: 0, y: 0, rPx: 0, orbitPx: 0, onScreen: false }));
      d.onScreen = engine.project(b.pos, scr);
      d.x = scr[0];
      d.y = scr[1];
      d.rPx = (shown / Math.max(dist, 1e-9)) * pxPerRad;
      d.orbitPx = orbitPx;

      if (b.kind === "sun") {
        const sun = sunRef.current!;
        sun.position.set(rx, ry, rz);
        sun.scale.setScalar(Math.max(shown, 1e-6));
        lightRef.current!.position.set(rx, ry, rz);
        const glow = glowRef.current!;
        // 光暈：近看時約為太陽的數倍，遠看時維持固定像素大小，並在銀河系尺度淡出
        const fadeFar = 1 - smoothstep(15.6, 16.6, engine.logDist);
        // 離開太陽系後，太陽只是眾多恆星之一，光暈縮到與其他亮星相當
        const glowPx = 22 - 16 * smoothstep(12.2, 13.6, engine.logDist);
        const glowR = Math.max(real * 7, (dist * glowPx) / pxPerRad);
        glow.position.set(rx, ry, rz);
        glow.scale.setScalar(glowR * 2);
        (glow.material as THREE.SpriteMaterial).opacity = fadeFar;
        glow.visible = fadeFar > 0.002;
        continue;
      }

      if (n >= CAPACITY || shown <= 0) continue;
      const o = n * 16;
      arr[o] = shown;
      arr[o + 1] = 0;
      arr[o + 2] = 0;
      arr[o + 3] = 0;
      arr[o + 4] = 0;
      arr[o + 5] = shown;
      arr[o + 6] = 0;
      arr[o + 7] = 0;
      arr[o + 8] = 0;
      arr[o + 9] = 0;
      arr[o + 10] = shown;
      arr[o + 11] = 0;
      arr[o + 12] = rx;
      arr[o + 13] = ry;
      arr[o + 14] = rz;
      arr[o + 15] = 1;
      mesh.setColorAt(n, tmp.c.setRGB(b.color[0], b.color[1], b.color[2], THREE.SRGBColorSpace));
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <ambientLight intensity={0.05} />
      <pointLight ref={lightRef} intensity={3.4} decay={0} color="#fff6e8" />
      <mesh ref={sunRef} frustumCulled={false}>
        <sphereGeometry args={[1, 48, 24]} />
        <meshBasicMaterial color="#fff3d0" toneMapped={false} />
      </mesh>
      <sprite ref={glowRef} frustumCulled={false} renderOrder={2}>
        <spriteMaterial map={glowMap} transparent depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false} />
      </sprite>
      <instancedMesh ref={meshRef} args={[undefined, undefined, CAPACITY]} frustumCulled={false}>
        <sphereGeometry args={[1, 40, 20]} />
        <meshStandardMaterial roughness={1} metalness={0} />
      </instancedMesh>
    </>
  );
}
