// 擷取小行星帶與海王星外天體（柯伊伯帶、離散盤）的真實軌道根數，供粒子雲使用。
// 來源：JPL SBDB Query API。
// 輸出：public/data/smallbodies/{mainbelt,tno}.bin（Float32，每顆 7 個值）與 index.json
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { PUBLIC_DATA, fetchCached, sourceInfo, writeJson } from "./lib/common.mjs";

const REF_EPOCH = 2461200.5; // 所有天體的平近點角都換算到這個曆元（TDB）
const FIELDS = "a,e,i,om,w,ma,n,epoch";
const MAIN_BELT_LIMIT = 12000;
// 柯伊伯帶與離散盤的分界：專案需求將柯伊伯帶定為約 30–50 AU，半長軸超過 50 AU 的歸為離散盤
const KUIPER_OUTER_AU = 50;

async function query(name, params) {
  const url = `https://ssd-api.jpl.nasa.gov/sbdb_query.api?fields=${FIELDS}&full-prec=true&${params}`;
  const j = JSON.parse(await fetchCached(name, url));
  if (!Array.isArray(j.data)) throw new Error(`SBDB 查詢失敗: ${JSON.stringify(j).slice(0, 300)}`);
  return { total: Number(j.count), rows: j.data };
}

function pack(rows) {
  const kept = [];
  let skipped = 0;
  for (const r of rows) {
    const [a, e, i, om, w, ma, n, epoch] = r.map(Number);
    // 只收橢圓軌道且根數完整者
    if (![a, e, i, om, w, ma, n, epoch].every(Number.isFinite) || a <= 0 || e < 0 || e >= 0.995) {
      skipped++;
      continue;
    }
    const maRef = (((ma + n * (REF_EPOCH - epoch)) % 360) + 360) % 360;
    kept.push([a, e, i, om, w, maRef, n]);
  }
  const buf = new Float32Array(kept.length * 7);
  kept.forEach((k, idx) => buf.set(k, idx * 7));
  return { buf, kept, skipped };
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
function stats(kept) {
  const a = kept.map((k) => k[0]).sort((x, y) => x - y);
  return { count: kept.length, aMinAU: a[0], aP05AU: pct(a, 0.05), aMedianAU: pct(a, 0.5), aP95AU: pct(a, 0.95), aMaxAU: a[a.length - 1] };
}

const outDir = join(PUBLIC_DATA, "smallbodies");
await mkdir(outDir, { recursive: true });

// 主小行星帶：SBDB 依編號排序，取前 MAIN_BELT_LIMIT 顆（即最早編號、通常也較大的小行星）
const mb = await query("sbdb-mainbelt.json", `sb-kind=a&sb-class=IMB,MBA,OMB&limit=${MAIN_BELT_LIMIT}`);
const mbPacked = pack(mb.rows);
await writeFile(join(outDir, "mainbelt.bin"), Buffer.from(mbPacked.buf.buffer));

// 海王星外天體：全部
const tno = await query("sbdb-tno.json", "sb-class=TNO");
const tnoPacked = pack(tno.rows);
// 依半長軸排序，前段為柯伊伯帶、後段為離散盤，前端用一個分界索引上色
tnoPacked.kept.sort((x, y) => x[0] - y[0]);
const tnoBuf = new Float32Array(tnoPacked.kept.length * 7);
tnoPacked.kept.forEach((k, idx) => tnoBuf.set(k, idx * 7));
await writeFile(join(outDir, "tno.bin"), Buffer.from(tnoBuf.buffer));
const kuiper = tnoPacked.kept.filter((k) => k[0] <= KUIPER_OUTER_AU);
const scattered = tnoPacked.kept.filter((k) => k[0] > KUIPER_OUTER_AU);

await writeJson(join(outDir, "index.json"), {
  source: "JPL Small-Body Database Query API (https://ssd-api.jpl.nasa.gov/sbdb_query.api)",
  retrievedAt: {
    mainbelt: (await sourceInfo("sbdb-mainbelt.json"))?.retrievedAt,
    tno: (await sourceInfo("sbdb-tno.json"))?.retrievedAt,
  },
  refEpochJd: REF_EPOCH,
  layout: ["a (au)", "e", "i (deg)", "node (deg)", "argPeri (deg)", "meanAnomaly@refEpoch (deg)", "meanMotion (deg/day)"],
  mainbelt: {
    file: "mainbelt.bin",
    sbdbClasses: ["IMB", "MBA", "OMB"],
    totalInSbdb: mb.total,
    note: `SBDB 中此類共 ${mb.total} 顆，這裡取編號最前面的 ${MAIN_BELT_LIMIT} 顆`,
    skipped: mbPacked.skipped,
    ...stats(mbPacked.kept),
  },
  tno: {
    file: "tno.bin",
    sbdbClasses: ["TNO"],
    totalInSbdb: tno.total,
    skipped: tnoPacked.skipped,
    kuiperOuterAU: KUIPER_OUTER_AU,
    kuiperCount: kuiper.length,
    ...stats(tnoPacked.kept),
    kuiper: stats(kuiper),
    scattered: stats(scattered),
  },
});
console.log(`主帶 ${mbPacked.kept.length} 顆（SBDB 共 ${mb.total}）；TNO ${tnoPacked.kept.length} 顆（柯伊伯帶 ${kuiper.length}、離散盤 ${scattered.length}）`);
