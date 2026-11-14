import type { Config } from "@react-router/dev/config";

export default {
  // 純前端 SPA：不做伺服器端渲染，建置結果為靜態檔案（build/client）
  ssr: false,
} satisfies Config;
