// 模擬引擎：時間、相機、投影。這些狀態每幀都在變，所以放在 React 之外。
// 相機以「焦點 + 距離對數 + 兩個角度」描述，位置為 float64 的日心黃道座標 (km)。
import { type Entity, getEntity, updateBodies } from "./bodies";
import { DEG, MAX_LOG_DIST, MIN_LOG_DIST, SECONDS_PER_DAY } from "./constants";

export function jdFromDate(d: Date): number {
  return d.getTime() / 86400000 + 2440587.5;
}
export function dateFromJd(jd: number): Date {
  return new Date((jd - 2440587.5) * 86400000);
}

interface Fly {
  from: Float64Array;
  fromLog: number;
  midLog: number;
  toId: string;
  toLog: number;
  fromYaw: number;
  fromPitch: number;
  toYaw: number | null;
  toPitch: number | null;
  t: number;
  duration: number;
}

const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
};

class Engine {
  /** 模擬時間（儒略日）。 */
  jd = jdFromDate(new Date());
  /** 模擬秒／真實秒。 */
  rate = 1;
  paused = false;
  /** true＝放大顯示；false＝真實比例。 */
  enlarged = true;

  targetId = "sun";
  focus = new Float64Array(3);
  logDist = 9.83;
  logDistGoal = 9.83;
  yaw = -60 * DEG;
  pitch = 32 * DEG;

  camPos = new Float64Array(3);
  right = new Float64Array(3);
  up = new Float64Array(3);
  fwd = new Float64Array(3);

  width = 1;
  height = 1;
  fovY = 50 * DEG;
  /** 畫面中心每弧度對應的像素數。 */
  pxPerRad = 1;

  fly: Fly | null = null;
  /** 飛行結束或目標改變時通知 UI。 */
  onTargetChange: ((id: string) => void) | null = null;

  get dist(): number {
    return 10 ** this.logDist;
  }

  setViewport(w: number, h: number, fovYDeg: number): void {
    this.width = w;
    this.height = h;
    this.fovY = fovYDeg * DEG;
    this.pxPerRad = h / 2 / Math.tan(this.fovY / 2);
  }

  private clampLog(v: number, target: Entity | undefined): number {
    const min = Math.max(MIN_LOG_DIST, target?.minLogDist ?? MIN_LOG_DIST);
    return Math.min(MAX_LOG_DIST, Math.max(min, v));
  }

  zoomBy(deltaLog: number): void {
    if (this.fly) {
      this.fly.toLog = this.clampLog(this.fly.toLog + deltaLog, getEntity(this.fly.toId));
      return;
    }
    this.logDistGoal = this.clampLog(this.logDistGoal + deltaLog, getEntity(this.targetId));
  }

  rotateBy(dYaw: number, dPitch: number): void {
    // 使用者手動旋轉時，取消飛行中的自動轉向
    if (this.fly) this.fly.toYaw = this.fly.toPitch = null;
    this.yaw += dYaw;
    const lim = 89.5 * DEG;
    this.pitch = Math.min(lim, Math.max(-lim, this.pitch + dPitch));
  }

  /** 平滑飛往某個對象；logDist 省略時用該對象的預設視距。 */
  flyTo(id: string, logDist?: number): void {
    const target = getEntity(id);
    if (!target) return;
    const toLog = this.clampLog(logDist ?? target.viewLogDist, target);
    const dx = target.pos[0] - this.focus[0];
    const dy = target.pos[1] - this.focus[1];
    const dz = target.pos[2] - this.focus[2];
    const sep = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const fromLog = this.logDist;
    // 先拉遠到能同時看見起點與終點，再移動，再拉近
    const midLog = Math.min(MAX_LOG_DIST, Math.max(fromLog, toLog, sep > 0 ? Math.log10(sep) + 0.35 : 0));
    const travel = midLog - fromLog + (midLog - toLog);
    this.fly = {
      from: Float64Array.from(this.focus),
      fromLog,
      midLog,
      toId: id,
      toLog,
      fromYaw: this.yaw,
      fromPitch: this.pitch,
      // 取最短路徑旋轉到目標偏好的視角
      toYaw: target.viewYaw == null ? null : this.yaw + Math.atan2(Math.sin(target.viewYaw - this.yaw), Math.cos(target.viewYaw - this.yaw)),
      toPitch: target.viewPitch ?? null,
      t: 0,
      duration: Math.min(5.5, 1.1 + 0.3 * travel + (sep > 0 ? 0.6 : 0)),
    };
  }

