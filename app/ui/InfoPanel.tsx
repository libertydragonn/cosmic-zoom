// 資訊面板：顯示被選取對象的類型、物理參數、軌道資料與資料來源。
// 資料缺漏一律顯示「無資料」，不補值。
import { useEffect, useState } from "react";
import solarSystem from "~/data/solar-system.json";
import { type Body, type Entity, getBody, getEntity } from "~/lib/bodies";
import { AU_KM, DEG } from "~/lib/constants";
import { engine } from "~/lib/engine";
import { formatDistance, formatMass, formatPeriod, sig } from "~/lib/format";
import type { GalacticEntity } from "~/lib/galaxy";
import { type MoonRecord, moonSystems } from "~/lib/moons";
import type { Region } from "~/lib/regions";
import type { StarEntity } from "~/lib/stars";
import { useUI } from "~/lib/store";
import { saturnRing, textureInfo } from "~/scene/surfaces";

/** 表面外觀的來源說明（貼圖、環、或為何沒有貼圖）。 */
function SurfaceSource({ entity }: { entity: Entity }) {
  const tex = textureInfo(entity.id);
  const lines: string[] = [];
  if (tex) {
    lines.push(`表面影像：${tex.source}${tex.observed ? `，觀測於 ${tex.observed}` : ""}。`);
    if (tex.note) lines.push(tex.note);
    if (tex.unimagedFraction && tex.unimagedFraction > 0.005)
      lines.push(`約 ${Math.round(tex.unimagedFraction * 100)}% 的表面沒有拍到，該區域是以相鄰區域推估的顏色填補，不是觀測影像。`);
    lines.push("自轉軸與本初子午線：IAU 自轉模型（NAIF pck00011）。");
  } else if (entity.id === "sun") {
    lines.push("表面外觀：以臨邊昏暗近似呈現，不是觀測影像。");
  } else if (entity.id === "venus") {
    lines.push("表面外觀：可見光下只看得到雲頂，沒有全球雲頂地圖，因此以單色顯示。");
  } else if (entity.id === "saturn-titan") {
    lines.push("表面外觀：可見光下被橘色霧霾覆蓋，以單色顯示。");
  } else if (entity.kind === "planet" || entity.kind === "dwarf" || entity.kind === "moon") {
    lines.push("表面外觀：沒有可用的全球表面影像，以單色顯示。");
  }
  if (entity.id === "saturn" && saturnRing) lines.push(`環：${saturnRing.source}；透明度與明暗由法向光學深度以單次散射近似計算，顏色為顯示用設定。`);
  if (!lines.length) return null;
  return <p className="text-[11px] leading-snug text-slate-500">{lines.join(" ")}</p>;
}

type Row = [label: string, value: string | null, note?: string];

const NA = "無資料";
const PLANET_SUBTYPE: Record<string, string> = {
  terrestrial: "類地行星",
  gasGiant: "氣態巨行星",
  iceGiant: "冰巨行星",
};
const FRAME_ZH: Record<string, string> = { ecliptic: "黃道面", equatorial: "母行星赤道面", laplace: "拉普拉斯面" };

// 由 JPL 的地球質量與 GM 得到的 G（km³ kg⁻¹ s⁻²），用來把衛星的 GM 換算成質量
const earthRec = solarSystem.planets.find((p) => p.id === "earth")!;
const G_KM = earthRec.gm! / earthRec.phys.massKg!;

const km = (v: number | null | undefined) => (v == null ? null : `${sig(v, 5)} 公里`);
const mass = (v: number | null | undefined) => (v == null ? null : formatMass(v));
const num = (v: number | null | undefined, unit = "", digits = 4) => (v == null ? null : `${sig(v, digits)}${unit}`);
const days = (v: number | null | undefined) => (v == null ? null : formatPeriod(v));

interface Phys {
  meanRadiusKm?: number | null;
  equatorialRadiusKm?: number | null;
  massKg?: number | null;
  densityGcm3?: number | null;
  rotationPeriodDays?: number | null;
  orbitalPeriodYears?: number | null;
  geometricAlbedo?: number | null;
  equatorialGravityMs2?: number | null;
  escapeVelocityKms?: number | null;
  effectiveTempK?: number | null;
}

