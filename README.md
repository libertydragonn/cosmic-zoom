# 天體尺度探索

可連續縮放的 3D 天體地圖：從單一衛星、行星系、太陽系、鄰近恆星，一路縮放到整個銀河系。
純前端 SPA，建置結果是靜態檔案。

線上版：https://cosmic-zoom.netlify.app

## 快速開始

需要 Node.js 22.22 以上（開發時使用 24.20）。

```bash
npm install
npm run dev        # 開發伺服器，預設 http://localhost:5173
npm run build      # 產生靜態檔案到 build/client
npm run preview    # 在本機預覽建置結果，http://localhost:4173
npm run typecheck  # 型別檢查
```

資料已整理成靜態檔放在專案內（`app/data`、`public/data`），一般使用不需要重新擷取。要重新產生時：

```bash
npm run data          # 依序執行所有擷取腳本（有快取就用快取）
npm run data:refresh  # 忽略快取，全部重新下載
npm run validate      # 把軌道計算結果與 JPL Horizons 星曆比對
```

## 操作

| 動作 | 桌面 | 手機 |
|---|---|---|
| 縮放 | 滑鼠滾輪，或右下角 + / − | 雙指開合 |
| 旋轉視角 | 按住拖曳 | 單指拖曳 |
| 選取天體 | 點天體或標籤 | 點天體或標籤 |
| 飛往天體 | 連點兩下，或資訊面板的「飛往此處」 | 同左 |
| 搜尋 | 右上角搜尋框（按 `/` 聚焦） | 上方搜尋框 |
| 階層導覽 | 左上角「導覽」 | 同左 |

- 左下角是比例尺，依尺度自動切換公里、AU、光年。
- 下方中央是時間控制：暫停、加減速（即時到 10 年/秒）、倒轉、回到現在。
- 右下角切換「放大顯示」與「真實比例」。放大顯示會讓天體在螢幕上維持最小像素大小；真實比例完全依實際半徑繪製，行星和衛星遠看時小到看不見。

## 技術棧

React Router 8（framework 模式，`ssr: false`）、TypeScript 7、three.js 0.187、@react-three/fiber 9、@react-three/drei 10、zustand 5、Tailwind CSS 4、Vite 8。

## 架構：如何處理超過 15 個數量級的尺度

相機距離的可縮放範圍是 10 km 到 20 萬光年（約 1.9×10¹⁸ km）。做法有四個部分：

1. **float64 的單一真相**：所有位置都以「日心 J2000 黃道座標、單位 km」的 float64 在 JS 端計算（`app/lib/bodies.ts`、`app/lib/engine.ts`）。
2. **浮動原點**：相機在每個場景中恆位於原點。每幀先用 float64 算出「物件 − 相機」，再轉成 float32 交給 GPU。粒子雲（恆星、小天體、銀河系）則是把整團粒子的原點偏移量用 float64 算好再傳入。
3. **分層尺度場景**（`app/scene/Universe.tsx`）：四個場景各用自己的單位，由遠到近依序繪製，層與層之間清除深度緩衝，並開啟對數深度緩衝。

   | 圖層 | 單位 | 內容 |
   |---|---|---|
   | 銀河系 | 千光年 | 旋臂、核球、銀暈（程序化粒子） |
   | 恆星鄰域 | 光年 | HYG 恆星 |
   | 太陽系 | AU | 行星與矮行星軌道線、小行星帶、柯伊伯帶、離散盤、奧爾特雲 |
   | 行星系 | km | 太陽、行星、矮行星、衛星的球體與衛星軌道線 |

4. **交叉淡入淡出**：各圖層與各類標籤的透明度是相機距離對數的函數，尺度切換時平滑過渡。

其他重點：

- 縮放直接作用在「距離的對數」上，所以每一格滾輪的縮放倍率固定。
- 軌道線每幀以 float64 重新取樣，而且第一個頂點就是天體當下的位置，所以拉到很近時軌道線仍準確穿過天體。
- 小行星帶與海王星外天體的克卜勒方程在 vertex shader 內求解，兩萬顆天體隨時間運行不佔 CPU。
- 標籤用 float64 在 JS 端投影，依優先度做碰撞剔除；天體的標籤只在其軌道於畫面上夠大時才出現。
- 衛星資料按母行星分檔，該行星的衛星系在畫面上夠大、或被選取時才下載。搜尋用的名稱索引則在啟動時就載入。
- 解析度倍率會在幀率不足時自動調降（drei 的 `PerformanceMonitor`）；手機上粒子數較少。

