// 繁體中文名稱。這些是語言層面的譯名，不是觀測資料：
// - 太陽與八大行星：通用中文名。
// - 五顆 IAU 矮行星：依專案需求文件指定的名稱。
// - 矮行星候選：Wikidata 條目（Q15586、Q6587、Q15610、Q15603）的中文標籤，轉為繁體。
// - 衛星：依中文天文學慣例，由「行星字頭 + IAU 編號」組成（例：Jupiter I → 木衛一），
//   IAU 編號取自 JPL 衛星發現資料表，見 fetch-moons.mjs。
export const ZH_BODY = {
  Sun: "太陽",
  Mercury: "水星",
  Venus: "金星",
  Earth: "地球",
  Mars: "火星",
  Jupiter: "木星",
  Saturn: "土星",
  Uranus: "天王星",
  Neptune: "海王星",
  Ceres: "穀神星",
  Pluto: "冥王星",
  Eris: "鬩神星",
  Haumea: "妊神星",
  Makemake: "鳥神星",
  Quaoar: "創神星",
  Gonggong: "共工星",
  Sedna: "賽德娜",
  Orcus: "亡神星",
};

/** 衛星中文名字頭。地球的衛星只有月球，不走編號規則。 */
export const ZH_MOON_PREFIX = {
  Mars: "火衛",
  Jupiter: "木衛",
  Saturn: "土衛",
  Uranus: "天衛",
  Neptune: "海衛",
  Pluto: "冥衛",
};

const DIGITS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 1–999 的中文數字（十一、二十三、一百零五、一百一十二）。 */
export function zhNumber(n) {
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new Error(`zhNumber 超出範圍: ${n}`);
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const u = n % 10;
  let s = "";
  if (h) s += DIGITS[h] + "百";
  if (t) s += (t === 1 && !h ? "" : DIGITS[t]) + "十";
  else if (h && u) s += "零";
  if (u) s += DIGITS[u];
  return s;
}

export function romanToInt(roman) {
  const map = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  const s = roman.trim().toUpperCase();
  if (!/^[IVXLCDM]+$/.test(s)) return null;
  for (let i = 0; i < s.length; i++) {
    const v = map[s[i]];
    const next = map[s[i + 1]] ?? 0;
    total += v < next ? -v : v;
  }
  return total;
}
