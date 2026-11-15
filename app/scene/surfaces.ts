// 天體表面：橢球幾何、表面貼圖的延遲載入、土星環、太陽的臨邊昏暗。
import * as THREE from "three";
import textureData from "~/data/textures.json";

export interface TextureInfo {
  file: string;
  width: number;
  height: number;
  hi?: { file: string; width: number; height: number };
  lat: "planetocentric" | "planetographic";
  source: string;
  url: string;
  note?: string;
  observed?: string;
  acknowledgment?: string;
  unimagedFraction?: number;
}

export interface RingInfo {
  file: string;
  innerKm: number;
  outerKm: number;
  source: string;
  url: string;
  note: string;
}

const data = textureData as unknown as {
  bodies: Record<string, TextureInfo>;
  saturnRing: RingInfo;
  missing: { body: string; reason: string }[];
};

export const textureInfo = (id: string): TextureInfo | undefined => data.bodies[id];
export const saturnRing: RingInfo = data.saturnRing;
export const textureGaps = data.missing;

const BASE = import.meta.env.BASE_URL ?? "/";

/**
 * 以「平均半徑＝1」為單位的橢球（本體座標：z＝北極，x＝東經 0°）。
 * 貼圖的 u 對應東經 −180°→180°，v 對應緯度；行星面緯度（巨行星的 Hubble 地圖）
 * 依橢球法線計算，行星中心緯度直接當方向。
 */
export function ellipsoidGeometry(
  a: number,
  c: number,
  lat: TextureInfo["lat"],
  segW = 128,
  segH = 64,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const a2 = a * a;
  const c2 = c * c;
  for (let j = 0; j <= segH; j++) {
    const phi = (Math.PI / 2) * (1 - (2 * j) / segH); // 地圖上的緯度，由北到南
    const sp = Math.sin(phi);
    const cp = Math.cos(phi);
    let rxy: number;
    let z: number;
    if (lat === "planetographic") {
      const N = a2 / Math.sqrt(a2 * cp * cp + c2 * sp * sp);
      rxy = N * cp;
      z = ((N * c2) / a2) * sp;
    } else {
      const r = (a * c) / Math.sqrt(c2 * cp * cp + a2 * sp * sp);
      rxy = r * cp;
      z = r * sp;
    }
    for (let i = 0; i <= segW; i++) {
      const lam = -Math.PI + (2 * Math.PI * i) / segW;
      const x = rxy * Math.cos(lam);
      const y = rxy * Math.sin(lam);
      pos.push(x, y, z);
      const nx = x / a2, ny = y / a2, nz = z / c2;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nor.push(nx / nl, ny / nl, nz / nl);
      uv.push(i / segW, 1 - j / segH);
    }
  }
  const row = segW + 1;
  for (let j = 0; j < segH; j++) {
    for (let i = 0; i < segW; i++) {
      const p = j * row + i;
      if (j !== 0) idx.push(p, p + row, p + 1);
      if (j !== segH - 1) idx.push(p + 1, p + row, p + row + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** 環面幾何：位於本體座標的赤道面（z＝0），u 沿半徑由內到外。單位同上（平均半徑＝1）。 */
export function ringGeometry(inner: number, outer: number, seg = 256): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const t = (2 * Math.PI * i) / seg;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pos.push(inner * c, inner * s, 0, outer * c, outer * s, 0);
    nor.push(0, 0, 1, 0, 0, 1);
    uv.push(0, 0.5, 1, 0.5);
    if (i < seg) {
      const p = i * 2;
      idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** 貼圖快取：每個檔案只下載一次；載入失敗時回傳 null。 */
const loader = new THREE.TextureLoader();
const cache = new Map<string, Promise<THREE.Texture | null>>();
export function loadTexture(file: string, anisotropy: number): Promise<THREE.Texture | null> {
  let p = cache.get(file);
  if (!p) {
    p = loader
      .loadAsync(BASE + file)
      .then((tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = anisotropy;
        tex.wrapS = THREE.RepeatWrapping;
        return tex;
      })
      .catch(() => null);
    cache.set(file, p);
  }
  return p;
}

/** 從快取移除並釋放 GPU 記憶體；下次 loadTexture 會重新下載。 */
export function releaseTexture(file: string): void {
  const p = cache.get(file);
  if (!p) return;
  cache.delete(file);
  p.then((tex) => tex?.dispose());
}

/**
 * 土星環：以掩星量得的法向光學深度 τ 做單次散射近似。
 * 貼圖 alpha 存 1 − exp(−τ)。μ0、μ 為太陽、視線與環面法線夾角的餘弦。
 *   受光面：I ∝ μ0 / (μ0 + μ) · (1 − exp(−τ(1/μ0 + 1/μ)))
 *   背光面：I ∝ μ0 / (μ0 − μ) · (exp(−τ/μ0) − exp(−τ/μ))（光穿過環後的漫射）
 *   遮蔽背景的比例：1 − exp(−τ/μ)
 * 顆粒反照率與相位函數併入常數 brightness（顯示用設定）。
 */
export function ringMaterial(color: THREE.ColorRepresentation): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null as THREE.Texture | null },
      tint: { value: new THREE.Color(color) },
      sunRel: { value: new THREE.Vector3() },
      ringNormal: { value: new THREE.Vector3(0, 0, 1) },
      brightness: { value: 1.6 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        vUv = uv;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D map;
      uniform vec3 tint;
      uniform vec3 sunRel;
      uniform vec3 ringNormal;
      uniform float brightness;
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        #include <logdepthbuf_fragment>
        float a = texture2D(map, vUv).a;
        float tau = -log(max(1.0 - a, 1e-3));
        vec3 V = normalize(-vWorld);           // 相機在原點
        vec3 L = normalize(sunRel - vWorld);
        float sv = dot(ringNormal, V);
        float sl = dot(ringNormal, L);
        float mu = max(abs(sv), 0.02);
        float mu0 = max(abs(sl), 0.005);
        float I;
        if (sv * sl > 0.0) {
          I = mu0 / (mu0 + mu) * (1.0 - exp(-tau * (1.0 / mu0 + 1.0 / mu)));
        } else {
          float d = mu0 - mu;
          I = abs(d) < 1e-3 ? (tau / mu) * exp(-tau / mu) : mu0 / d * (exp(-tau / mu0) - exp(-tau / mu));
        }
        float alpha = 1.0 - exp(-tau / mu);
        vec3 col = tint * I * brightness;
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/**
 * 太陽：以臨邊昏暗（limb darkening）呈現球體感。可見光的近似：I(μ)/I(1) = 1 − u(1 − μ)，u ≈ 0.6，
 * 並讓邊緣略偏橘。這是外觀上的近似，不是觀測影像。
 */
export function sunMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { center: { value: new THREE.Color("#fff6e0") }, limb: { value: new THREE.Color("#ffb066") } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 center;
      uniform vec3 limb;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        #include <logdepthbuf_fragment>
        float mu = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
        float I = 1.0 - 0.6 * (1.0 - mu);
        vec3 col = mix(limb, center, smoothstep(0.0, 0.8, mu)) * I;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
    toneMapped: false,
  });
}
