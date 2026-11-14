// 鄰近恆星（HYG v4.4）。資料在背景下載；有名稱或拜耳／佛氏編號的恆星會登錄為可搜尋、可飛往的對象。
import { type Entity, registerEntity } from "./bodies";
import { LY_KM } from "./constants";

export interface StarRecord {
  /** stars.bin 內的索引。 */
  i: number;
  en: string | null;
  zh: string | null;
  bf: string | null;
  con: string | null;
  hip: number | null;
  hd: number | null;
  mag: number;
  absmag: number;
  spect: string | null;
  ci: number | null;
  distLy: number;
}

export interface StarEntity extends Entity {
  kind: "hygstar";
  data: StarRecord;
  /** 是否有專名（會顯示標籤）。 */
  named: boolean;
}

export interface StarData {
  /** 每顆 5 個值：x, y, z（光年，J2000 黃道，日心）、絕對星等、B−V。 */
  buffer: Float32Array;
  count: number;
  meta: { source: string; license: string; retrievedAt: string; selection: string; count: number };
  entities: StarEntity[];
}

const GREEK: Record<string, string> = {
  Alp: "α", Bet: "β", Gam: "γ", Del: "δ", Eps: "ε", Zet: "ζ", Eta: "η", The: "θ", Iot: "ι", Kap: "κ", Lam: "λ", Mu: "μ",
  Nu: "ν", Xi: "ξ", Omi: "ο", Pi: "π", Rho: "ρ", Sig: "σ", Tau: "τ", Ups: "υ", Phi: "φ", Chi: "χ", Psi: "ψ", Ome: "ω",
};

/** HYG 的拜耳／佛氏編號（如 "9Alp CMa"、"Gam2Vel"）轉成較好讀的形式（"α CMa"、"γ² Vel"）。 */
export function formatBayer(bf: string): string {
  const m = bf.match(/^(\d+)?\s*([A-Za-z]{2,3})?\s*(\d)?\s*([A-Za-z]{3})$/);
  if (!m) return bf.replace(/\s+/g, " ");
  const [, flam, greek, sup, con] = m;
  if (greek && GREEK[greek]) {
    const supers = ["", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];
    return `${GREEK[greek]}${sup ? supers[Number(sup)] : ""} ${con}`;
  }
  return `${flam ?? ""}${greek ? " " + greek : ""} ${con}`.trim();
}

let promise: Promise<StarData> | null = null;

export function loadStars(): Promise<StarData> {
  promise ??= (async () => {
    const base = `${import.meta.env.BASE_URL}data/stars/`;
    const [binRes, jsonRes] = await Promise.all([fetch(base + "stars.bin"), fetch(base + "stars.json")]);
    if (!binRes.ok || !jsonRes.ok) throw new Error(`HTTP ${binRes.status}/${jsonRes.status}`);
    const buffer = new Float32Array(await binRes.arrayBuffer());
    const json = (await jsonRes.json()) as StarData["meta"] & { stars: StarRecord[] };
    const entities: StarEntity[] = [];
    for (const s of json.stars) {
      const o = s.i * 5;
      const designation = s.bf ? formatBayer(s.bf) : null;
      const en = s.en ?? designation ?? (s.hip ? `HIP ${s.hip}` : `HYG ${s.i}`);
      const e: StarEntity = {
        id: `star-${s.i}`,
        zh: s.zh ?? en,
        en,
        kind: "hygstar",
        pos: new Float64Array([buffer[o] * LY_KM, buffer[o + 1] * LY_KM, buffer[o + 2] * LY_KM]),
        radiusKm: null,
        parentId: null,
        viewLogDist: Math.log10(0.4 * LY_KM),
        // 恆星是以 float32 存放的點，拉得太近會看出精度誤差，所以限制最小距離
        minLogDist: Math.log10(0.02 * LY_KM),
        aliases: [designation, s.bf, s.hip ? `HIP ${s.hip}` : null, s.hd ? `HD ${s.hd}` : null].filter(
          (x): x is string => !!x,
        ),
        data: s,
        named: !!s.en,
      };
      registerEntity(e);
      entities.push(e);
    }
    return {
      buffer,
      count: buffer.length / 5,
      meta: { source: json.source, license: json.license, retrievedAt: json.retrievedAt, selection: json.selection, count: json.count },
      entities,
    };
  })();
  promise.catch(() => {
    promise = null;
  });
  return promise;
}