  /** 立即切換目標（不做動畫）。 */
  jumpTo(id: string, logDist?: number): void {
    const target = getEntity(id);
    if (!target) return;
    this.fly = null;
    this.targetId = id;
    this.logDist = this.logDistGoal = this.clampLog(logDist ?? target.viewLogDist, target);
    this.onTargetChange?.(id);
  }

  tick(dt: number): void {
    if (!this.paused) this.jd += (dt * this.rate) / SECONDS_PER_DAY;
    updateBodies(this.jd);

    const fly = this.fly;
    if (fly) {
      const target = getEntity(fly.toId)!;
      fly.t = Math.min(1, fly.t + dt / fly.duration);
      const t = fly.t;
      const s = smooth((t - 0.25) / 0.5);
      for (let k = 0; k < 3; k++) this.focus[k] = fly.from[k] + (target.pos[k] - fly.from[k]) * s;
      if (fly.toYaw != null && fly.toPitch != null) {
        const a = smooth(t);
        this.yaw = fly.fromYaw + (fly.toYaw - fly.fromYaw) * a;
        this.pitch = fly.fromPitch + (fly.toPitch - fly.fromPitch) * a;
      }
      const out = smooth(t / 0.45);
      const inn = smooth((t - 0.55) / 0.45);
      this.logDist = fly.fromLog + (fly.midLog - fly.fromLog) * out + (fly.toLog - fly.midLog) * inn;
      if (t >= 1) {
        this.targetId = fly.toId;
        this.logDist = this.logDistGoal = fly.toLog;
        this.fly = null;
        this.onTargetChange?.(this.targetId);
      }
    } else {
      const target = getEntity(this.targetId);
      if (target) {
        this.focus[0] = target.pos[0];
        this.focus[1] = target.pos[1];
        this.focus[2] = target.pos[2];
      }
      this.logDistGoal = this.clampLog(this.logDistGoal, target);
      this.logDist += (this.logDistGoal - this.logDist) * (1 - Math.exp(-dt * 9));
    }

    // 相機基底（黃道北為上）
    const cp = Math.cos(this.pitch);
    const dx = cp * Math.cos(this.yaw);
    const dy = cp * Math.sin(this.yaw);
    const dz = Math.sin(this.pitch);
    const d = this.dist;
    this.camPos[0] = this.focus[0] + dx * d;
    this.camPos[1] = this.focus[1] + dy * d;
    this.camPos[2] = this.focus[2] + dz * d;
    this.fwd[0] = -dx;
    this.fwd[1] = -dy;
    this.fwd[2] = -dz;
    // right = fwd × z
    const rl = Math.hypot(dy, dx) || 1;
    this.right[0] = -dy / rl;
    this.right[1] = dx / rl;
    this.right[2] = 0;
    // up = right × fwd
    this.up[0] = this.right[1] * this.fwd[2] - this.right[2] * this.fwd[1];
    this.up[1] = this.right[2] * this.fwd[0] - this.right[0] * this.fwd[2];
    this.up[2] = this.right[0] * this.fwd[1] - this.right[1] * this.fwd[0];
  }

  /**
   * 把日心座標 (km) 投影到螢幕像素。out = [x, y, 與相機的距離 km]。
   * 在相機後方時回傳 false。
   */
  project(pos: ArrayLike<number>, out: Float64Array | number[]): boolean {
    const rx = pos[0] - this.camPos[0];
    const ry = pos[1] - this.camPos[1];
    const rz = pos[2] - this.camPos[2];
    const zc = rx * this.fwd[0] + ry * this.fwd[1] + rz * this.fwd[2];
    out[2] = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (zc <= 0) return false;
    const xc = rx * this.right[0] + ry * this.right[1] + rz * this.right[2];
    const yc = rx * this.up[0] + ry * this.up[1] + rz * this.up[2];
    out[0] = this.width / 2 + (xc / zc) * this.pxPerRad;
    out[1] = this.height / 2 - (yc / zc) * this.pxPerRad;
    return true;
  }
}

export const engine = new Engine();

// 開發時方便在主控台檢查狀態
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __engine: Engine }).__engine = engine;
}
