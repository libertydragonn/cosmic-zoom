import "~/lib/regions";
import Universe from "~/scene/Universe";
import { engine } from "~/lib/engine";
import { useUI } from "~/lib/store";
import { ModeToggle, ScaleBar, TimeControls, ZoomButtons, useEngineSample } from "./Hud";
import { InfoPanel } from "./InfoPanel";
import { SearchBox } from "./SearchBox";
import { Sidebar } from "./Sidebar";

/** 依目前尺度顯示的說明（理論模型、示意模型）與資料載入狀態。 */
function Notices() {
  const zone = useEngineSample(() => {
    const L = engine.logDist;
    return L > 11.0 && L < 14.3 ? "oort" : L > 15.6 ? "galaxy" : "";
  }, 300);
  const datasets = useUI((s) => s.datasets);
  const moonSystems = useUI((s) => s.moonSystems);
  const failed = [
    datasets.stars === "error" ? "恆星" : null,
    datasets.smallbodies === "error" ? "小天體" : null,
    Object.values(moonSystems).includes("error") ? "衛星" : null,
  ].filter(Boolean);
  const loading = datasets.stars === "loading" || datasets.smallbodies === "loading" || Object.values(moonSystems).includes("loading");
  return (
    <div className="pointer-events-none flex flex-col items-center gap-1.5 text-center text-[12px] leading-snug">
      {zone === "oort" && (
        <div className="panel max-w-md px-3 py-1.5 text-sky-100">
          奧爾特雲是<strong className="font-semibold">理論模型</strong>，尚未被直接觀測；畫面上的粒子僅為示意。
        </div>
      )}
      {zone === "galaxy" && (
        <div className="panel max-w-md px-3 py-1.5 text-fuchsia-100">
          銀河系的旋臂、核球與銀暈為<strong className="font-semibold">程序化生成的示意模型</strong>，不是觀測資料。
        </div>
      )}
      {loading && <div className="panel px-3 py-1 text-slate-300">資料載入中…</div>}
      {failed.length > 0 && <div className="panel px-3 py-1 text-amber-300">{failed.join("、")}資料載入失敗，請重新整理頁面再試。</div>}
    </div>
  );
}

export default function Explorer() {
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const setSidebarOpen = useUI((s) => s.setSidebarOpen);
  return (
    <main className="relative h-dvh w-full overflow-hidden bg-space">
      <Universe />

      {/* 上方：導覽按鈕、標題、搜尋 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start gap-2 p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          className="panel pointer-events-auto flex h-9 shrink-0 items-center gap-1.5 px-3 text-sm text-slate-100 hover:border-sky-300/50"
          onClick={() => setSidebarOpen(!sidebarOpen)}
          aria-expanded={sidebarOpen}
        >
          <span aria-hidden>☰</span>
          <span>導覽</span>
        </button>
        <h1 className="hidden h-9 items-center text-sm tracking-[0.2em] text-slate-300 lg:flex">天體尺度探索</h1>
        <div className="hidden flex-1 justify-center md:flex">
          <Notices />
        </div>
        <div className="pointer-events-auto ml-auto min-w-0 flex-1 md:flex-none">
          <SearchBox />
        </div>
      </div>

      {/* 手機：說明顯示在搜尋列下方 */}
      <div className="pointer-events-none absolute inset-x-3 top-14 z-10 md:hidden">
        <Notices />
      </div>

      {/* 左側：階層導覽 */}
      <div className="pointer-events-none absolute top-14 bottom-28 left-3 z-20 flex max-sm:bottom-44">
        <Sidebar />
      </div>

      {/* 右側（手機為下方）：資訊面板 */}
      <div className="pointer-events-none absolute z-10 flex items-end max-sm:inset-x-3 max-sm:bottom-44 max-sm:h-[42dvh] sm:top-14 sm:right-3 sm:bottom-28 sm:items-start">
        <InfoPanel />
      </div>

      {/* 下方：比例尺、時間、顯示模式 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-wrap items-end justify-between gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="pointer-events-auto">
          <ScaleBar />
        </div>
        <div className="pointer-events-auto max-sm:order-last max-sm:flex max-sm:w-full max-sm:justify-center">
          <TimeControls />
        </div>
        <div className="pointer-events-auto flex items-end gap-2">
          <ModeToggle />
          <div className="hidden sm:block">
            <ZoomButtons />
          </div>
        </div>
      </div>
    </main>
  );
}
