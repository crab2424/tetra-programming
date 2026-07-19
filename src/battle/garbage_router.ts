/**
 * 送信側おじゃまルーティングの一本化（CPU戦・オンライン戦共通）。
 *
 * これまで「穴パターン生成」「tetゲージ→おじゃまぷよ変換」「配送」が
 * tet/garbage.js・puyo/ojama.js・online_game.ts の4経路に重複しており、
 * 火力仕様を変えるたびに複数ファイルの同期が必要だった。本モジュールが
 * 唯一の送信経路になる:
 *
 *   エンジン(sendGarbage) → routeGarbage(opts, sink)
 *     sink = LocalSink   … 相手インスタンスの garbageQueue へ積む（CPU戦）
 *     sink = NetworkSink … Garbage/GarbagePuyo フレームを送信（オンライン、online_game.ts が構築）
 *
 * プレーンJSエンジンからは window.BattleGarbage 経由で参照する（main.ts で登録）。
 */

/** 配送先の抽象化。ルールごとのフレーム種別/キュー形式の差はここで吸収する */
export interface GarbageSink {
  /** テト受け手へライン火力を送る（holes は送信側で確定済みの穴パターン） */
  sendTetLines(lines: number, holes: number[]): void;
  /** ぷよ受け手へおじゃまぷよ個数を送る */
  sendOjama(count: number): void;
}

export interface RouteGarbageOptions {
  /** エンジンから渡る火力（意味はモード/ルールにより lines・ゲージ・おじゃま個数） */
  amount: number;
  /** 受け手のルール */
  targetRule: "tet" | "puyo";
  /** テト受け手の盤面列数（穴パターン生成に使用） */
  cols: number;
  /** 連続同穴率（%）。VS設定 vsGarbageHoleRate / matchSetting.garbageHoleRate */
  holeRatePercent: number;
  /** 火力乗率（オンラインの garbageMultiplier）。ローカルは実効化済みなので 1 */
  multiplier?: number;
  /** 送信量の上限（オンラインのwire上限 255 など） */
  maxAmount?: number;
  /**
   * true なら対ぷよ送信時に amount を「tetアタックゲージ→おじゃまぷよ個数」変換する。
   * CPU戦のテト送り手のみ true（オンラインはエンジンが個数を渡すため変換しない）。
   */
  gaugeToOjama?: boolean;
}

/**
 * tetアタックゲージ量→おじゃまぷよ個数の変換テーブル（旧 tet/garbage.js:28-35）。
 * n>=18 は階差数列の一般項 an = (n^2 - 21n + 204)/2。
 */
export function tetGaugeToOjama(amount: number): number {
  const table = [0, 4, 5, 6, 8, 10, 13, 16, 20, 24, 28, 33, 38, 43, 49, 55, 61, 68];
  if (amount < table.length) return table[amount];
  return Math.floor((amount * amount - 21 * amount + 204) / 2);
}

/**
 * テトおじゃまの穴パターンを送信側で確定する（受信側で再計算しない＝全員の盤面表示が一致）。
 * 1段目は完全ランダム、2段目以降は holeRatePercent% で同じ穴・残りで別の穴。
 */
export function buildGarbageHoles(
  count: number,
  cols: number,
  holeRatePercent: number,
): number[] {
  const holes: number[] = [];
  const rate = holeRatePercent / 100;
  let prev = -1;
  for (let i = 0; i < count; i++) {
    let h: number;
    if (prev < 0) {
      h = Math.floor(Math.random() * cols);
    } else if (Math.random() < rate) {
      h = prev;
    } else {
      const offset = Math.floor(Math.random() * (cols - 1)) + 1;
      h = (prev + offset) % cols;
    }
    holes.push(h);
    prev = h;
  }
  return holes;
}

/** 全モード共通の送信入口。乗率→上限→ルール別変換→穴確定→sink 配送の順で処理する */
export function routeGarbage(opts: RouteGarbageOptions, sink: GarbageSink): void {
  if (opts.amount <= 0) return;
  const mult = opts.multiplier ?? 1;
  let adjusted = mult === 1 ? opts.amount : Math.round(opts.amount * mult);
  if (adjusted <= 0) return;

  if (opts.targetRule === "puyo") {
    let ojama = opts.gaugeToOjama ? tetGaugeToOjama(adjusted) : adjusted;
    ojama = Math.min(ojama, opts.maxAmount ?? Infinity);
    if (ojama <= 0) return;
    sink.sendOjama(ojama);
  } else {
    adjusted = Math.min(adjusted, opts.maxAmount ?? Infinity);
    const holes = buildGarbageHoles(adjusted, opts.cols, opts.holeRatePercent);
    sink.sendTetLines(adjusted, holes);
  }
}

// ── LocalSink 用の配送ヘルパ（CPU戦: 相手インスタンスの garbageQueue へ積む） ──

/** garbageQueue に積むエントリ。エンジン(applyGarbage/_generateOjama/相殺)がそのまま消費する */
export interface LocalGarbageObj {
  amount: number;
  holes: number[];
  ready: boolean;
  internal?: boolean;
  internalTimer?: number;
}

