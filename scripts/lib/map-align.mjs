// 比對兩張等距圓柱地圖的經度方向（鏡射與位移）。
// 兩張圖的光照方向通常不同，直接比亮度會因陰影方向相反而失準，因此比的是「梯度強度」：
// 坑緣、山脊等地形邊緣不論從哪一側照光都會有強梯度。
import sharp from "sharp";

const W = 360;
const H = 180;

function boxBlur(v, R) {
  const out = new Float64Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let s = 0, n = 0;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -R; dx <= R; dx++) {
          s += v[yy * W + (((x + dx) % W) + W) % W];
          n++;
        }
      }
      out[y * W + x] = s / n;
    }
  return out;
}

/** 360×180 的梯度強度圖（扣掉大尺度平均）。 */
export async function alignGrid(input, { mode = "gradient" } = {}) {
  const { data } = await sharp(input, { limitInputPixels: false })
    .flatten({ background: "#808080" })
    .toColourspace("b-w")
    .resize(W * 2, H * 2, { fit: "fill" })
    .resize(W, H, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const v = Float64Array.from(data);
  let f;
  if (mode === "gradient") {
    const s = boxBlur(v, 1);
    f = new Float64Array(W * H);
    for (let y = 1; y < H - 1; y++)
      for (let x = 0; x < W; x++) {
        const gx = s[y * W + ((x + 1) % W)] - s[y * W + ((x + W - 1) % W)];
        const gy = s[(y + 1) * W + x] - s[(y - 1) * W + x];
        // 經度方向的像素在高緯度被拉長，乘上 cos(緯度) 修正
        const lat = (Math.PI / 2) * (1 - (2 * (y + 0.5)) / H);
        f[y * W + x] = Math.hypot(gx * (1 / Math.max(0.2, Math.cos(lat))), gy);
      }
  } else {
    f = boxBlur(v, 2);
  }
  const bg = boxBlur(f, 12);
  for (let i = 0; i < f.length; i++) f[i] -= bg[i];
  return f;
}

/** 在所有鏡射與經度位移中找出與參考圖最相關者；同時回傳次佳值以評估顯著性。 */
export function bestAlignment(cand, ref, { latRows = [30, 150] } = {}) {
  const results = [];
  for (const flip of [false, true]) {
    for (let s = 0; s < W; s++) {
      let ab = 0, aa = 0, bb = 0;
      for (let y = latRows[0]; y < latRows[1]; y++) {
        for (let x = 0; x < W; x++) {
          let sx = (x + s) % W;
          if (flip) sx = W - 1 - sx;
          const a = cand[y * W + sx];
          const b = ref[y * W + x];
          ab += a * b; aa += a * a; bb += b * b;
        }
      }
      results.push({ corr: ab / Math.sqrt(aa * bb), flip, shiftDeg: s });
    }
  }
  results.sort((p, q) => q.corr - p.corr);
  const best = results[0];
  // 次佳：與最佳位移相差超過 20° 或鏡射不同的最大值
  const runnerUp = results.find((r) => r.flip !== best.flip || Math.min(Math.abs(r.shiftDeg - best.shiftDeg), 360 - Math.abs(r.shiftDeg - best.shiftDeg)) > 20);
  return { ...best, runnerUp: runnerUp?.corr ?? 0 };
}
