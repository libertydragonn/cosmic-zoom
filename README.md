# 天體尺度探索（Cosmic Zoom）

在瀏覽器裡，從一顆衛星的表面一路連續縮放到整個銀河系的 3D 天體地圖。行星、衛星、小天體和人造探測器都依真實軌道即時運行，所有數值都取自 NASA／JPL 等公開資料。

**線上體驗：https://cosmic-zoom.netlify.app**（桌面與手機皆可，不需安裝）

> An interactive 3D map of the universe (Traditional Chinese UI). Zoom continuously from a moon's surface out to the whole Milky Way. Planets, 169 moons, ~20,000 small bodies and 24 spacecraft move along their real orbits, and every value comes from NASA/JPL and other cited public sources.

## 特色

- **跨越 15 個數量級的連續縮放**：相機距離從 10 公里到 20 萬光年，用滾輪或雙指一路縮放，不用切換頁面。比例尺會自動在公里、AU、光年之間切換。
- **會動的太陽系**：8 大行星、9 顆矮行星與候選、169 顆有正式名稱的衛星，以及約兩萬顆小行星與海王星外天體，都依軌道根數即時運行。時間可以暫停、加速到每秒 10 年、倒轉，或回到現在。
- **真實的表面影像**：23 個天體使用 NASA、USGS、Hubble OPAL 的全球影像，並依 IAU 自轉模型即時轉動，所以月球永遠以正面朝向地球。土星環的透明度由 Voyager 2 的掩星資料算出。
- **人造探測器**：收錄 13 個深空探測器的完整飛行軌跡，包括航海家 1、2 號、新視野號、帕克太陽探測器、韋伯太空望遠鏡等。另有國際太空站、哈伯太空望遠鏡等 11 顆環繞地球的人造衛星，軌道每天自動更新。多數探測器可以一鍵切換到 NASA Eyes on the Solar System 觀看。
- **鄰近恆星與銀河系**：11,389 顆肉眼可見或 25 秒差距以內的恆星（HYG 資料庫），外圍是銀河系的示意模型。
- **搜尋與導覽**：輸入中文或英文名稱即可飛往任一天體，也可以依「銀河系 → 太陽系 → 行星 → 衛星」的階層瀏覽。

## 資料原則

- 所有天文數值都由 `scripts/` 下的腳本從公開來源擷取，沒有憑記憶或估計填寫。每個來源檔的網址、擷取時間與 SHA-256 都記錄在 `data/sources.json`。
- 取不到的資料在介面上顯示為「無資料」，並完整列在 [DATA_GAPS.md](DATA_GAPS.md)。
- 銀河系的旋臂結構與奧爾特雲沒有可用的觀測資料，畫面上的是示意模型，詳見下方「資料處理說明」。
- `npm run validate` 會把專案的位置計算與 JPL Horizons 星曆比對，結果見「軌道驗證」。

技術上是純前端 SPA（React Router、three.js、@react-three/fiber），建置結果是靜態檔案。

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
| 水星、地球、火星、月球、木衛一至四、土衛九、海衛一、冥王星、凱倫的表面影像 | USGS Astrogeology 行星地圖服務（WMS）：MESSENGER、MODIS、Viking MDIM 2.1 彩色、LRO WAC、Galileo/Voyager、Cassini、Voyager 2、New Horizons 全球鑲嵌圖<br>https://planetarymaps.usgs.gov/ | `fetch-textures.mjs` |
| 土衛一至土衛五、土衛八的表面影像 | NASA/JPL-Caltech/Space Science Institute，Cassini 2014 全球彩色地圖（PIA18434–PIA18439）<br>https://photojournal.jpl.nasa.gov/ | `fetch-textures.mjs` |
| 穀神星表面影像 | USGS，Ceres Dawn FC Global Mosaic 400m（DLR 製作） | `fetch-textures.mjs` |
| 木星、土星、天王星、海王星表面影像 | Hubble OPAL 計畫全球地圖（STScI MAST，DOI 10.17909/T9G593）<br>https://archive.stsci.edu/hlsp/opal | `fetch-textures.mjs` |
| 土星環的透明度 | PDS Rings Node，Voyager 2 PPS δ Sco 掩星剖面（VG_2801，10 km 解析度） | `fetch-textures.mjs` |
| 自轉軸、本初子午線（含週期項） | IAU WGCCRE 自轉模型，經 NAIF `pck00011.tpc` | `fetch-textures.mjs` |
| 人造探測器軌跡 | JPL Horizons 向量星曆（與 NASA Eyes on the Solar System 同樣來自 JPL 的探測器星曆） | `fetch-spacecraft.mjs` |
| 探測器中文名、發射日期、營運機構、COSPAR 編號 | Wikidata（CC0），以發射日期與 Horizons 星曆起點相差 3 日內比對條目 | `fetch-spacecraft.mjs` |

