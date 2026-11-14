// 標籤系統：各圖層每幀提供候選標籤（已投影到螢幕），這裡依優先度做碰撞剔除，
// 再同步到 DOM。座標投影全部用 float64 在 JS 端完成。
import { engine } from "~/lib/engine";
import { useUI } from "~/lib/store";

export interface LabelCandidate {
  id: string;
  zh: string;
  en: string;
  x: number;
  y: number;
  /** 天體在螢幕上的半徑（像素），用於標籤偏移與點選判定。 */
  r: number;
  priority: number;
  cls: string;
  /** false 表示只參與點選，不顯示標籤。 */
  show: boolean;
  /** 可否點選。 */
  pickable: boolean;
}

type Provider = () => void;
const providers = new Set<Provider>();
export function addLabelProvider(p: Provider): () => void {
  providers.add(p);
  return () => providers.delete(p);
}

const pool: LabelCandidate[] = [];
let count = 0;
/** 取得一個可重複使用的候選物件（避免每幀配置記憶體）。 */
export function nextCandidate(): LabelCandidate {
  if (count >= pool.length) {
    pool.push({ id: "", zh: "", en: "", x: 0, y: 0, r: 0, priority: 0, cls: "", show: true, pickable: true });
  }
  const c = pool[count++];
  c.show = true;
  c.pickable = true;
  c.r = 0;
  return c;
}

interface LabelEl {
  el: HTMLDivElement;
  w: number;
  visible: boolean;
  hiddenFrames: number;
  lastText: string;
}
const elements = new Map<string, LabelEl>();
let container: HTMLDivElement | null = null;
let ring: HTMLDivElement | null = null;
let frame = 0;
const order: LabelCandidate[] = [];
const accepted: number[] = []; // x0,y0,x1,y1 …

export function mountLabels(el: HTMLDivElement): () => void {
  container = el;
  ring = document.createElement("div");
  ring.className = "select-ring";
  el.appendChild(ring);
  return () => {
    for (const l of elements.values()) l.el.remove();
    elements.clear();
    ring?.remove();
    ring = null;
    container = null;
  };
}

function getEl(c: LabelCandidate): LabelEl {
  let l = elements.get(c.id);
  if (!l) {
    const el = document.createElement("div");
    el.dataset.id = c.id;
    container!.appendChild(el);
    l = { el, w: 0, visible: false, hiddenFrames: 0, lastText: "" };
    elements.set(c.id, l);
  }
  const text = c.cls + "|" + c.zh + "|" + c.en;
  if (l.lastText !== text) {
    l.lastText = text;
    l.el.className = "lbl " + c.cls;
    l.el.replaceChildren();
    const zh = document.createElement("span");
    zh.className = "zh";
    zh.textContent = c.zh;
    l.el.appendChild(zh);
    if (c.en && c.en !== c.zh) {
      const en = document.createElement("span");
      en.className = "en";
      en.textContent = c.en;
      l.el.appendChild(en);
    }
    l.el.style.display = "";
    l.w = l.el.offsetWidth;
  }
  return l;
}

/** 每幀呼叫一次（在場景繪製之後）。 */
export function updateLabels(): void {
  if (!container) return;
  frame++;
  count = 0;
  for (const p of providers) p();

  const { selectedId } = useUI.getState();
  const targetId = engine.fly ? engine.fly.toId : engine.targetId;
  const W = engine.width;
  const H = engine.height;

  order.length = 0;
  for (let k = 0; k < count; k++) {
    const c = pool[k];
    if (!c.show) continue;
    // 天體本身已佔據大片畫面時不再貼標籤（名稱在資訊面板）
    if (c.r > 90) continue;
    if (c.x < -40 || c.x > W + 40 || c.y < -20 || c.y > H + 20) continue;
    if (c.id === selectedId) c.priority += 5000;
    else if (c.id === targetId) c.priority += 2000;
    if (elements.get(c.id)?.visible) c.priority += 40; // 遲滯，避免閃爍
    order.push(c);
  }
  order.sort((a, b) => b.priority - a.priority);

  accepted.length = 0;
  const shown = new Set<string>();
  const MAX = W < 640 ? 28 : 70;
  for (let k = 0; k < order.length && shown.size < MAX; k++) {
    const c = order[k];
    const l = getEl(c);
    const off = Math.min(c.r, 60) + 7;
    const x0 = c.x + off;
    const y0 = c.y - 9;
    const x1 = x0 + l.w;
    const y1 = c.y + 9;
    let hit = false;
    for (let a = 0; a < accepted.length; a += 4) {
      if (x0 < accepted[a + 2] + 4 && x1 > accepted[a] - 4 && y0 < accepted[a + 3] + 1 && y1 > accepted[a + 1] - 1) {
        hit = true;
        break;
      }
    }
    if (hit && c.priority < 2000) continue;
    accepted.push(x0, y0, x1, y1);
    shown.add(c.id);
    l.el.style.transform = `translate3d(${x0.toFixed(1)}px,${(c.y - 9).toFixed(1)}px,0)`;
    if (!l.visible) {
      l.visible = true;
      l.el.style.display = "";
      l.el.style.opacity = "1";
    }
    l.hiddenFrames = 0;
  }

  for (const [id, l] of elements) {
    if (shown.has(id)) continue;
    if (l.visible) {
      l.visible = false;
      l.el.style.opacity = "0";
    }
    l.hiddenFrames++;
    if (l.hiddenFrames === 30) l.el.style.display = "none";
    if (l.hiddenFrames > 3600) {
      l.el.remove();
      elements.delete(id);
    }
  }

  // 選取框
  if (ring) {
    let sel: LabelCandidate | null = null;
    if (selectedId) {
      for (let k = 0; k < count; k++) {
        if (pool[k].id === selectedId) {
          sel = pool[k];
          break;
        }
      }
    }
    if (sel && sel.x > -100 && sel.x < W + 100 && sel.y > -100 && sel.y < H + 100) {
      const size = Math.max(22, Math.min(sel.r * 2 + 14, 4000));
      ring.style.opacity = sel.r * 2 > Math.min(W, H) * 0.6 ? "0" : "1";
      ring.style.width = ring.style.height = size.toFixed(1) + "px";
      ring.style.transform = `translate3d(${(sel.x - size / 2).toFixed(1)}px,${(sel.y - size / 2).toFixed(1)}px,0)`;
    } else {
      ring.style.opacity = "0";
    }
  }
}

/** 回傳螢幕座標附近最適合的可點選對象。 */
export function pickAt(x: number, y: number): string | null {
  let best: LabelCandidate | null = null;
  let bestScore = Infinity;
  for (let k = 0; k < count; k++) {
    const c = pool[k];
    if (!c.pickable) continue;
    const d = Math.hypot(c.x - x, c.y - y);
    const reach = Math.max(c.r, 12) + 4;
    if (d > reach) continue;
    // 距離越近、優先度越高者勝出
    const score = d / reach - c.priority * 1e-5;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best?.id ?? null;
}
