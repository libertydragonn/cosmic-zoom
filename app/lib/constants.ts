import solarSystem from "~/data/solar-system.json";

export const DEG = Math.PI / 180;

/** 天文單位（km），取自 JPL Horizons。 */
export const AU_KM: number = solarSystem.constants.auKm;
/** 光速（km/s），SI 定義值。 */
export const C_KM_S = 299792.458;
/** 光年（km）＝光在一儒略年（365.25 日）行進的距離，IAU 定義。 */
export const LY_KM = C_KM_S * 86400 * 365.25;
/** 秒差距（km）＝ 648000/π au，IAU 2015 決議 B2。 */
export const PC_KM = (AU_KM * 648000) / Math.PI;
export const KLY_KM = LY_KM * 1000;

/** J2000 黃赤交角（弧度），取自 JPL approx_pos 頁。 */
export const OBLIQUITY = solarSystem.constants.obliquityDeg * DEG;

export const J2000_JD = 2451545.0;
export const DAYS_PER_YEAR = 365.25;
export const SECONDS_PER_DAY = 86400;

/** 各分層場景使用的單位（1 單位＝多少 km）。 */
export const LAYER_UNIT_KM = {
  planetary: 1,
  solar: AU_KM,
  stellar: LY_KM,
  galaxy: KLY_KM,
} as const;
export type LayerName = keyof typeof LAYER_UNIT_KM;

/** 相機距離（log10 km）的可縮放範圍：約 10 km 到 20 萬光年。 */
export const MIN_LOG_DIST = 1;
export const MAX_LOG_DIST = Math.log10(200 * KLY_KM);
