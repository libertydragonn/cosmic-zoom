// 行星系圖層（單位：km）。太陽、行星、矮行星、衛星的球體。
// 每幀以 float64 計算「天體 − 相機」，再寫入 InstancedMesh 的矩陣（相機恆在原點）。
// 有真實表面影像的天體在畫面上夠大時，改用帶貼圖、依 IAU 自轉模型定向的個別網格（見 surfaces.ts）。
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { type Body, bodies, getBody } from "~/lib/bodies";
import { engine } from "~/lib/engine";
import { type RotationModel, bodyFrame, rotationModel } from "~/lib/rotation";
import { addLabelProvider, nextCandidate } from "./labels";
import {
  type TextureInfo,
  ellipsoidGeometry,
  loadTexture,
  releaseTexture,
  ringGeometry,
  ringMaterial,
  saturnRing,
  sunMaterial,
  textureInfo,
} from "./surfaces";

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

/**
 * 表面貼圖在螢幕上大於這個半徑（像素）才載入與顯示。放大顯示模式下行星最小也有 3.6 像素，
 * 門檻要高於它，否則遠處的小圓點也會各自下載一張全球地圖。
 */
const TEXTURE_MIN_PX = 8;
/** 土星環在土星半徑大於這個像素時就顯示。 */
const RING_MIN_PX = 2;
/** 大於這個半徑才載入高解析度版本（若有）。 */
const HI_RES_MIN_PX = 260;
const RING_COLOR = "#e3d6bc"; // 顯示用顏色；環的明暗與透明度由掩星光學深度計算

interface Surface {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  info: TextureInfo;
  model: RotationModel;
  ready: boolean;
  loading: boolean;
  failed: boolean;
  hiRequested: boolean;
  /** 每次釋放貼圖就加一，讓釋放前發出的下載結果作廢。 */
  gen: number;
  /** 最後一次需要它（夠大、要顯示貼圖）的時間（ms），用來決定先釋放哪個。 */
  lastSeen: number;
  ring?: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
}