無法取得的資料列在 [DATA_GAPS.md](DATA_GAPS.md)，介面上顯示為「無資料」。

### 授權

- NASA/JPL 的資料為公開資料。
- `public/data/stars/` 內的檔案衍生自 HYG Database，依 **CC BY-SA 4.0** 釋出；再散布時需標示出處並以相同條款分享。
- `public/textures/` 內的表面影像衍生自 NASA、USGS、Hubble 的公開影像。巨行星貼圖衍生自 Hubble OPAL 地圖，依 **CC BY 4.0** 釋出（標示：NASA, ESA, A.A. Simon, M.H. Wong）；OPAL 要求的致謝：
  *This work used data acquired from the NASA/ESA HST Space Telescope, associated with OPAL program (PI: Simon, GO13937), and archived by the Space Telescope Science Institute, which is operated by the Association of Universities for Research in Astronomy, Inc., under NASA contract NAS 5-26555. All maps are available at http://dx.doi.org/10.17909/T9G593.*

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

**表面影像**：全部轉成同一種等距圓柱投影（左緣為東經 −180°、向右遞增、北極在上），手機載入 2048 像素寬的版本，桌面拉近時才另外載入 4096 像素版。天體在畫面上的半徑大於 8 像素時才下載貼圖；同時保留的貼圖手機最多 8 張、桌面 14 張，超過時釋放最久沒用到的，之後需要再重新下載。

- 經度方向逐一確認：USGS 的地圖以火星的奧林帕斯山與希臘平原、月海、地球大陸、木衛一的 Pele 火山確認為東經向右；Hubble OPAL 依各自 README 的說明處理（天王星的圖是東經向左，已左右翻轉）；Cassini 2014 彩色地圖用地形梯度與 USGS 鑲嵌圖自動比對，確認左緣為東經 0°（不符合時腳本會中止）；穀神星由 GeoTIFF 的座標標籤判定。
- 巨行星的 Hubble 地圖採行星面緯度（planetographic），依扁率修正到橢球上；其他天體採行星中心緯度。
- 巨行星的顏色不用 OPAL 的 TIFF 預覽（各濾鏡亮度任意縮放，會偏色），而是取三個濾鏡的 FITS 科學資料，乘上 README 表列的係數換算成反射率 I/F，長波到短波分別當作紅、綠、藍，以同一個增益映射。這是近似真彩色（濾鏡中心波長不等於人眼的三原色）。FITS 的上下方向以和 TIFF 預覽的相關性確認。
- 冥王星、凱倫、海衛一有一部分表面從未被拍到，該區域以已成像區域的平均色填補。巨行星的 Hubble 地圖在極區、背光的半球（天王星目前的南半球）與被土星環擋住的帶狀區沒有資料，這些地方以相鄰緯度內插或延伸最接近緯度帶的平均色填補，並裁掉臨邊附近的彩色條紋。各天體的填補比例記在 `app/data/textures.json`，資訊面板也會註明。
- Cassini 2014 彩色地圖的顏色官方說明為增強色（含紫外與紅外），這裡把飽和度降到 40%，比較接近肉眼所見，但不是校正過的真彩色。
- 沒有貼圖的天體：金星（可見光下只有雲頂）、土衛六（橘色霧霾）、天王星的衛星（只拍到南半球，找不到可確認經度方向的全球圖）、火衛一與火衛二（形狀太不規則）、其他沒有近距離成像的天體，以及太陽以外的所有恆星（沒有恆星表面圖）。太陽以臨邊昏暗近似呈現。

