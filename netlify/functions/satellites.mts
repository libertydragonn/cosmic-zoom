// 提供最新的近地衛星軌道根數（由 refresh-satellites 排程函式每日更新，存在 Netlify Blobs）。
// 網址：/.netlify/functions/satellites
// 還沒有任何資料時（例如剛部署、排程尚未執行），就地向 Horizons 取一次並存起來。
import { getStore } from "@netlify/blobs";
import craftIndex from "../../app/data/spacecraft.json";
import { type LiveData, refreshSatellites, satSpecs } from "../lib/satellite-refresh";

export default async () => {
  const store = getStore("satellites");
  let data = (await store.get("latest", { type: "json" })) as LiveData | null;
  if (!data) {
    try {
      data = await refreshSatellites(satSpecs(craftIndex));
      if (Object.keys(data.sats).length) await store.setJSON("latest", data);
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
    }
  }
  return Response.json(data, {
    headers: {
      // 資料一天更新一次：瀏覽器快取 30 分鐘，CDN 快取 1 小時
      "cache-control": "public, max-age=1800",
      "netlify-cdn-cache-control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
};