function orbitRows(b: Body): Row[] {
  return [
    ["軌道半長軸", `${sig(b.el.a / AU_KM, 5)} AU`],
    ["軌道離心率", sig(b.el.e, 4)],
    ["軌道傾角", `${sig(b.el.i / DEG, 4)}°`, "相對黃道面"],
  ];
}

function buildRows(e: Entity): { type: string; rows: Row[]; description?: string; source: string; warn?: string } {
  if (e.kind === "sun") {
    const p = (e.data as { phys: Phys }).phys;
    return {
      type: "恆星",
      rows: [
        ["平均半徑", km(p.meanRadiusKm)],
        ["質量", mass(p.massKg)],
        ["平均密度", num(p.densityGcm3, " g/cm³")],
        ["自轉週期", days(p.rotationPeriodDays)],
        ["有效溫度", num(p.effectiveTempK, " K")],
        ["表面重力", num(p.equatorialGravityMs2, " m/s²")],
        ["逃逸速度", num(p.escapeVelocityKms, " km/s")],
        ["與銀河系中心距離", "約 2.6 萬光年"],
      ],
      source: "JPL Horizons",
    };
  }
  if (e.kind === "planet") {
    const b = e as Body;
    const d = b.data as { phys: Phys; subtype: string };
    const p = d.phys;
    const sys = moonSystems[b.id];
    return {
      type: PLANET_SUBTYPE[d.subtype] ?? "行星",
      rows: [
        ["平均半徑", km(p.meanRadiusKm)],
        ["赤道半徑", km(p.equatorialRadiusKm)],
        ["質量", mass(p.massKg)],
        ["平均密度", num(p.densityGcm3, " g/cm³")],
        ["軌道週期", p.orbitalPeriodYears == null ? null : formatPeriod(p.orbitalPeriodYears * 365.25)],
        ["自轉週期", days(p.rotationPeriodDays)],
        ...orbitRows(b),
        ["幾何反照率", num(p.geometricAlbedo)],
        ["赤道重力", num(p.equatorialGravityMs2, " m/s²")],
        ["逃逸速度", num(p.escapeVelocityKms, " km/s")],
        ["已命名衛星", sys ? `${sys.count} 顆` : "0 顆", sys?.unnamedExcluded ? `另有 ${sys.unnamedExcluded} 顆僅有臨時編號，未收錄` : undefined],
      ],
      source: "JPL Solar System Dynamics（軌道根數：Approximate Positions of the Planets；物理參數：Planetary Physical Parameters）",
    };
  }
  if (e.kind === "dwarf") {
    const b = e as Body;
    const d = b.data as { phys: Phys; status: string; designation: string; orbitClass: string | null; elements: { periodDays: number }; physSource: string };
    const p = d.phys;
    const sys = moonSystems[b.id];
    return {
      type: d.status === "dwarf" ? "矮行星" : "矮行星候選（非 IAU 正式認定）",
      rows: [
        ["小行星編號與名稱", d.designation],
        ["平均半徑", km(p.meanRadiusKm)],
        ["質量", mass(p.massKg)],
        ["平均密度", num(p.densityGcm3, " g/cm³")],
        ["軌道週期", formatPeriod(d.elements.periodDays)],
        ["自轉週期", days(p.rotationPeriodDays)],
        ...orbitRows(b),
        ["幾何反照率", num(p.geometricAlbedo)],
        ...(sys ? ([["已命名衛星", `${sys.count} 顆`]] as Row[]) : []),
      ],
      source: `軌道：JPL Small-Body Database；物理參數：${d.physSource}`,
      warn: "軌道為單一曆元的密切根數，離現在越久誤差越大。",
    };
  }
  if (e.kind === "moon") {
    const b = e as Body;
    const m = b.data as MoonRecord;
    const parent = getBody(b.parentId!)!;
    return {
      type: `${parent.zh}的衛星`,
      rows: [
        ["IAU 編號", m.iauNumber ? `${parent.en} ${m.iauNumber}` : null],
        ["平均半徑", km(m.meanRadiusKm), m.radiusSource?.includes("NAIF") ? "由 NAIF 三軸半徑換算" : undefined],
        ["質量", m.gm == null ? null : formatMass(m.gm / G_KM), m.gm == null ? undefined : "由 JPL 的 GM 換算"],
        ["平均密度", num(m.densityGcm3, " g/cm³")],
        ["軌道週期", formatPeriod(m.mean.periodDays)],
        ["軌道半長軸", km(m.mean.a)],
        ["軌道離心率", sig(m.mean.e, 3)],
        ["軌道傾角", `${sig(m.mean.i, 4)}°`, `相對${FRAME_ZH[m.mean.frame] ?? m.mean.frame}`],
        ["發現", m.discoveryYear ? `${m.discoveryYear} 年，${m.discoverer ?? "發現者無資料"}` : null],
        ...(m.provisional ? ([["臨時編號", m.provisional]] as Row[]) : []),
      ],
      source: "JPL Solar System Dynamics（衛星平均根數、物理參數、發現資料）；位置由 JPL Horizons 星曆擬合",
    };
  }
  if (e.kind === "hygstar") {
    const s = (e as StarEntity).data;
    return {
      type: "恆星",
      rows: [
        ["拜耳／佛氏編號", s.bf ? e.aliases?.[0] ?? s.bf : null],
        ["星座", s.con],
        ["與太陽距離", `${sig(s.distLy, 4)} 光年`],
        ["視星等", sig(s.mag, 3), "從地球看"],
        ["絕對星等", sig(s.absmag, 3)],
        ["光譜型", s.spect],
        ["色指數 B−V", s.ci == null ? null : sig(s.ci, 3)],
        ["星表編號", [s.hip ? `HIP ${s.hip}` : null, s.hd ? `HD ${s.hd}` : null].filter(Boolean).join("、") || null],
      ],
      source: "HYG Database v4.4（CC BY-SA 4.0）；中文名取自 Wikidata",
    };
  }
  if (e.kind === "region") {
    const r = e as Region;
    return {
      type: r.theoretical ? "理論模型（尚未被直接觀測）" : "太陽系區域",
      rows: [],
      description: r.description,
      source: r.theoretical ? "程序化生成的示意粒子" : r.id === "stellar-neighborhood" ? "HYG Database v4.4" : "JPL Small-Body Database／JPL Solar System Dynamics",
    };
  }
  const g = e as GalacticEntity;
  return { type: "銀河系結構（示意模型）", rows: [], description: g.description, source: "程序化生成的示意粒子" };
}