**自轉**：每個有貼圖的天體依 IAU 自轉模型（北極赤經赤緯、本初子午線角，含月球與木星、土星、海王星系統的週期項）即時計算方向，所以月球永遠以正面朝向地球、土星環位於土星赤道面。

**人造探測器**：深空探測收錄 Horizons 與 NASA Eyes on the Solar System 都有的 13 個：航海家 1、2 號、先驅者 10、11 號、新視野號、帕克太陽探測器、卡西尼號、朱諾號、韋伯太空望遠鏡、露西號、靈神星軌道器、歐羅巴快船、木星冰月探測器。

**環繞地球的人造衛星**：收錄 Horizons 有星曆的 11 個：國際太空站、天宮空間站、哈伯太空望遠鏡、錢德拉 X 射線天文臺、TESS、NuSTAR、太陽動力學天文臺、Terra、Aqua、Aura、GOES-16（其中天宮與 GOES-16 不在 NASA Eyes 內，沒有 Eyes 連結）。

- 低軌道一圈只要約 90 分鐘，不適合存位置取樣，改存 Horizons 每日一組的密切軌道根數（地心、ICRF 赤道面），顯示時在相鄰兩組之間內插（近圓軌道內插 ω 與「ω + 平近點角」，以平均運動判斷圈數），再轉成黃道座標。與 Horizons 在非取樣時刻比對：多數在 30 km 以內；受月球攝動強的 TESS 最大約 330 km（約為軌道大小的 0.2%）；變軌期間（例如天宮剛發射時）誤差會較大。
- 只有相機靠近地球或選取、飛往這些衛星時才下載（約 1.9 MB）。軌道線畫的是目前的密切軌道。被地球擋住時不顯示名稱。
- **資料時效與自動更新**：近地衛星受大氣阻力影響，Horizons 的預測只到約一兩個月後。網站內建的資料停在擷取當時的預測（國際太空站到 2026-12-14），另有 Netlify 排程函式每天自動延長：
  - `netlify/functions/refresh-satellites.mts`：每天 03:00 UTC（台灣時間 11:00）向 Horizons 取「內建資料結束前 5 日」到 Horizons 最新預測為止的每日根數（與內建資料逐日對齊），存到 Netlify Blobs 的 `satellites` 儲存區。一次只查 2 顆，全部約 10 秒；某顆失敗時保留它上一次成功的資料。
  - `netlify/functions/satellites.mts`（`/.netlify/functions/satellites`）：把最新資料提供給網站；還沒有資料時（剛部署）就地向 Horizons 取一次。
  - 網站載入地球衛星時取得這份資料，接在內建資料後面並延長星曆範圍；取不到時（本機開發、函式或 Horizons 暫時失敗）沿用內建資料。資訊面板會顯示最近一次自動更新的時間。
  - 兩個函式共用 `netlify/lib/satellite-refresh.ts`。排程只在正式部署上執行；Netlify 介面的 Functions 頁可看紀錄或按 Run now 手動執行。
  - 全部約一萬顆在軌衛星（Starlink 等）不在 NASA/JPL 資料內，未收錄。

