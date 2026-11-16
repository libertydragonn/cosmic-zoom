// UI 狀態（zustand）。每幀變動的數值在 engine 裡，這裡只放會觸發 React 重繪的狀態。
import { create } from "zustand";
import { getEntity } from "./bodies";
import { engine, jdFromDate } from "./engine";
import { loadMoonSystem, moonNameIndex } from "./moons";
import { type CraftGroup, craftLoaded, getCraft, loadSpacecraft, updateSpacecraft } from "./spacecraft";

const SHOW_CRAFT_KEY = "astro.showSpacecraft";
const HIDDEN_CRAFT_KEY = "astro.hiddenCraft";
const TRAIL_MODE_KEY = "astro.craftTrails";

/** 讀取偏好設定；無法存取（私密模式等）時回傳 null。 */
function readPref(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 無法儲存偏好時忽略
  }
}
function initialShowSpacecraft(): boolean {
  const v = readPref(SHOW_CRAFT_KEY);
  return v == null ? true : v === "1";
}
function initialHiddenCraft(): string[] {
  try {
    const v = JSON.parse(readPref(HIDDEN_CRAFT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 探測器軌跡：全部畫出，或只畫被選取／飛往的那一個。 */
export type TrailMode = "all" | "selected";

export const SPEEDS = [
  { label: "即時", rate: 1 },
  { label: "1 分鐘/秒", rate: 60 },
  { label: "1 小時/秒", rate: 3600 },
  { label: "1 日/秒", rate: 86400 },
  { label: "1 週/秒", rate: 604800 },
  { label: "1 個月/秒", rate: 2629800 },
  { label: "1 年/秒", rate: 31557600 },
  { label: "10 年/秒", rate: 315576000 },
] as const;

export type LoadState = "loading" | "ready" | "error";

interface UIState {
  selectedId: string | null;
  targetId: string;
  enlarged: boolean;
  paused: boolean;
  speedIndex: number;
  reverse: boolean;
  sidebarOpen: boolean;
  /** 各行星的衛星資料載入狀態。 */
  moonSystems: Record<string, LoadState>;
  /** 其他按需載入資料（恆星、小天體）的狀態。 */
  datasets: Record<string, LoadState>;
  /** 是否顯示人造探測器。 */
  showSpacecraft: boolean;
  /** 使用者取消勾選、不顯示的探測器。 */
  hiddenCraft: string[];
  trailMode: TrailMode;
  /** 正在以 NASA Eyes 檢視的探測器 id。 */
  eyesCraftId: string | null;

  select: (id: string | null) => void;
  flyTo: (id: string, logDist?: number) => void;
  setEnlarged: (v: boolean) => void;
  togglePause: () => void;
  setSpeedIndex: (i: number) => void;
  toggleReverse: () => void;
  resetTime: () => void;
  setSidebarOpen: (v: boolean) => void;
  setMoonSystem: (planetId: string, s: LoadState) => void;
  setDataset: (name: string, s: LoadState) => void;
  setShowSpacecraft: (v: boolean) => void;
  setCraftVisible: (id: string, visible: boolean) => void;
  setHiddenCraft: (ids: string[]) => void;
  setTrailMode: (m: TrailMode) => void;
  openEyes: (id: string | null) => void;
}

/** 下載探測器資料：deep 記在 datasets.spacecraft、earth（地球衛星）記在 datasets.satellites。 */
export function ensureSpacecraft(group: CraftGroup = "deep"): Promise<void> {
  return loadSpacecraft(group, (s) => useUI.getState().setDataset(group === "deep" ? "spacecraft" : "satellites", s));
}

function applyRate(speedIndex: number, reverse: boolean) {
  engine.rate = SPEEDS[speedIndex].rate * (reverse ? -1 : 1);
}

export const useUI = create<UIState>((set, get) => ({
  selectedId: null,
  targetId: engine.targetId,
  enlarged: engine.enlarged,
  paused: engine.paused,
  speedIndex: 0,
  reverse: false,
  sidebarOpen: false,
  moonSystems: {},
  datasets: {},
  showSpacecraft: initialShowSpacecraft(),
  hiddenCraft: initialHiddenCraft(),
  trailMode: readPref(TRAIL_MODE_KEY) === "all" ? "all" : "selected",
  eyesCraftId: null,

  select: (id) => set({ selectedId: id }),
  flyTo: (id, logDist) => {
    if (!getEntity(id)) {
      // 尚未載入的衛星：先下載該行星的衛星資料再飛過去
      const moon = moonNameIndex.find((m) => m.id === id);
      if (!moon) return;
      void loadMoonSystem(moon.planet, (s) => get().setMoonSystem(moon.planet, s)).then(() => {
        if (getEntity(id)) get().flyTo(id, logDist);
      });
      return;
    }
    const craft = getCraft(id);
    if (craft && !craftLoaded(craft)) {
      // 尚未下載軌跡的探測器：先開啟顯示並下載，再飛過去
      get().setShowSpacecraft(true);
      void ensureSpacecraft(craft.rec.group).then(() => {
        updateSpacecraft(engine.jd);
        get().flyTo(id, logDist);
      });
      return;
    }
    if (craft) {
      get().setShowSpacecraft(true);
      get().setCraftVisible(id, true); // 從搜尋或導覽飛往被隱藏的探測器時重新顯示
    }
    engine.flyTo(id, logDist);
    set({ selectedId: id });
  },
  setEnlarged: (v) => {
    engine.enlarged = v;
    set({ enlarged: v });
  },
  togglePause: () => {
    engine.paused = !engine.paused;
    set({ paused: engine.paused });
  },
  setSpeedIndex: (i) => {
    const speedIndex = Math.min(SPEEDS.length - 1, Math.max(0, i));
    applyRate(speedIndex, get().reverse);
    set({ speedIndex });
  },
  toggleReverse: () => {
    const reverse = !get().reverse;
    applyRate(get().speedIndex, reverse);
    set({ reverse });
  },
  resetTime: () => {
    engine.jd = jdFromDate(new Date());
    engine.paused = false;
    applyRate(0, false);
    set({ speedIndex: 0, reverse: false, paused: false });
  },
  setSidebarOpen: (v) => set({ sidebarOpen: v }),
  setMoonSystem: (planetId, s) => set((st) => ({ moonSystems: { ...st.moonSystems, [planetId]: s } })),
  setDataset: (name, s) => set((st) => ({ datasets: { ...st.datasets, [name]: s } })),
  setShowSpacecraft: (v) => {
    writePref(SHOW_CRAFT_KEY, v ? "1" : "0");
    if (v) void ensureSpacecraft().catch(() => {});
    set({ showSpacecraft: v });
  },
  setCraftVisible: (id, visible) => {
    const hidden = get().hiddenCraft.filter((x) => x !== id);
    if (!visible) hidden.push(id);
    get().setHiddenCraft(hidden);
  },
  setHiddenCraft: (ids) => {
    if (ids.length === get().hiddenCraft.length && ids.every((x) => get().hiddenCraft.includes(x))) return;
    writePref(HIDDEN_CRAFT_KEY, JSON.stringify(ids));
    set({ hiddenCraft: ids });
  },
  setTrailMode: (m) => {
    writePref(TRAIL_MODE_KEY, m);
    set({ trailMode: m });
  },
  openEyes: (id) => set({ eyesCraftId: id }),
}));

// 預設顯示時，頁面載入後就下載軌跡
if (typeof window !== "undefined" && useUI.getState().showSpacecraft) void ensureSpacecraft().catch(() => {});

engine.onTargetChange = (id) => useUI.setState({ targetId: id });
