// 搜尋框：輸入中文或英文名稱，選取後飛往該天體。
// 尚未下載的衛星也搜得到（名稱索引在啟動時就載入），選取時才下載該行星的衛星資料。
import { useEffect, useMemo, useRef, useState } from "react";
import { type EntityKind, entities, getEntity } from "~/lib/bodies";
import { moonNameIndex } from "~/lib/moons";
import { useUI } from "~/lib/store";

interface Hit {
  id: string;
  zh: string;
  en: string;
  kind: EntityKind;
  hint: string;
  score: number;
}

const KIND_LABEL: Record<EntityKind, string> = {
  sun: "恆星",
  planet: "行星",
  dwarf: "矮行星",
  moon: "衛星",
  region: "區域",
  hygstar: "恆星",
  galactic: "銀河系",
};
const KIND_RANK: Record<EntityKind, number> = { sun: 0, planet: 1, dwarf: 2, galactic: 3, region: 3, moon: 4, hygstar: 5 };

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ\s]/g, "");

function matchScore(q: string, text: string): number {
  const t = norm(text);
  if (!t) return -1;
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.includes(q)) return 2;
  return -1;
}

function search(query: string): Hit[] {
  const q = norm(query);
  if (!q) return [];
  const hits: Hit[] = [];
  const consider = (id: string, zh: string, en: string, kind: EntityKind, hint: string, aliases?: string[]) => {
    let best = -1;
    for (const text of [zh, en, ...(aliases ?? [])]) {
      const s = matchScore(q, text);
      if (s >= 0 && (best < 0 || s < best)) best = s;
    }
    if (best >= 0) hits.push({ id, zh, en, kind, hint, score: best * 10 + KIND_RANK[kind] });
  };
  for (const e of entities.values()) {
    const parent = e.kind === "moon" && e.parentId ? getEntity(e.parentId)?.zh : null;
    consider(e.id, e.zh, e.en, e.kind, parent ? `${parent}的衛星` : KIND_LABEL[e.kind], e.aliases);
  }
  // 尚未載入的衛星
  for (const m of moonNameIndex) {
    if (entities.has(m.id)) continue;
    const parent = getEntity(m.planet)?.zh ?? m.planet;
    consider(m.id, m.zh ?? m.en, m.en, "moon", `${parent}的衛星`);
  }
  hits.sort((a, b) => a.score - b.score || a.en.length - b.en.length);
  return hits.slice(0, 12);
}

export function SearchBox() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // 資料載入後重新搜尋，讓新加入的恆星與衛星出現在結果中
  const datasets = useUI((s) => s.datasets);
  const moonSystems = useUI((s) => s.moonSystems);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const hits = useMemo(() => search(query), [query, datasets, moonSystems]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, []);

  const choose = (hit: Hit) => {
    useUI.getState().flyTo(hit.id);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  };

  const showList = open && query.trim() !== "";
  return (
    <div ref={boxRef} className="relative w-full sm:w-72">
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls="search-results"
        aria-label="搜尋天體"
        placeholder="搜尋天體（中文或英文）"
        className="panel h-9 w-full px-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-300/60 focus:outline-none"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(hits.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter" && hits[active]) {
            e.preventDefault();
            choose(hits[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
      />
      {showList && (
        <ul id="search-results" role="listbox" className="panel thin-scroll absolute inset-x-0 top-10 z-30 max-h-80 overflow-y-auto py-1">
          {hits.length === 0 && <li className="px-3 py-2 text-sm text-slate-400">找不到符合「{query}」的天體</li>}
          {hits.map((h, i) => (
            <li key={h.id} role="option" aria-selected={i === active}>
              <button
                className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm ${i === active ? "bg-sky-400/20" : "hover:bg-white/5"}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(h)}
              >
                <span className="truncate text-slate-100">{h.zh}</span>
                {h.en !== h.zh && <span className="truncate text-xs text-slate-400">{h.en}</span>}
                <span className="ml-auto shrink-0 text-[11px] text-slate-500">{h.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