## 資料來源

所有天文資料都由 `scripts/` 下的腳本從公開來源擷取並整理，沒有任何數值是憑記憶填寫的。
**擷取日期：2026-11-14**（每個檔案的確切時間、網址與 SHA-256 記錄在 `data/sources.json`）。

| 資料 | 來源 | 腳本 |
|---|---|---|
| 八大行星軌道根數與變率 | JPL Solar System Dynamics, *Approximate Positions of the Planets*（Standish & Williams）<br>https://ssd.jpl.nasa.gov/planets/approx_pos.html | `fetch-solar-system.mjs` |
| 行星與五顆矮行星的物理參數 | JPL SSD, *Planetary Physical Parameters*<br>https://ssd.jpl.nasa.gov/planets/phys_par.html | `fetch-solar-system.mjs` |
| 太陽物理參數、天文單位 | JPL Horizons API<br>https://ssd.jpl.nasa.gov/api/horizons.api | `fetch-solar-system.mjs` |
| 行星自轉軸、衛星三軸半徑 | NAIF 行星常數核心檔 `pck00011.tpc`<br>https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/ | `fetch-solar-system.mjs`、`fetch-moons.mjs` |
| 矮行星與候選的軌道根數 | JPL Small-Body Database API<br>https://ssd-api.jpl.nasa.gov/sbdb.api | `fetch-solar-system.mjs` |
| 衛星名單、平均根數、進動週期 | JPL SSD, *Planetary Satellite Mean Elements*<br>https://ssd.jpl.nasa.gov/sats/elem/ | `fetch-moons.mjs` |
| 衛星物理參數、行星 GM | JPL SSD, *Planetary Satellite Physical Parameters*<br>https://ssd.jpl.nasa.gov/sats/phys_par/ | `fetch-moons.mjs` |
| 衛星 IAU 編號、發現年份與發現者 | JPL SSD, *Planetary Satellite Discovery Circumstances*<br>https://ssd.jpl.nasa.gov/sats/discovery.html | `fetch-moons.mjs` |
| 衛星位置（狀態向量） | JPL Horizons API | `fetch-moons.mjs` |
| 小行星帶、柯伊伯帶、離散盤 | JPL SBDB Query API<br>https://ssd-api.jpl.nasa.gov/sbdb_query.api | `fetch-smallbodies.mjs` |
| 鄰近恆星 | HYG Database v4.4（astronexus），**CC BY-SA 4.0**<br>https://codeberg.org/astronexus/hyg | `fetch-stars.mjs` |
| 恆星中文名 | Wikidata（CC0），以 Hipparcos 編號比對條目 | `fetch-stars.mjs` |

無法取得的資料列在 [DATA_GAPS.md](DATA_GAPS.md)，介面上顯示為「無資料」。

### 授權

- NASA/JPL 的資料為公開資料。
- `public/data/stars/` 內的檔案衍生自 HYG Database，依 **CC BY-SA 4.0** 釋出；再散布時需標示出處並以相同條款分享。

### 資料處理說明

**行星**：使用 JPL 近似根數加每世紀變率。1800–2050 年用精度較高的表 1，其餘時間用表 2a/2b（適用西元前 3000 年至西元 3000 年）；超出範圍時介面會顯示警告。地球使用的是地月系質心的根數，與地球中心相差約 4,700 km（由月球距離與兩者 GM 比值算得）。

**衛星**：只收錄有 IAU 正式名稱的 169 顆。位置不是直接用 JPL 平均根數表的角度，原因是實測發現該表部分列與 Horizons 星曆對不上：土星系的 ω、M、node 相位差可達上百度，木衛一的週期欄也與實際軌道週期差一個近心點進動率。現行做法（`scripts/lib/orbit-fit.mjs`）：

