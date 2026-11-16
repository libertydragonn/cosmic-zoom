// 排程：每天 03:00 UTC（台灣時間 11:00）向 JPL Horizons 更新近地衛星的軌道根數，存到 Netlify Blobs。
// 網站載入地球衛星時由 satellites 函式讀取這份資料，接在內建資料後面。
import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";
import craftIndex from "../../app/data/spacecraft.json";
import { type LiveData, refreshSatellites, satSpecs } from "../lib/satellite-refresh";

export default async (req: Request) => {
  const { next_run } = (await req.json().catch(() => ({}))) as { next_run?: string };
  const store = getStore("satellites");
  const prev = (await store.get("latest", { type: "json" })) as LiveData | null;
  const data = await refreshSatellites(satSpecs(craftIndex), prev);
  if (Object.keys(data.sats).length) await store.setJSON("latest", data);
  const failed = Object.entries(data.errors);
  console.log(
    `更新 ${Object.keys(data.sats).length - failed.length} 顆衛星` +
      (failed.length ? `；失敗 ${failed.map(([id, e]) => `${id}：${e}`).join("；")}` : "") +
      (next_run ? `；下次 ${next_run}` : ""),
  );
};

export const config: Config = {
  schedule: "0 3 * * *", // 每天 03:00 UTC＝台灣時間 11:00
};
