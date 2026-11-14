import { lazy, Suspense } from "react";
import type { Route } from "./+types/home";

const Explorer = lazy(() => import("../ui/Explorer"));

export function meta({}: Route.MetaArgs) {
  return [
    { title: "天體尺度探索｜從衛星到銀河系" },
    { name: "description", content: "可連續縮放的 3D 天體地圖：從單一衛星、太陽系、鄰近恆星一路到整個銀河系。" },
  ];
}

export default function Home() {
  return (
    <Suspense fallback={<div className="flex h-dvh items-center justify-center text-sm tracking-widest text-slate-400">載入中…</div>}>
      <Explorer />
    </Suspense>
  );
}