interface SmallBodyStats {
  mainbelt: { count: number; totalInSbdb: number; aP05AU: number; aP95AU: number };
  tno: { kuiper: { count: number; aP05AU: number; aP95AU: number }; scattered: { count: number; aP05AU: number; aP95AU: number } };
}
let statsCache: Promise<SmallBodyStats> | null = null;

function RegionStats({ id }: { id: string }) {
  const [stats, setStats] = useState<SmallBodyStats | null>(null);
  useEffect(() => {
    statsCache ??= fetch(`${import.meta.env.BASE_URL}data/smallbodies/index.json`).then((r) => r.json());
    statsCache.then(setStats).catch(() => setStats(null));
  }, []);
  if (!stats) return null;
  const fmt = new Intl.NumberFormat("zh-TW");
  const rows: Row[] =
    id === "asteroid-belt"
      ? [
          ["顯示數量", `${fmt.format(stats.mainbelt.count)} 顆`, `JPL 資料庫中主帶小行星共 ${fmt.format(stats.mainbelt.totalInSbdb)} 顆，取編號最前面的部分`],
          ["半長軸範圍", `${sig(stats.mainbelt.aP05AU, 3)}–${sig(stats.mainbelt.aP95AU, 3)} AU`, "所顯示天體的第 5 到第 95 百分位"],
        ]
      : id === "kuiper-belt"
        ? [
            ["顯示數量", `${fmt.format(stats.tno.kuiper.count)} 顆`, "JPL 資料庫中半長軸 50 AU 以內的海王星外天體"],
            ["半長軸範圍", `${sig(stats.tno.kuiper.aP05AU, 3)}–${sig(stats.tno.kuiper.aP95AU, 3)} AU`, "第 5 到第 95 百分位"],
          ]
        : id === "scattered-disc"
          ? [
              ["顯示數量", `${fmt.format(stats.tno.scattered.count)} 顆`, "JPL 資料庫中半長軸超過 50 AU 的海王星外天體"],
              ["半長軸範圍", `${sig(stats.tno.scattered.aP05AU, 3)}–${sig(stats.tno.scattered.aP95AU, 3)} AU`, "第 5 到第 95 百分位"],
            ]
          : [];
  return <Rows rows={rows} />;
}

