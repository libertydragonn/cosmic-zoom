// 畫面下方的常駐資訊：比例尺、時間控制、顯示模式切換。
import { useEffect, useState } from "react";
import { getEntity, planetElementsOutOfRange } from "~/lib/bodies";
import { engine } from "~/lib/engine";
import { formatDistance, formatJd, scaleBar } from "~/lib/format";
import { SPEEDS, useUI } from "~/lib/store";

/** 以固定頻率讀取引擎狀態（引擎每幀變動，不直接驅動 React）。 */
export function useEngineSample<T>(read: () => T, ms = 120): T {
  const [value, setValue] = useState(read);
  useEffect(() => {
    const id = window.setInterval(() => setValue(read()), ms);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms]);
  return value;
}

export function ScaleBar() {
  const s = useEngineSample(() => {
    const bar = scaleBar(engine.dist / engine.pxPerRad, engine.width < 640 ? 84 : 120);
    const id = engine.fly ? engine.fly.toId : engine.targetId;
    return `${bar.px.toFixed(1)}|${bar.label}|${formatDistance(engine.dist)}|${getEntity(id)?.zh ?? ""}`;
  });
  const [px, label, dist, target] = s.split("|");
  return (
    <div className="panel pointer-events-none px-3 py-2 text-xs">
      <div className="mb-1 text-[11px] text-slate-400">
        距{target}　<span className="tabular-nums text-slate-200">{dist}</span>
      </div>
      <div className="flex items-end gap-2">
        <div
          className="h-2 border-x border-b border-sky-300/90"
          style={{ width: `${px}px`, transition: "width 120ms linear" }}
        />
        <span className="tabular-nums leading-none text-sky-100">{label}</span>
      </div>
    </div>
  );
}

export function TimeControls() {
  const paused = useUI((s) => s.paused);
  const speedIndex = useUI((s) => s.speedIndex);
  const reverse = useUI((s) => s.reverse);
  const { togglePause, setSpeedIndex, toggleReverse, resetTime } = useUI.getState();
  const withTime = speedIndex <= 2;
  const info = useEngineSample(() => `${formatJd(engine.jd, withTime)}|${planetElementsOutOfRange(engine.jd) ? 1 : 0}`, 100);
  const [date, outOfRange] = info.split("|");

  return (
    <div className="panel flex flex-col items-center gap-1.5 px-3 py-2">
      <div className="tabular-nums text-[13px] text-slate-100" aria-live="off">
        {date}
      </div>
      {outOfRange === "1" && (
        <div className="max-w-64 text-center text-[11px] leading-tight text-amber-300">
          已超出 JPL 行星近似根數的適用範圍（西元前 3000 年至西元 3000 年），位置僅供參考
        </div>
      )}
      <div className="flex items-center gap-1">
        <button className="btn" onClick={toggleReverse} aria-pressed={reverse} title="倒轉時間">
          {reverse ? "◀ 倒轉" : "▶ 順行"}
        </button>
        <button className="btn" onClick={() => setSpeedIndex(speedIndex - 1)} disabled={speedIndex === 0} aria-label="減速">
          −
        </button>
        <button className="btn btn-primary w-16" onClick={togglePause} aria-pressed={paused}>
          {paused ? "繼續" : "暫停"}
        </button>
        <button
          className="btn"
          onClick={() => setSpeedIndex(speedIndex + 1)}
          disabled={speedIndex === SPEEDS.length - 1}
          aria-label="加速"
        >
          +
        </button>
        <button className="btn" onClick={resetTime} title="回到現在">
          現在
        </button>
      </div>
      <div className="text-[11px] text-slate-400">
        時間速度：<span className="text-slate-200">{paused ? "已暫停" : SPEEDS[speedIndex].label}</span>
      </div>
    </div>
  );
}

export function ModeToggle() {
  const enlarged = useUI((s) => s.enlarged);
  const setEnlarged = useUI((s) => s.setEnlarged);
  return (
    <div className="panel flex flex-col gap-1 p-1.5 text-xs">
      <div className="flex gap-1" role="group" aria-label="天體顯示比例">
        <button className={`btn ${enlarged ? "btn-on" : ""}`} onClick={() => setEnlarged(true)} aria-pressed={enlarged}>
          放大顯示
        </button>
        <button className={`btn ${!enlarged ? "btn-on" : ""}`} onClick={() => setEnlarged(false)} aria-pressed={!enlarged}>
          真實比例
        </button>
      </div>
      {!enlarged && <div className="max-w-44 px-1 pb-0.5 text-[11px] leading-tight text-slate-400">真實比例下，行星與衛星遠看時小到看不見，需拉近才會出現。</div>}
    </div>
  );
}

export function ZoomButtons() {
  return (
    <div className="panel flex flex-col gap-1 p-1.5">
      <button className="btn h-8 w-8 text-base" onClick={() => engine.zoomBy(-0.5)} aria-label="拉近">
        +
      </button>
      <button className="btn h-8 w-8 text-base" onClick={() => engine.zoomBy(0.5)} aria-label="拉遠">
        −
      </button>
    </div>
  );
}