/**
 * テト送り手方式: {ready:false} で積み、猶予 delayMs 後に ready 化する
 * （旧 tet/garbage.js:61-97。ポーズ中は受け手側 _garbageTimers で計時停止）。
 */
export function deliverLocalWithReadyTimer(
  opponent: any,
  garbageObj: LocalGarbageObj,
  delayMs: number,
): void {
  if (!opponent.garbageQueue) opponent.garbageQueue = [];
  opponent.garbageQueue.push(garbageObj);
  if (typeof opponent.updateGarbageGauge === "function") {
    opponent.updateGarbageGauge();
  }

  if (!opponent._garbageTimers) opponent._garbageTimers = [];
  const timerEntry: any = {
    obj: garbageObj,
    duration: delayMs,
    remaining: null,
    id: null,
  };
  timerEntry.cb = () => {
    timerEntry.id = null;
    // タイマー発火時に相殺されて消滅していなければ状態変更（青→赤点滅）
    if (opponent.garbageQueue.includes(garbageObj) && garbageObj.amount > 0) {
      garbageObj.ready = true;
      if (typeof opponent.updateGarbageGauge === "function") {
        opponent.updateGarbageGauge();
      }
    }
    const idx = opponent._garbageTimers.indexOf(timerEntry);
    if (idx !== -1) opponent._garbageTimers.splice(idx, 1);
  };
  opponent._garbageTimers.push(timerEntry);

  if (opponent.isPaused) {
    // 受け手がポーズ中なら開始を保留し、resume 時に計時を始める
    timerEntry.remaining = delayMs;
  } else {
    timerEntry.start = performance.now();
    timerEntry.id = setTimeout(timerEntry.cb, delayMs);
  }
}

/**
 * 単純タイマー方式: {ready:false} で積み、delayMs 後に ready 化する（ポーズ非対応）。
 * ぷよエンジンは _garbageTimers のポーズ再開処理を持たないため、ぷよ受け手には
 * こちらを使う（ポーズ中に remaining 保留すると永久に ready 化しなくなる）。
 */
export function deliverLocalSimple(
  opponent: any,
  garbageObj: LocalGarbageObj,
  delayMs: number,
): void {
  if (!opponent.garbageQueue) opponent.garbageQueue = [];
  opponent.garbageQueue.push(garbageObj);
  if (typeof opponent.updateGarbageGauge === "function") {
    opponent.updateGarbageGauge();
  }
  setTimeout(() => {
    if (opponent.garbageQueue?.includes(garbageObj) && garbageObj.amount > 0) {
      garbageObj.ready = true;
      if (typeof opponent.updateGarbageGauge === "function") {
        opponent.updateGarbageGauge();
      }
    }
  }, delayMs);
}

/**
 * ぷよ送り手方式: stage1 {internal:true}（非表示）で積み、internalMs 後に stage2「猶予(青)」へ。
 * stage3(ready) への確定は送り手の連鎖終了時に _confirmSentGarbage が行う（旧 puyo/ojama.js:197-236）。
 * ぷよ受け手は dt ベース(internalTimer)、テト受け手は _garbageTimers(setTimeout) 方式でポーズ対応。
 */
export function deliverLocalStaged(
  opponent: any,
  garbageObj: LocalGarbageObj,
  internalMs: number,
  opponentIsPuyo: boolean,
): void {
  garbageObj.internal = true;
  opponent.garbageQueue.push(garbageObj);

  if (opponentIsPuyo) {
    // ぷよ受け手：受け手の _update が減算する（ポーズ中は _update 非実行で自動停止）
    garbageObj.internalTimer = internalMs;
  } else {
    if (!opponent._garbageTimers) opponent._garbageTimers = [];
    const timerEntry: any = {
      obj: garbageObj,
      duration: internalMs,
      remaining: null,
      id: null,
    };
    timerEntry.cb = () => {
      timerEntry.id = null;
      // 相殺で消滅していなければ stage2(青)へ移す
      if (opponent.garbageQueue.includes(garbageObj) && garbageObj.amount > 0) {
        garbageObj.internal = false;
        if (typeof opponent.updateGarbageGauge === "function") {
          opponent.updateGarbageGauge();
        }
      }
      const idx = opponent._garbageTimers.indexOf(timerEntry);
      if (idx !== -1) opponent._garbageTimers.splice(idx, 1);
    };
    opponent._garbageTimers.push(timerEntry);
    if (opponent.isPaused) {
      timerEntry.remaining = internalMs;
    } else {
      timerEntry.start = performance.now();
      timerEntry.id = setTimeout(timerEntry.cb, internalMs);
    }
  }

  if (typeof opponent.updateGarbageGauge === "function") {
    opponent.updateGarbageGauge();
  }
}

export const BattleGarbage = {
  routeGarbage,
  buildGarbageHoles,
  tetGaugeToOjama,
  deliverLocalWithReadyTimer,
  deliverLocalSimple,
  deliverLocalStaged,
};

// プレーンJSエンジン（public/game/*）からの参照用
declare global {
  interface Window {
    BattleGarbage: typeof BattleGarbage;
  }
}
window.BattleGarbage = BattleGarbage;
