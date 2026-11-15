// 側邊欄階層導覽：銀河系 › 太陽系 › 行星 › 衛星。
import { type ReactNode, useEffect, useState } from "react";
import solarSystem from "~/data/solar-system.json";
import { getEntity } from "~/lib/bodies";
import { galacticEntities } from "~/lib/galaxy";
import { moonNameIndex, moonSystems } from "~/lib/moons";
import { type StarEntity, loadStars } from "~/lib/stars";
import { useUI } from "~/lib/store";

const moonsByPlanet = new Map<string, typeof moonNameIndex>();
for (const m of moonNameIndex) {
  if (!moonsByPlanet.has(m.planet)) moonsByPlanet.set(m.planet, []);
  moonsByPlanet.get(m.planet)!.push(m);
}

function Node({
  id,
  zh,
  en,
  depth,
  children,
  count,
  defaultOpen = false,
}: {
  id?: string;
  zh: string;
  en?: string;
  depth: number;
  children?: ReactNode;
  count?: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const targetId = useUI((s) => s.targetId);
  const selectedId = useUI((s) => s.selectedId);
  const current = id != null && (id === selectedId || id === targetId);
  const hasChildren = children != null;
  const go = () => {
    if (!id) {
      setOpen((o) => !o);
      return;
    }
    const ui = useUI.getState();
    ui.flyTo(id);
    if (hasChildren) setOpen(true);
    if (window.innerWidth < 640) ui.setSidebarOpen(false);
  };
  return (
    <li>
      <div className="flex items-center" style={{ paddingLeft: depth * 12 }}>
        {hasChildren ? (
          <button
            className="flex h-7 w-6 shrink-0 items-center justify-center text-slate-400 hover:text-white"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? `收合${zh}` : `展開${zh}`}
            aria-expanded={open}
          >
            <span className={`inline-block text-[10px] transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
          </button>
        ) : (
          <span className="w-6 shrink-0" />
        )}
        <button
          className={`flex min-w-0 flex-1 items-baseline gap-1.5 rounded px-1.5 py-1 text-left text-[13px] ${
            current ? "bg-sky-400/20 text-white" : "text-slate-200 hover:bg-white/5"
          }`}
          onClick={go}
          aria-current={current ? "true" : undefined}
        >
          <span className="truncate">{zh}</span>
          {en && en !== zh && <span className="truncate text-[11px] text-slate-500">{en}</span>}
          {count != null && <span className="ml-auto shrink-0 text-[11px] text-slate-500">{count}</span>}
        </button>
      </div>
      {hasChildren && open && <ul>{children}</ul>}
    </li>
  );
}

function MoonList({ planetId, depth }: { planetId: string; depth: number }) {
  const moons = moonsByPlanet.get(planetId) ?? [];
  const excluded = moonSystems[planetId]?.unnamedExcluded ?? 0;
  return (
    <>
      {moons.map((m) => (
        <Node key={m.id} id={m.id} zh={m.zh ?? m.en} en={m.en} depth={depth} />
      ))}
      {excluded > 0 && (
        <li className="py-1 text-[11px] text-slate-500" style={{ paddingLeft: depth * 12 + 30 }}>
          另有 {excluded} 顆僅有臨時編號，未收錄
        </li>
      )}
    </>
  );
}

function BodyNode({ id, depth }: { id: string; depth: number }) {
  const e = getEntity(id)!;
  const sys = moonSystems[id];
  return (
    <Node id={id} zh={e.zh} en={e.en} depth={depth} count={sys?.count}>
      {sys ? <MoonList planetId={id} depth={depth + 1} /> : undefined}
    </Node>
  );
}

function NearbyStars({ depth }: { depth: number }) {
  const [stars, setStars] = useState<StarEntity[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadStars()
      .then((d) => {
        if (!live) return;
        const named = d.entities.filter((s) => s.named);
        named.sort((a, b) => a.data.distLy - b.data.distLy);
        setStars(named.slice(0, 60));
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);
  if (failed) return <li className="px-8 py-1 text-xs text-amber-300">恆星資料載入失敗</li>;
  if (!stars) return <li className="px-8 py-1 text-xs text-slate-500">載入中…</li>;
  return (
    <>
      {stars.map((s) => (
        <Node key={s.id} id={s.id} zh={s.zh} en={s.en} depth={depth} />
      ))}
      <li className="py-1 text-[11px] text-slate-500" style={{ paddingLeft: depth * 12 + 30 }}>
        依距離列出最近的 60 顆具名恆星，其餘可用搜尋
      </li>
    </>
  );
}

export function Sidebar() {
  const open = useUI((s) => s.sidebarOpen);
  const setOpen = useUI((s) => s.setSidebarOpen);
  if (!open) return null;
  const dwarfs = solarSystem.dwarfPlanets;
  return (
    <nav className="panel pointer-events-auto flex max-h-full w-72 max-w-[85vw] flex-col overflow-hidden" aria-label="階層導覽">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-sm font-medium text-slate-100">階層導覽</span>
        <button className="btn h-7 w-7 p-0" onClick={() => setOpen(false)} aria-label="關閉導覽">
          ✕
        </button>
      </div>
      <ul className="thin-scroll overflow-y-auto py-1.5 pr-1.5">
        <Node id="milky-way" zh="銀河系" en="Milky Way" depth={0} defaultOpen>
          {galacticEntities
            .filter((g) => g.id !== "milky-way")
            .map((g) => (
              <Node key={g.id} id={g.id} zh={g.zh} en={g.en} depth={1} />
            ))}
          <Node id="stellar-neighborhood" zh="鄰近恆星" en="Nearby Stars" depth={1}>
            <NearbyStars depth={2} />
          </Node>
          <Node id="solar-system" zh="太陽系" en="Solar System" depth={1} defaultOpen>
            <Node id="sun" zh="太陽" en="Sun" depth={2} />
            <Node zh="行星" en="Planets" depth={2} count={solarSystem.planets.length} defaultOpen>
              {solarSystem.planets.map((p) => (
                <BodyNode key={p.id} id={p.id} depth={3} />
              ))}
            </Node>
            <Node zh="矮行星" en="Dwarf Planets" depth={2} count={dwarfs.filter((d) => d.status === "dwarf").length}>
              {dwarfs
                .filter((d) => d.status === "dwarf")
                .map((d) => (
                  <BodyNode key={d.id} id={d.id} depth={3} />
                ))}
            </Node>
            <Node zh="矮行星候選" en="Candidates" depth={2} count={dwarfs.filter((d) => d.status !== "dwarf").length}>
              {dwarfs
                .filter((d) => d.status !== "dwarf")
                .map((d) => (
                  <BodyNode key={d.id} id={d.id} depth={3} />
                ))}
            </Node>
            <Node id="asteroid-belt" zh="小行星帶" en="Asteroid Belt" depth={2} />
            <Node id="kuiper-belt" zh="柯伊伯帶" en="Kuiper Belt" depth={2} />
            <Node id="scattered-disc" zh="離散盤" en="Scattered Disc" depth={2} />
            <Node id="oort-cloud" zh="奧爾特雲" en="Oort Cloud（理論模型）" depth={2} />
          </Node>
        </Node>
      </ul>
      <p className="border-t border-white/10 px-3 py-2 text-[11px] leading-snug text-slate-500">
        資料來源：NASA/JPL（Solar System Dynamics、Horizons、Small-Body Database）、HYG Database v4.4（CC BY-SA 4.0）、Wikidata。表面影像：USGS
        Astrogeology、NASA/JPL-Caltech/Space Science Institute（Cassini）、Hubble OPAL（NASA, ESA, A.A. Simon, M.H. Wong；CC BY 4.0）、PDS Rings Node（Voyager 2
        土星環剖面）；自轉模型：IAU／NAIF。奧爾特雲與銀河系結構為示意模型。
      </p>
    </nav>
  );
}
