// UI 狀態（zustand）。每幀變動的數值在 engine 裡，這裡只放會觸發 React 重繪的狀態。
import { create } from "zustand";
import { getEntity } from "./bodies";
import { engine, jdFromDate } from "./engine";
import { loadMoonSystem, moonNameIndex } from "./moons";

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
}));

engine.onTargetChange = (id) => useUI.setState({ targetId: id });
