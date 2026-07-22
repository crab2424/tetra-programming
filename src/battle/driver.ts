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
  private puyoSnapshot: number[][] | null = null;
  private puyoDropFrame: number | null = null;
  /** 進行中パペットアニメの世代トークン。新スナップショット到着で旧 RAF tick を無効化する。 */
  private puyoAnimGen = 0;

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
      this.puyoSnapshot = this.copyPuyoField(this.puppet.field);
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
    if (this.puyoDropFrame !== null) {
      cancelAnimationFrame(this.puyoDropFrame);
      this.puyoDropFrame = null;
    }
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
        if (this.rule === "puyo") {
          if (!puppet._imagesLoaded) return;
          const ps = decodePuyoPieceState(payload);
          puppet.pivotColor = ps.pivotColor; puppet.childColor = ps.childColor;
          puppet.pivotX = ps.pivotX; puppet.pivotY = ps.pivotY;
          puppet.targetRot = ps.rotation; puppet.animRot = ps.rotation; puppet.targetAnimRot = ps.rotation;
          puppet._gs = "falling";
          requestAnimationFrame(() => { if (puppet._imagesLoaded) puppet._render?.(); });
          return;
        }
        const ps = decodePieceState(payload);
        const mino = new Mino(ps.type);
        for (let r = 0; r < ps.rotation; r++) mino.rotate();
        mino.x = ps.x; mino.y = ps.y;
        puppet.mino = mino;
        requestAnimationFrame(() => puppet.drawAll());
        return;
      }
      case MatchOpcode.Lock: {
        if (this.rule === "puyo") {
          if (puppet._netChainBlink) clearInterval(puppet._netChainBlink);
          puppet._netChainBlink = null; puppet._erasingCells = null;
          this.applyPuyoSnapshot(decodePuyoLock(payload));
          if (puppet._imagesLoaded) puppet._render?.();
          return;
        }
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
        if (this.rule === "puyo") {
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
      case MatchOpcode.ChainReplay: {
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

  /**
   * ネットワーク盤面スナップショットを描画へ反映する。
   *
   * 送信側は fix(_beginFixAnimWait)／erase(_applyErase)／drop(_applyDropAnim) の各直後に
   * 同じ opcode(0x22) でフル盤面を送るため、受信側は盤面差分の形から種類を判別する:
   *   - 純増分(色→追加のみ・通常色1〜5が1〜2個)  = 設置(fix) → 実エンジンと同じ「その場振動＋ちぎり落下」
   *   - それ以外(色→0の消去・移動・おじゃま色6)   = 連鎖/おじゃま → 従来の差分落下で近似（案D で置換予定）
   */
  private applyPuyoSnapshot(next: number[][]): void {
    const previous = this.puyoSnapshot ?? this.copyPuyoField(this.puppet.field);
    const rows = next.length;
    const cols = rows > 0 ? next[0].length : 6;

    const newCells: Array<{ r: number; c: number; color: number }> = [];
    let hasRemovalOrChange = false;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const nx = next[r]?.[c] ?? 0;
        const pv = previous[r]?.[c] ?? 0;
        if (nx === pv) continue;
        if (pv === 0 && nx !== 0) newCells.push({ r, c, color: nx });
        else hasRemovalOrChange = true; // 消去(色→0) / 落下移動 / おじゃま上端退避
      }
    }

    // 設置(fix)判定: 消去/移動を含まず、通常色(1..5)のペアが1〜2個だけ増えた純増分のみ。
    // おじゃま(色6・多数・上端から落下)は hasRemovalOrChange か色/個数条件で自然に除外される。
    const isPlacement =
      !hasRemovalOrChange &&
      newCells.length >= 1 && newCells.length <= 2 &&
      newCells.every((cell) => cell.color >= 1 && cell.color <= 5);

    if (isPlacement) this.applyPuyoPlacement(next, newCells);
    else this.applyPuyoChainDiff(previous, next);
  }

  /**
   * 設置(fix)スナップショットを実エンジン(engine.js の _fixPuyo/_addPuyoAnim)と同じ表現で再生する:
   *   - 通常設置: 各ぷよを最終位置で「その場振動(squash)」させる（上端からの落下はしない）。
   *   - ちぎり  : 別列・別行の2セルは、上(接地)側は静止、下側だけロック接地行から実際に落として着地時に振動。
   * パペットは _loop を持たないため、振動タイマー(activeAnims)と落下(_dropAnim)を専用 RAF tick で進める。
   */
  private applyPuyoPlacement(
    next: number[][],
    newCells: Array<{ r: number; c: number; color: number }>,
  ): void {
    const puppet = this.puppet;
    this.puyoSnapshot = this.copyPuyoField(next);

    const CS = 32;      // PConfig.cellSize
    const HIDDEN = 5;   // PConfig.hiddenRows
    const CYCLES = 2;   // 実エンジン _calcFixCycles の非ソフトドロップ既定と同値

    // ちぎり: 別列・別行 → 上(小行=ロック接地)側は静止、下(大行)側が接地行から落下する。
    let falling: { c: number; fromR: number; toR: number; color: number } | null = null;
    let staticCells = newCells;
    if (newCells.length === 2 && newCells[0].c !== newCells[1].c && newCells[0].r !== newCells[1].r) {
      const [hi, lo] = newCells[0].r < newCells[1].r ? [newCells[0], newCells[1]] : [newCells[1], newCells[0]];
      falling = { c: lo.c, fromR: hi.r, toR: lo.r, color: lo.color };
      staticCells = [hi];
    }

    // 表示フィールド: 落下中セルだけ一時的に空にして二重描画を防ぐ。
    const field = this.copyPuyoField(next);
    if (falling) field[falling.toR][falling.c] = 0;
    puppet.field = field;
    puppet.mino = null;
    puppet._erasingCells = null;
    puppet._gs = "idle";

    // 静止セルは即振動。
    for (const cell of staticCells) puppet._addPuyoAnim?.(cell.r, cell.c, CYCLES);

    puppet._dropAnim = falling
      ? [{ c: falling.c, cells: [{ fromR: falling.fromR, color: falling.color, py: (falling.fromR - HIDDEN) * CS }] }]
      : null;

    const gen = this.beginPuyoAnim();
    const dropDurMs = falling ? Math.max(60, (falling.toR - falling.fromR) * 40) : 0;
    const start = performance.now();
    let last = start;
    const tick = (now: number) => {
      if (gen !== this.puyoAnimGen) return; // 新スナップショットで無効化された
      const dt = now - last;
      last = now;

      // 振動タイマー前進（engine.js:198-201 と同じ: 進めて満了を除去）。
      for (const a of puppet.activeAnims) a.timer += dt;
      puppet.activeAnims = puppet.activeAnims.filter((a: any) => a.timer < a.duration);

      // ちぎり落下前進。着地したら最終盤面へ戻して着地セルを振動させる。
      let dropDone = true;
      if (falling && puppet._dropAnim) {
        const progress = Math.min(1, (now - start) / dropDurMs);
        puppet._dropAnim[0].cells[0].py = (falling.fromR - HIDDEN) * CS + (falling.toR - falling.fromR) * CS * progress;
        if (progress >= 1) {
          puppet.field = this.copyPuyoField(next);
          puppet._dropAnim = null;
          puppet._addPuyoAnim?.(falling.toR, falling.c, CYCLES);
          falling = null;
        } else {
          dropDone = false;
        }
      }

      puppet._render?.();

      if (dropDone && puppet.activeAnims.length === 0) {
        puppet._dropAnim = null;
        puppet._gs = "idle";
        puppet._render?.();
        this.puyoDropFrame = null;
        return;
      }
      this.puyoDropFrame = requestAnimationFrame(tick);
    };
    this.puyoDropFrame = requestAnimationFrame(tick);
  }

  /** 連鎖の消去後落下・おじゃま落下を、盤面差分から落下アニメで近似する（案D で正式再生へ置換予定）。 */
  private applyPuyoChainDiff(previous: number[][], next: number[][]): void {
    const puppet = this.puppet;
    const field = this.copyPuyoField(next);
    const anims: Array<{ c: number; cells: Array<{ fromR: number; toR: number; color: number; py: number }> }> = [];
    const rows = next.length;
    const cols = rows > 0 ? next[0].length : 6;

    for (let c = 0; c < cols; c++) {
      const used = new Set<number>();
      const cells: Array<{ fromR: number; toR: number; color: number; py: number }> = [];
      for (let toR = 0; toR < rows; toR++) {
        const color = next[toR]?.[c] ?? 0;
        if (!color) continue;
        if ((previous[toR]?.[c] ?? 0) === color) {
          used.add(toR);
          continue;
        }
        let fromR = -1;
        for (let r = toR - 1; r >= 0; r--) {
          if (!used.has(r) && (previous[r]?.[c] ?? 0) === color) {
            fromR = r;
            break;
          }
        }
        if (fromR < 0) fromR = Math.min(toR - 1, 0);
        if (fromR >= toR) continue;
        used.add(fromR);
        field[toR][c] = 0;
        cells.push({ fromR, toR, color, py: (fromR - 5) * 32 });
      }
      if (cells.length > 0) anims.push({ c, cells });
    }

    this.puyoSnapshot = this.copyPuyoField(next);
    puppet.field = field;
    puppet._dropAnim = anims.length > 0 ? anims : null;
    puppet._gs = anims.length > 0 ? "dropping" : "idle";

    const gen = this.beginPuyoAnim();
    if (anims.length === 0) return;

    const start = performance.now();
    const tick = (now: number) => {
      if (gen !== this.puyoAnimGen) return;
      const progress = Math.min(1, (now - start) / 180);
      let done = progress >= 1;
      for (const column of anims) {
        for (const cell of column.cells) {
          const targetY = (cell.toR - 5) * 32;
          cell.py = (cell.fromR - 5) * 32 + (targetY - (cell.fromR - 5) * 32) * progress;
          if (progress < 1) done = false;
        }
      }
      puppet._render?.();
      if (done) {
        puppet.field = this.copyPuyoField(next);
        puppet._dropAnim = null;
        puppet._gs = "idle";
        puppet._render?.();
        this.puyoDropFrame = null;
      } else {
        this.puyoDropFrame = requestAnimationFrame(tick);
      }
    };
    this.puyoDropFrame = requestAnimationFrame(tick);
  }

  /** 新しいパペットアニメを開始する。旧 RAF tick を無効化し、新しい世代トークンを返す。 */
  private beginPuyoAnim(): number {
    if (this.puyoDropFrame !== null) {
      cancelAnimationFrame(this.puyoDropFrame);
      this.puyoDropFrame = null;
    }
    return ++this.puyoAnimGen;
  }

  private copyPuyoField(field: number[][] | undefined): number[][] {
    return (field ?? []).map((row) => [...row]);
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
