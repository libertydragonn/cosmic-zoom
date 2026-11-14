// 「區域」型對象：小行星帶、柯伊伯帶、離散盤、奧爾特雲。它們沒有單一位置，
// 飛往時以太陽為焦點、拉到能看見整個區域的距離。
import { type Entity, getBody, registerEntity } from "./bodies";
import { AU_KM, DEG, LY_KM } from "./constants";

export interface Region extends Entity {
  kind: "region";
  /** 標籤錨點（日心黃道座標，km）。 */
  anchor: Float64Array;
  /** 區域的代表半徑（km），用來判斷標籤何時顯示。 */
  sizeKm: number;
  /** 是否為理論模型（未被直接觀測）。 */
  theoretical: boolean;
  description: string;
}

function anchor(rAU: number, lonDeg: number, latDeg: number): Float64Array {
  const r = rAU * AU_KM;
  const lat = latDeg * DEG;
  return new Float64Array([
    r * Math.cos(lat) * Math.cos(lonDeg * DEG),
    r * Math.cos(lat) * Math.sin(lonDeg * DEG),
    r * Math.sin(lat),
  ]);
}

/** 奧爾特雲模型範圍（AU），依專案需求設定。 */
export const OORT_INNER_AU = 2000;
export const OORT_OUTER_AU = 100000;

const sunPos = getBody("sun")!.pos;

function region(init: {
  id: string;
  zh: string;
  en: string;
  viewAU: number;
  anchor: Float64Array;
  sizeAU: number;
  theoretical?: boolean;
  description: string;
}): Region {
  const r: Region = {
    id: init.id,
    zh: init.zh,
    en: init.en,
    kind: "region",
    pos: sunPos,
    radiusKm: null,
    parentId: "sun",
    viewLogDist: Math.log10(init.viewAU * AU_KM),
    minLogDist: 6,
    anchor: init.anchor,
    sizeKm: init.sizeAU * AU_KM,
    theoretical: init.theoretical ?? false,
    description: init.description,
  };
  registerEntity(r);
  return r;
}

export const regions: Region[] = [
  // 以下兩個只是導覽用的視角（不顯示標籤）
  region({
    id: "solar-system",
    zh: "太陽系",
    en: "Solar System",
    viewAU: 85,
    anchor: anchor(0, 0, 0),
    sizeAU: 0,
    description: "太陽與受其重力束縛的所有天體：八大行星、矮行星、衛星、小行星帶、柯伊伯帶、離散盤，以及理論上存在的奧爾特雲。",
  }),
  region({
    id: "stellar-neighborhood",
    zh: "鄰近恆星",
    en: "Stellar Neighborhood",
    viewAU: (60 * LY_KM) / AU_KM,
    anchor: anchor(0, 0, 0),
    sizeAU: 0,
    description: "太陽周圍的恆星。資料取自 HYG v4.4 星表：收錄肉眼可見（視星等 6.5 以內）或距離 25 秒差距以內的恆星，位置為真實的三維座標。",
  }),
  region({
    id: "asteroid-belt",
    zh: "小行星帶",
    en: "Asteroid Belt",
    viewAU: 9,
    anchor: anchor(3.0, 135, 0),
    sizeAU: 2.7,
    description: "位於火星與木星軌道之間的小天體帶。畫面上的每一點都是一顆真實小行星，位置由 JPL 小天體資料庫的軌道根數計算。",
  }),
  region({
    id: "kuiper-belt",
    zh: "柯伊伯帶",
    en: "Kuiper Belt",
    viewAU: 140,
    anchor: anchor(46, 70, 0),
    sizeAU: 44,
    description: "海王星軌道外、距太陽約 30–50 AU 的冰質小天體帶，冥王星、妊神星、鳥神星都在其中。畫面上的每一點都是一顆已知的海王星外天體。",
  }),
  region({
    id: "scattered-disc",
    zh: "離散盤",
    en: "Scattered Disc",
    viewAU: 600,
    anchor: anchor(120, 300, 12),
    sizeAU: 110,
    description: "軌道離心率與傾角都偏大的海王星外天體，遠日點可達數百 AU 以上，鬩神星是其中最大的成員。這裡把半長軸超過 50 AU 的已知海王星外天體歸在此區。",
  }),
  region({
    id: "oort-cloud",
    zh: "奧爾特雲（理論模型）",
    en: "Oort Cloud",
    viewAU: 260000,
    anchor: anchor(52000, 40, 38),
    sizeAU: 50000,
    theoretical: true,
    description:
      "包圍太陽系的球殼狀冰質小天體雲，推測範圍約 2,000–100,000 AU，被認為是長週期彗星的來源。奧爾特雲是理論模型，至今尚未被直接觀測；畫面上的粒子是依球殼範圍隨機生成的示意，不代表真實天體。",
  }),
];