- 軌跡平常存日心座標；探測器進入某行星 1.5 倍希爾半徑內就改存「相對該行星」的座標（離開 2 倍時改回），顯示時加上本專案的行星位置，所以飛掠與環繞軌道會和畫面上的行星對齊。行星附近的最近點另外以數分鐘的步長補取樣。
- 取樣點以三次 Hermite（位置＋速度）內插，精簡到「在每個原始取樣點的重建誤差不超過到中心距離的 0.02%（至少 1 km）」為止；畫線時也沿 Hermite 曲線細分，不是直線連接取樣點。
- 畫面：在日心段時畫出完整軌跡（過去較亮、未來較暗；飛掠段換算到當時行星所在位置）；長期環繞行星時（朱諾號、韋伯望遠鏡、卡西尼號的土星期間）另外以行星為中心畫出前 120 日、後 40 日的軌道。Horizons 範圍外的時間不顯示。
- 資訊面板的「在 NASA Eyes 檢視」以 Eyes 官方支援的內嵌方式開啟該探測器頁（ID 取自 Eyes 網頁程式的實體清單），並帶入本頁目前的模擬時間；開啟時本頁暫停 3D 繪製。
- 下方「人造探測器」按鈕打開選單：總開關、逐一勾選要顯示的探測器（全選／全不選），以及軌跡顯示方式。預設為「僅選取的」：平常只顯示標記與名稱，點選或飛往某個探測器時才畫出它的軌跡，避免十幾條軌跡纏在一起；也可改成「全部」。這些偏好記在瀏覽器裡。從搜尋或導覽飛往被隱藏的探測器時會自動重新顯示它。

**常數**：天文單位取自 Horizons 輸出；黃赤交角取自 JPL approx_pos 頁；光年與秒差距由 IAU 定義計算（`app/lib/constants.ts`）。

### 軌道驗證

`npm run validate` 會把專案實際使用的計算程式與 Horizons 向量星曆比對。2026-11-14 的結果：

- 八大行星：方向誤差 0.08° 以內。
- 矮行星與候選：0.04° 以內（接近曆元）；回推到 1900 年時穀神星誤差約 9°。
- 抽樣的 22 顆衛星：多數在 1° 以內；木衛十一（Carme）約 5°、冥衛三（Hydra）約 2°。回推十年後相位誤差會變大：月球約 12°、土衛一約 20°、木衛十一約 36°。

`node scripts/validate-moons.mjs [衛星英文名…]` 可另外檢查軌道面法向量與面內相位。

`npm run validate` 也會跑 `scripts/validate-rotation.mjs`：用專案的自轉模型算出「從地心看到的星下點經緯度」，與 Horizons 的 ObsSub-LON／ObsSub-LAT 比對。2000、2026、2045 年三個時刻、13 個天體（水星、月球、火星、木星、木衛一、木衛四、土星、土衛八、天王星、海王星、海衛一、冥王星、凱倫）的最大差異為 0.02°。

## 部署（Netlify）

網址：https://cosmic-zoom.netlify.app 。Netlify 專案已連結 GitHub，推送到 `main` 分支就會自動建置與部署。

`netlify.toml` 已設定好：build 指令 `npm run build`、發布目錄 `build/client`、SPA fallback 重導向（所有路徑回傳 `index.html`）。建置時不會重新擷取天文資料（資料檔已提交在儲存庫內）；要更新資料請在本機執行 `npm run data`，確認後提交推送。近地衛星的軌道根數另由 Netlify 排程函式每日自動更新（見上方「環繞地球的人造衛星」）。

## 已知限制

- 沒有畫出陰影（行星與環互相投下的影子、衛星投在行星上的影子）。土星環的透明度與明暗由掩星光學深度以單次散射近似計算，顏色與整體亮度是顯示用設定。
- 巨行星的雲帶會隨時間漂移，貼圖只代表 Hubble 觀測當時的樣貌。
- 位置是由軌道根數推算的近似值，不是星曆級精度；時間以 UTC 當作 TDB 使用（兩者相差約一分鐘）。
- 效能主要在開發機與瀏覽器的手機尺寸模擬下測試，實體手機只做過少量測試。
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