1. 向 Horizons 取 2026-07-01、其後 10 日、其後 365 日三個時刻的行星中心狀態向量。
2. 轉到該衛星的進動參考面（JPL 表列的拉普拉斯面極點、行星赤道面或黃道面），算出密切根數。
3. 由三個時刻的相位求平均運動。進動週期採用 JPL 表列值；方向在一年內變化夠大時由實測決定，否則採攝動理論的慣例。

資訊面板顯示的半長軸、離心率、傾角、週期仍是 JPL 平均根數表的值。冥王星的四顆小衛星以冥王星–凱倫質心為中心擬合，但畫在冥王星周圍，有約 2,100 km 的位置近似。土衛三十五（Daphnis）的星曆只到 2018 年，改用 2016-07-01 起的時刻擬合。

**矮行星**：使用 JPL SBDB 單一曆元的密切根數，離曆元越久誤差越大。除 IAU 認定的五顆外，另收錄四顆候選（亡神星、創神星、共工星、賽德娜），在介面上標示為候選。

**小天體**：主小行星帶取 SBDB 中編號最前面的 12,000 顆（該類共 148 萬顆）；海王星外天體全數收錄，半長軸 50 AU 以內歸為柯伊伯帶、超過 50 AU 歸為離散盤（這個分界是依專案需求所定的簡化）。

**奧爾特雲**：沒有觀測資料。粒子是在 2,000–100,000 AU 的球殼內隨機生成的示意，介面上標示為理論模型。

**恆星**：選取 HYG 中視星等 6.5 以內或距離 25 秒差距以內、且距離已知的恆星，共 11,389 顆，座標轉為 J2000 黃道、單位光年。

**銀河系**：旋臂、核球、銀暈為程序化生成的示意模型，參數是美術設定（`app/lib/galaxy.ts`）。銀河座標系的方向採 IAU 定義值（出處：ESA 1997, *The Hipparcos and Tycho Catalogues* Vol. 1 §1.5.3）。太陽到銀心的距離採專案需求指定的約 2.6 萬光年。

**中文名稱**：太陽、行星、矮行星用通用譯名。衛星依中文天文學慣例由「行星字頭 + IAU 編號」組成（Jupiter I → 木衛一），編號取自 JPL 發現資料表。恆星中文名取自 Wikidata 並以 OpenCC 統一轉為繁體，查不到的只顯示英文名。

**常數**：天文單位取自 Horizons 輸出；黃赤交角取自 JPL approx_pos 頁；光年與秒差距由 IAU 定義計算（`app/lib/constants.ts`）。

### 軌道驗證

`npm run validate` 會把專案實際使用的計算程式與 Horizons 向量星曆比對。2026-11-14 的結果：

- 八大行星：方向誤差 0.08° 以內。
- 矮行星與候選：0.04° 以內（接近曆元）；回推到 1900 年時穀神星誤差約 9°。
- 抽樣的 22 顆衛星：多數在 1° 以內；木衛十一（Carme）約 5°、冥衛三（Hydra）約 2°。回推十年後相位誤差會變大：月球約 12°、土衛一約 20°、木衛十一約 36°。

`node scripts/validate-moons.mjs [衛星英文名…]` 可另外檢查軌道面法向量與面內相位。

## 部署（Netlify）

`netlify.toml` 已設定好：build 指令 `npm run build`、發布目錄 `build/client`、SPA fallback 重導向（所有路徑回傳 `index.html`）。在 Netlify 連結此專案即可，不需額外設定。

## 已知限制

- 天體是純色球體，沒有表面貼圖；土星沒有畫出行星環。
- 位置是由軌道根數推算的近似值，不是星曆級精度；時間以 UTC 當作 TDB 使用（兩者相差約一分鐘）。
- 效能只在開發機與瀏覽器的手機尺寸模擬下測過，沒有在實體手機上驗證。
- 恆星是以 float32 存放的點，所以飛往恆星時最近只能拉到約 0.02 光年。

## 專案結構

```
app/
  data/            擷取後的核心資料（打包進程式）
  lib/             軌道計算、天體登錄、相機引擎、狀態
  scene/           3D 場景：分層渲染、各圖層、標籤
  ui/              介面：搜尋、資訊面板、側邊欄、時間控制
public/data/       按需載入的資料（衛星、小天體、恆星）
scripts/           資料擷取與驗證腳本
data/sources.json  每個來源檔的網址、擷取時間、雜湊
```