function Rows({ rows }: { rows: Row[] }) {
  if (!rows.length) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">
      {rows.map(([label, value, note]) => (
        <div key={label} className="contents">
          <dt className="whitespace-nowrap text-slate-400">{label}</dt>
          <dd className="min-w-0 text-right tabular-nums">
            <span className={value == null ? "text-slate-500" : "text-slate-100"}>{value ?? NA}</span>
            {note && <span className="block text-[11px] leading-tight text-slate-500">{note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 即時距離（每秒更新數次）。 */
function LiveDistance({ entity }: { entity: Entity }) {
  const [text, setText] = useState("");
  useEffect(() => {
    const parent = entity.parentId ? getEntity(entity.parentId) : null;
    if (!parent || entity.kind === "region") {
      setText("");
      return;
    }
    const update = () => {
      const d = Math.hypot(entity.pos[0] - parent.pos[0], entity.pos[1] - parent.pos[1], entity.pos[2] - parent.pos[2]);
      setText(`目前與${parent.zh}距離　${formatDistance(d)}`);
    };
    update();
    const id = window.setInterval(update, 250);
    return () => window.clearInterval(id);
  }, [entity]);
  if (!text) return null;
  return <div className="rounded-md bg-sky-400/10 px-2.5 py-1.5 text-[13px] tabular-nums text-sky-100">{text}</div>;
}

export function InfoPanel() {
  const selectedId = useUI((s) => s.selectedId);
  // 衛星或恆星資料載入後重新取得對象
  useUI((s) => s.moonSystems);
  useUI((s) => s.datasets);
  const entity = selectedId ? getEntity(selectedId) : undefined;
  if (!entity) return null;
  const info = buildRows(entity);
  const { flyTo, select } = useUI.getState();
  const isTarget = (engine.fly?.toId ?? engine.targetId) === entity.id;

  return (
    <section className="panel pointer-events-auto flex max-h-full w-full flex-col overflow-hidden sm:w-80" aria-label="天體資訊">
      <header className="flex items-start justify-between gap-2 border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg leading-tight font-semibold text-white">{entity.zh}</h2>
          {entity.en !== entity.zh && <div className="truncate text-xs tracking-wide text-slate-400">{entity.en}</div>}
          <div className="mt-1 inline-block rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-slate-200">{info.type}</div>
        </div>
        <button className="btn h-7 w-7 shrink-0 p-0" onClick={() => select(null)} aria-label="關閉資訊面板">
          ✕
        </button>
      </header>
      <div className="thin-scroll flex flex-col gap-3 overflow-y-auto px-4 py-3">
        {info.description && <p className="text-[13px] leading-relaxed text-slate-200">{info.description}</p>}
        <LiveDistance entity={entity} />
        <Rows rows={info.rows} />
        {entity.kind === "region" && <RegionStats id={entity.id} />}
        {info.warn && <p className="text-[11px] leading-snug text-amber-300/90">{info.warn}</p>}
        <p className="text-[11px] leading-snug text-slate-500">資料來源：{info.source}</p>
        <SurfaceSource entity={entity} />
      </div>
      <footer className="flex gap-2 border-t border-white/10 px-4 py-2.5">
        <button className="btn btn-primary flex-1 py-1.5" onClick={() => flyTo(entity.id)}>
          {isTarget ? "重新對準" : "飛往此處"}
        </button>
      </footer>
    </section>
  );
}