/** 天體的三軸半徑（相對平均半徑）；沒有資料時視為球體。 */
function shapeOf(b: Body): [number, number] {
  const radii = (b.data as { radiiKm?: number[] } | undefined)?.radiiKm;
  const R = b.radiusKm ?? 1;
  if (!radii || radii.length < 3 || !(radii[0] > 0)) return [1, 1];
  return [(radii[0] + radii[1]) / 2 / R, radii[2] / R];
}

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
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), c: new THREE.Color(), p: [0, 0, 0] as number[], f: new Float64Array(9) }), []);
  const surfGroup = useRef<THREE.Group>(null);
  const surfaces = useMemo(() => new Map<string, Surface | null>(), []);
  if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __surfaces: unknown }).__surfaces = surfaces;
  const sunMat = useMemo(sunMaterial, []);
  const gl = useThree((s) => s.gl);
  const anisotropy = useMemo(() => Math.min(8, gl.capabilities.getMaxAnisotropy()), [gl]);
  // 小螢幕或貼圖尺寸上限不足時不載入高解析度版本
  const allowHi = useMemo(
    () => gl.capabilities.maxTextureSize >= 4096 && typeof window !== "undefined" && window.innerWidth * window.devicePixelRatio >= 1400,
    [gl],
  );

  const maxTextures = allowHi ? 14 : 8;

  /** 第一次需要時建立表面網格。 */
  function surfaceFor(b: Body): Surface | null {
    let s = surfaces.get(b.id);
    if (s !== undefined) return s;
    const info = textureInfo(b.id);
    const model = rotationModel(b.id);
    if (!info || !model || !surfGroup.current) {
      surfaces.set(b.id, null);
      return null;
    }
    const [a, c] = shapeOf(b);
    const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
    const mesh = new THREE.Mesh(ellipsoidGeometry(a, c, info.lat), material);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.visible = false;
    surfGroup.current.add(mesh);
    const surface: Surface = { mesh, info, model, ready: false, loading: false, failed: false, hiRequested: false, gen: 0, lastSeen: 0 };
    surfaces.set(b.id, surface);
    if (b.id === "saturn" && saturnRing) {
      const R = b.radiusKm ?? 1;
      const ringMat = ringMaterial(RING_COLOR);
      const ring = new THREE.Mesh(ringGeometry(saturnRing.innerKm / R, saturnRing.outerKm / R), ringMat);
      ring.matrixAutoUpdate = false;
      ring.frustumCulled = false;
      ring.visible = false;
      ring.renderOrder = 1;
      surfGroup.current.add(ring);
      surface.ring = ring;
      loadTexture(saturnRing.file, anisotropy).then((tex) => {
        if (!tex) return;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        ringMat.uniforms.map.value = tex;
      });
    }
    return surface;
  }

  /** 需要時（第一次或被釋放後）下載基本解析度的貼圖。 */
  function ensureTexture(s: Surface) {
    if (s.ready || s.loading || s.failed) return;
    s.loading = true;
    const gen = s.gen;
    loadTexture(s.info.file, anisotropy).then((tex) => {
      if (gen !== s.gen) return;
      s.loading = false;
      if (!tex) {
        s.failed = true; // 載入失敗：維持單色球體
        return;
      }
      s.mesh.material.map = tex;
      s.mesh.material.needsUpdate = true;
      s.ready = true;
    });
  }

  /** 釋放貼圖（GPU 記憶體），之後再需要時會重新下載。 */
  function evict(s: Surface) {
    s.gen++;
    s.ready = s.loading = s.hiRequested = false;
    s.mesh.material.map = null;
    s.mesh.material.needsUpdate = true;
    releaseTexture(s.info.file);
    if (s.info.hi) releaseTexture(s.info.hi.file);
  }

  // 卸載時移除並釋放表面網格（貼圖由快取共用，不在此釋放）
  useEffect(
    () => () => {
      for (const s of surfaces.values()) {
        if (!s) continue;
        for (const m of [s.mesh, s.ring]) {
          if (!m) continue;
          m.removeFromParent();
          m.geometry.dispose();
          m.material.dispose();
        }
      }
      surfaces.clear();
    },
    [surfaces],
  );

  /** 依本體座標軸（黃道座標）、縮放與位置設定網格矩陣。 */
  function place(obj: THREE.Object3D, f: Float64Array, s: number, x: number, y: number, z: number) {
    obj.matrix.set(f[0] * s, f[3] * s, f[6] * s, x, f[1] * s, f[4] * s, f[7] * s, y, f[2] * s, f[5] * s, f[8] * s, z, 0, 0, 0, 1);
    obj.matrixWorldNeedsUpdate = true;
  }

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
    const now = performance.now();
    for (const s of surfaces.values()) {
      if (!s) continue;
      s.mesh.visible = false;
      if (s.ring) s.ring.visible = false;
    }

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

      if (shown <= 0) continue;

      // 有表面貼圖的天體：夠大時改用帶貼圖、依 IAU 自轉模型定向的網格。
      // 土星環在土星很小時就畫（環比本體大 2.3 倍，且只用一張很小的剖面圖）。
      const wantsSurface = d.rPx >= TEXTURE_MIN_PX;
      const wantsRing = b.id === "saturn" && d.rPx >= RING_MIN_PX;
      if ((wantsSurface || wantsRing) && textureInfo(b.id)) {
        const s = surfaceFor(b);
        if (s) {
          bodyFrame(s.model, engine.jd, tmp.f);
          if (s.ring && wantsRing) {
            place(s.ring, tmp.f, shown, rx, ry, rz);
            const u = s.ring.material.uniforms;
            u.sunRel.value.set(-cam[0], -cam[1], -cam[2]); // 太陽在日心座標原點
            u.ringNormal.value.set(tmp.f[6], tmp.f[7], tmp.f[8]);
            s.ring.visible = !!u.map.value;
          }
          if (wantsSurface) {
            s.lastSeen = now; // 這一幀需要它：不會被釋放
            ensureTexture(s);
          }
          if (wantsSurface && s.ready) {
            place(s.mesh, tmp.f, shown, rx, ry, rz);
            s.mesh.visible = true;
            const hi = s.info.hi;
            if (hi && allowHi && !s.hiRequested && d.rPx >= HI_RES_MIN_PX) {
              s.hiRequested = true;
              const gen = s.gen;
              loadTexture(hi.file, anisotropy).then((tex) => {
                if (!tex || gen !== s.gen) return;
                s.mesh.material.map = tex;
                s.mesh.material.needsUpdate = true;
              });
            }
            continue;
          }
        }
      }

      if (n >= CAPACITY) continue;
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

    // 同時保留的表面貼圖數量有上限（手機記憶體較少），超過時先釋放最久沒用到的
    let loaded = 0;
    for (const s of surfaces.values()) if (s && (s.ready || s.loading)) loaded++;
    if (loaded > maxTextures) {
      const idle = [...surfaces.values()].filter((s): s is Surface => !!s && (s.ready || s.loading) && s.lastSeen < now);
      idle.sort((p, q) => p.lastSeen - q.lastSeen);
      for (const s of idle.slice(0, loaded - maxTextures)) evict(s);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <ambientLight intensity={0.05} />
      <pointLight ref={lightRef} intensity={3.4} decay={0} color="#fff6e8" />
      <mesh ref={sunRef} frustumCulled={false} material={sunMat}>
        <sphereGeometry args={[1, 64, 32]} />
      </mesh>
      <group ref={surfGroup} />
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
