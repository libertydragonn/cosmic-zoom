// 極簡靜態伺服器（含 SPA fallback），用來在本機檢查正式建置結果。
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.argv[2];
const port = Number(process.argv[3] ?? 4173);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".bin": "application/octet-stream", ".ico": "image/x-icon", ".jpg": "image/jpeg", ".png": "image/png" };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
  let file = join(root, path);
  try {
    if (!(await stat(file)).isFile()) throw new Error("not a file");
  } catch {
    file = join(root, "index.html");
  }
  const body = await readFile(file);
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  res.end(body);
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
