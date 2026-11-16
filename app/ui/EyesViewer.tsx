// 以內嵌框架開啟 NASA Eyes on the Solar System 的探測器頁面（Eyes 官方提供嵌入功能）。
// 開啟時本頁暫停 3D 繪製（見 Universe 的 frameloop）。
import { useEffect, useMemo } from "react";
import { engine } from "~/lib/engine";
import { eyesUrl, getCraft } from "~/lib/spacecraft";
import { useUI } from "~/lib/store";

export function EyesViewer() {
  const id = useUI((s) => s.eyesCraftId);
  const close = () => useUI.getState().openEyes(null);
  const craft = id ? getCraft(id) : undefined;
  // 開啟當下的模擬時間帶入 Eyes
  const url = useMemo(() => (craft ? eyesUrl(craft, engine.jd) : ""), [craft]);

  useEffect(() => {
    if (!craft) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [craft]);

  if (!craft) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/80 p-2 sm:p-6" role="dialog" aria-modal="true" aria-label={`NASA Eyes：${craft.zh}`}>
      <div className="panel flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-white">
              {craft.zh}
              <span className="ml-2 text-xs text-slate-400">NASA Eyes on the Solar System</span>
            </div>
            <div className="truncate text-[11px] text-slate-500">由 NASA/JPL 提供的外部檢視器，時間設為本頁目前的模擬時間</div>
          </div>
          <a className="btn shrink-0" href={url} target="_blank" rel="noopener noreferrer">
            新分頁開啟
          </a>
          <button className="btn h-8 w-8 shrink-0 p-0" onClick={close} aria-label="關閉 NASA Eyes">
            ✕
          </button>
        </div>
        <iframe
          key={url}
          src={url}
          title={`NASA Eyes on the Solar System：${craft.en}`}
          className="min-h-0 w-full flex-1 border-0 bg-black"
          allow="fullscreen; xr-spatial-tracking"
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  );
}
