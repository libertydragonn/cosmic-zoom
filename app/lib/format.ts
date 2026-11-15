import { AU_KM, LY_KM } from "./constants";
import { dateFromJd } from "./engine";

const nf = (digits: number) => new Intl.NumberFormat("zh-TW", { maximumFractionDigits: digits });

function sig(v: number, digits = 3): string {
  if (v === 0) return "0";
  const mag = Math.floor(Math.log10(Math.abs(v)));
  const decimals = Math.max(0, digits - 1 - mag);
  return nf(Math.min(decimals, 6)).format(v);
}

/** 依大小自動選擇 公里 → AU → 光年。 */
export function formatDistance(km: number): string {
  const a = Math.abs(km);
  if (a < 5e6) {
    if (a >= 1e4) return `${sig(km / 1e4)} 萬公里`;
    return `${sig(km)} 公里`;
  }
  if (a < 0.1 * LY_KM) return `${sig(km / AU_KM)} AU`;
  const ly = km / LY_KM;
  if (Math.abs(ly) >= 1e4) return `${sig(ly / 1e4)} 萬光年`;
  return `${sig(ly)} 光年`;
}

/** 比例尺：給定每像素代表的 km，回傳一段「整數」長度與其像素寬度。 */
export function scaleBar(kmPerPx: number, targetPx = 120): { px: number; label: string } {
  const km = kmPerPx * targetPx;
  let unit = 1;
  let name = "公里";
  if (km >= 0.1 * LY_KM) {
    unit = LY_KM;
    name = "光年";
  } else if (km >= 5e6) {
    unit = AU_KM;
    name = "AU";
  }
  const v = km / unit;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  const nice = (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
  let label: string;
  if (name === "公里" && nice >= 1e4) label = `${nf(2).format(nice / 1e4)} 萬公里`;
  else if (name === "光年" && nice >= 1e4) label = `${nf(2).format(nice / 1e4)} 萬光年`;
  else label = `${nf(nice < 1 ? 4 : 0).format(nice)} ${name}`;
  return { px: (nice * unit) / kmPerPx, label };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatJd(jd: number, withTime: boolean): string {
  const d = dateFromJd(jd);
  if (Number.isNaN(d.getTime())) return `JD ${jd.toFixed(1)}`;
  const y = d.getFullYear();
  const year = y > 0 ? `${y} 年` : `西元前 ${1 - y} 年`;
  const date = `${year} ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return withTime ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : date;
}

/** 手機版用的精簡日期：2026/11/15 13:06:44；西元前以「前」標示。 */
export function formatJdShort(jd: number, withTime: boolean): string {
  const d = dateFromJd(jd);
  if (Number.isNaN(d.getTime())) return `JD ${jd.toFixed(1)}`;
  const y = d.getFullYear();
  const date = `${y > 0 ? y : `前${1 - y}`}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return withTime ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : date;
}

export function formatMass(kg: number): string {
  const e = Math.floor(Math.log10(kg));
  const m = kg / 10 ** e;
  return `${m.toFixed(3)} × 10^${e} 公斤`;
}

export function formatPeriod(days: number): string {
  const a = Math.abs(days);
  const sign = days < 0 ? "（逆行）" : "";
  if (a < 2) return `${sig(a * 24, 4)} 小時${sign}`;
  if (a < 730) return `${sig(a, 4)} 日${sign}`;
  return `${sig(a / 365.25, 4)} 年${sign}`;
}

export { sig };
