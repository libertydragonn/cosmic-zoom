// 銀河系圖層（單位：千光年，原點在銀心）。旋臂、核球、銀暈皆為程序化生成的粒子。
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { getBody } from "~/lib/bodies";
import { KLY_KM } from "~/lib/constants";
import { engine } from "~/lib/engine";
import { GALACTIC_BASIS, GALACTIC_CENTER_KM, galacticEntities, generateGalaxy } from "~/lib/galaxy";
import { addLabelProvider, nextCandidate } from "./labels";

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
uniform float uPxPerUnit; // 距離 1 單位處，1 單位長度對應的像素數
uniform float uMinPx;
uniform float uMaxPx;
uniform float uOpacity;
varying vec4 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(length(mv.xyz), 1e-6);
  gl_Position = projectionMatrix * mv;
  float px = aSize / d * uPxPerUnit;
  gl_PointSize = clamp(px, uMinPx, uMaxPx);
  // 點小於最小尺寸時改以降低透明度表現，貼近相機的粒子淡出
  float a = clamp(px / uMinPx, 0.25, 1.0) * smoothstep(0.03, 0.8, d);
  vColor = vec4(aColor, a * uOpacity);
}`;

const FRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0 || vColor.a <= 0.002) discard;
  float f = smoothstep(1.0, 0.0, d);
  gl_FragColor = vec4(vColor.rgb, vColor.a * f * f);
}`;

export function GalaxyLayer() {
  const pointsRef = useRef<THREE.Points>(null);
  const mobile = typeof window !== "undefined" && window.innerWidth < 768;
  const geometry = useMemo(() => {
    const p = generateGalaxy(mobile ? 90000 : 240000);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p.position, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(p.color, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(p.size, 1));
    return g;
  }, [mobile]);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uPxPerUnit: { value: 1 },
          uMinPx: { value: 1.2 },
          uMaxPx: { value: 24 },
          uOpacity: { value: 0.3 },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );
  // 銀河座標 → 黃道座標的旋轉（固定不變）
  const rotation = useMemo(() => {
    const { x, y, z } = GALACTIC_BASIS;
    const m = new THREE.Matrix4().set(x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, 0, 0, 0, 1);
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }, []);

  useEffect(
    () =>
      addLabelProvider(() => {
        const L = engine.logDist;
        const scr = [0, 0, 0];
        for (const e of galacticEntities) {
          if (L < e.labelRange[0] || L > e.labelRange[1]) continue;
          if (!engine.project(e.pos, scr)) continue;
          const c = nextCandidate();
          c.id = e.id;
          c.zh = e.zh;
          c.en = e.en;
          c.x = scr[0];
          c.y = scr[1];
          c.r = 0;
          c.cls = "lbl-galactic";
          c.priority = e.id === "milky-way" || e.id === "galactic-center" ? 760 : 720;
        }
        // 銀河系尺度時標示太陽（太陽系）所在位置
        if (L > 16.4) {
          const sun = getBody("sun")!;
          if (engine.project(sun.pos, scr)) {
            const c = nextCandidate();
            c.id = "sun";
            c.zh = "太陽系位置";
            c.en = "Solar System";
            c.x = scr[0];
            c.y = scr[1];
            c.r = 5;
            c.cls = "lbl-sunmark";
            c.priority = 950;
          }
        }
      }),
    [],
  );

  useFrame(({ gl }) => {
    const pts = pointsRef.current;
    if (!pts) return;
    const cam = engine.camPos;
    // 銀心相對相機的位置：float64 相減後才交給 three（轉成 float32）
    pts.position.set(
      (GALACTIC_CENTER_KM[0] - cam[0]) / KLY_KM,
      (GALACTIC_CENTER_KM[1] - cam[1]) / KLY_KM,
      (GALACTIC_CENTER_KM[2] - cam[2]) / KLY_KM,
    );
    pts.quaternion.copy(rotation);
    const L = engine.logDist;
    const dpr = gl.getPixelRatio();
    const outside = smoothstep(14.6, 16.4, L); // 0＝身在銀河系內看天空，1＝從外面看整個星系
    const u = material.uniforms;
    u.uPxPerUnit.value = engine.pxPerRad * dpr;
    u.uMinPx.value = 1.2 * dpr;
    u.uMaxPx.value = (2.6 + 22 * outside) * dpr;
    u.uOpacity.value = 0.16 + 0.2 * outside;
  });

  return <points ref={pointsRef} geometry={geometry} material={material} frustumCulled={false} />;
}
