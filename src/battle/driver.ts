import {
  decodeClear,
  decodeLock,
  decodePieceState,
  decodePuyoChain,
  decodePuyoLock,
  decodePuyoPieceState,
  decodePuyoSpawn,
  decodeSpawn,
  decodeHoldState,
  decodeStatsUpdate,
  MatchOpcode,
  BOARD_BUFFER_ROWS,
  BOARD_COLS,
} from "../online/game_protocol";

declare const Mino: new (type?: number | null) => any;
declare const Block: new (x: number, y: number, type: number) => any;
declare const Field: new () => any;
declare const Game: new (prefix?: string | null) => any;
declare const PuyoGame: new (prefix?: string | null) => any;

/**
 * 対戦相手（オポネント）の生成・駆動を表す抽象。CPU戦の相手=AIが操作する実エンジン、
 * オンライン戦の相手=ネットワーク受信で描画だけ行うパペット、と実装は大きく異なるが、
 * どちらも「start/stop」だけのライフサイクルで扱えるようにする。
 *
 * CPU側の非同期ロードと、オンライン側のネットワークパペットを同じ境界で扱う。
 */
export interface OpponentDriver {
  start(): void;
  stop(): void;
}

type NetworkRule = "tet" | "puyo";

export type NetworkDriverOptions = {
  id: string;
  index: number;
  rule: NetworkRule;
  onDead: (id: string) => void;
  onNameDead: (index: number) => void;
  onStats?: (index: number, stats: ReturnType<typeof decodeStatsUpdate>) => void;
};

/**
 * ネットワークで受信した相手盤面を描画する driver。
 *
 * ここはゲームルールの状態を持つ「パペット」と、フレームを適用する処理だけを
 * 担当する。自分宛のGarbage/SE/PendingUpdateや勝敗判定は対戦コントローラの責務
 * として残し、driverの境界を相手1人分に限定している。
 */
export class NetworkDriver implements OpponentDriver {
  readonly id: string;
  readonly index: number;
  readonly rule: NetworkRule;
  readonly puppet: any;
  private readonly onDead: (id: string) => void;
  private readonly onNameDead: (index: number) => void;
  private readonly onStats?: NetworkDriverOptions["onStats"];

  constructor(options: NetworkDriverOptions) {
    this.id = options.id;
    this.index = options.index;
    this.rule = options.rule;
    this.onDead = options.onDead;
    this.onNameDead = options.onNameDead;
    this.onStats = options.onStats;

    if (this.rule === "puyo") {
      this.puppet = new PuyoGame(`ol-opp-${this.index}`);
      this.puppet._setupCanvas();
      this.puppet._initField?.();
      this.puppet.nextQueue = [];
      this.puppet.rng = null;
      this.puppet._loadImages(() => { this.puppet._render?.(); });
    } else {
      this.puppet = new Game(`ol-opp-${this.index}`);
      this.puppet.field = new Field();
      this.puppet.field.blocks = [];
      this.puppet.mino = null;
      this.puppet.nextQueue = [];
      this.puppet.holdMino = null;
      this.puppet.isVersusMode = true;
      this.puppet.drawAll();
    }
  }

  start(): void { /* NetworkDriver is driven by incoming frames. */ }

  stop(): void {
    if (this.puppet?._netChainBlink) {
      clearInterval(this.puppet._netChainBlink);
      this.puppet._netChainBlink = null;
    }
    this.puppet?.stop?.();
  }

  markDead(): void {
    this.onDead(this.id);
    if (this.rule === "puyo") {
      this.puppet.isPaused = true;
      this.puppet._render?.();
    } else {
      this.puppet.mino = null;
      this.puppet.isPaused = true;
      this.puppet.drawAll?.();
    }
    this.onNameDead(this.index);
  }

  setDisconnected(): void {
    if (this.rule === "puyo") {
      this.puppet.isPaused = true;
      this.puppet._render?.();
    } else {
      this.puppet.mino = null;
      this.puppet.drawAll?.();
    }
  }

  applyFrame(opcode: number, payload: Uint8Array): void {
    const puppet = this.puppet;
    switch (opcode) {
      case MatchOpcode.PieceState: {
        if (this.rule !== "tet") return;
        const ps = decodePieceState(payload);
        const mino = new Mino(ps.type);
        for (let r = 0; r < ps.rotation; r++) mino.rotate();
        mino.x = ps.x; mino.y = ps.y;
        puppet.mino = mino;
        requestAnimationFrame(() => puppet.drawAll());
        return;
      }
      case MatchOpcode.Lock: {
        if (this.rule !== "tet") return;
        const boardArr = decodeLock(payload);
        const blocks: any[] = [];
        for (let i = 0; i < boardArr.length; i++) {
          const value = boardArr[i];
          if (value !== 0) blocks.push(new Block(
            i % BOARD_COLS,
            Math.floor(i / BOARD_COLS) - BOARD_BUFFER_ROWS,
            value - 1,
          ));
        }
        puppet.field.blocks = blocks;
        puppet.field.markDirty?.();
        puppet.mino = null;
        puppet.drawAll();
        return;
      }
      case MatchOpcode.Spawn: {
        if (this.rule !== "tet") return;
        const sp = decodeSpawn(payload);
        if (sp.type === 0xff) {
          puppet.nextQueue = sp.nextTypes.filter((t: number) => t !== 0xff).map((t: number) => new Mino(t));
          puppet.holdMino = sp.holdType !== 0xff ? new Mino(sp.holdType) : null;
        } else {
          const mino = new Mino(sp.type);
          mino.spawn();
          puppet.mino = mino;
          puppet.nextQueue = sp.nextTypes.filter((t: number) => t !== 0xff).map((t: number) => new Mino(t));
          puppet.holdMino = sp.holdType !== 0xff ? new Mino(sp.holdType) : null;
        }
        puppet.drawAll();
        return;
      }
      case MatchOpcode.Clear: {
        if (this.rule !== "tet") return;
        const c = decodeClear(payload);
        const tspin = (c.flags & 1) ? "tspin" : null;
        puppet.showActionLabels?.(tspin, c.lines, !!(c.flags & 2), c.combo, !!(c.flags & 4), c.lines === 4 && !tspin);
        return;
      }
      case MatchOpcode.GameOver:
        this.markDead();
        return;
      case MatchOpcode.HoldState:
        if (this.rule !== "tet") return;
        puppet.canHold = decodeHoldState(payload);
        puppet.drawAll?.();
        return;
      case MatchOpcode.StatsUpdate:
        this.onStats?.(this.index, decodeStatsUpdate(payload));
        return;
      case MatchOpcode.PuyoPieceState: {
        if (this.rule !== "puyo" || !puppet._imagesLoaded) return;
        const ps = decodePuyoPieceState(payload);
        puppet.pivotColor = ps.pivotColor; puppet.childColor = ps.childColor;
        puppet.pivotX = ps.pivotX; puppet.pivotY = ps.pivotY;
        puppet.targetRot = ps.rotation; puppet.animRot = ps.rotation; puppet.targetAnimRot = ps.rotation;
        puppet._gs = "falling";
        requestAnimationFrame(() => { if (puppet._imagesLoaded) puppet._render?.(); });
        return;
      }
      case MatchOpcode.PuyoSpawn: {
        if (this.rule !== "puyo") return;
        const sp = decodePuyoSpawn(payload);
        puppet.nextQueue = puppet.nextQueue ?? [];
        if (sp.nextPairs.length > 0) puppet.nextQueue = sp.nextPairs.map((p: [number, number]) => [p[0], p[1]]);
        if (sp.pivotColor !== 0 || sp.childColor !== 0) {
          puppet.pivotColor = sp.pivotColor; puppet.childColor = sp.childColor;
          puppet.pivotX = 2; puppet.pivotY = -0.5;
          puppet.targetRot = 0; puppet.animRot = 0; puppet.targetAnimRot = 0; puppet._gs = "falling";
        }
        if (puppet._imagesLoaded) puppet._render?.();
        return;
      }
      case MatchOpcode.PuyoLock: {
        if (this.rule !== "puyo") return;
        if (puppet._netChainBlink) clearInterval(puppet._netChainBlink);
        puppet._netChainBlink = null; puppet._erasingCells = null;
        puppet.field = decodePuyoLock(payload); puppet._gs = "idle";
        if (puppet._imagesLoaded) puppet._render?.();
        return;
      }
      case MatchOpcode.PuyoChain: {
        if (this.rule !== "puyo") return;
        const chain = decodePuyoChain(payload);
        puppet._erasingCells = chain.cells; puppet._eraseTimer = 0; puppet._gs = "erasing";
        if (puppet._netChainBlink) clearInterval(puppet._netChainBlink);
        const start = performance.now();
        puppet._netChainBlink = setInterval(() => {
          puppet._eraseTimer = performance.now() - start;
          if (puppet._imagesLoaded) puppet._render?.();
          if (puppet._eraseTimer > 320) { clearInterval(puppet._netChainBlink); puppet._netChainBlink = null; }
        }, 50);
        return;
      }
    }
  }
}

declare global {
  interface Window {
    /** cpu_loader.js が定義するグローバル関数（CPUスクリプトの動的ロード） */
    loadCpuWithFallback: (level: number, rule: "tet" | "puyo") => Promise<any>;
    /** 現在アクティブなCPU AIコントローラ。CPU TEST モード(navigation.js)とも共有するグローバル */
    _cpuController: any;
  }
}

/**
 * CPU戦の相手(AI)を非同期にロード・生成する（cpu_loader.js の loadCpuWithFallback をラップ）。
 * 旧 versus.js の startVersusGame 内にあった cpuLoadPromise の生成ロジックをそのまま抽出したもので、
 * 挙動は変えていない：
 *   - 生成した AI コントローラは window._cpuController に代入する
 *     （stopAllGames/CPU TESTモード等、既存の全参照箇所と互換にするため、専用の状態を
 *     新設せず既存のグローバルへ委譲する）
 *   - isStale() が true を返す時点（対戦が再スタート済み等）では代入しない
 *   - 読み込み失敗時は控えめに警告し null を返す（呼び出し側は自由落下にフォールバックする）
 */
export async function loadLocalCpu(
  game: any,
  level: number,
  rule: "tet" | "puyo",
  isStale: () => boolean,
): Promise<any> {
  try {
    const CPUClass = await window.loadCpuWithFallback(level, rule);
    if (CPUClass && !isStale()) {
      if (window._cpuController && typeof window._cpuController.stop === "function") {
        window._cpuController.stop();
      }
      window._cpuController = new CPUClass(game);
    }
    return CPUClass;
  } catch (e) {
    console.warn("CPUスクリプトの読み込みに失敗しました。自由落下になります。");
    return null;
  }
}

export const BattleDriver = { loadLocalCpu, NetworkDriver };

declare global {
  interface Window {
    BattleDriver: typeof BattleDriver;
  }
}
window.BattleDriver = BattleDriver;
