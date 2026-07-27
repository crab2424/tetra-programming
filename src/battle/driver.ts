import {
  decodeClear,
  decodeGameOver,
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
  PuyoLockPhase,
  BOARD_BUFFER_ROWS,
  BOARD_COLS,
} from "../online/game_protocol";
import { showFieldFinish, onlineFieldPrefix } from "./finish_overlay";

declare const Mino: new (type?: number | null) => any;
declare const Block: new (x: number, y: number, type: number) => any;
declare const Field: new () => any;
declare const Game: new (prefix?: string | null) => any;
declare const PuyoGame: new (prefix?: string | null) => any;
/** ぷよエンジンの定数(cellSize/hiddenRows/eraseMs等)。CPU戦と同じ値を bare 参照で使う
 *  （[[project_pconfig_global_gotcha]]と同じ理由でwindow.PConfigは存在しない）。 */
declare const PConfig: any;

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

// PUYO_FIX_CYCLES: 設置振動 _calcFixCycles() の非ソフトドロップ既定値。PConfig 由来ではなく
// エンジンの分岐結果を写した値なので定数として残す（ソフトドロップ状態は相手には送っていない）。
const PUYO_FIX_CYCLES = 2;

/**
 * `#ol-battle-layout` に人数別で設定される `--ol-scale`（src/css/pages/online-battle.css）を
 * 実測して返す。連鎖文字(48px固定DOM)を盤面と同じ縮小率に合わせるために使う
 * （2P=1でCPU戦と実寸一致、3P以降は0.6/0.51875/0.4）。要素が無い/値が読めない場合は1。
 */
function readOlScale(): number {
  const el = document.getElementById("ol-battle-layout");
  if (!el) return 1;
  const raw = getComputedStyle(el).getPropertyValue("--ol-scale").trim();
  const v = parseFloat(raw);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

type PuyoReplayPhase = "idle" | "blink" | "wait" | "drop" | "vib" | "spawnAnim";

/** driver に積まれる相手ぷよの演出イベント（到着順を保持し、実タイミングで再生する）。 */
type PuyoReplayItem =
  | {
      kind: "blink";
      cells: Array<{ r: number; c: number }>;
      chainCount: number;
      /** _prepareChainTextDOM（実エンジンと同じ関数）に渡すグループ境界。 */
      groups: Array<Array<{ r: number; c: number }>>;
    }
  | { kind: "lock"; phase: number; field: number[][] }
  | { kind: "spawn"; nextQueue: number[][] | null; pivotColor: number; childColor: number; hasPair: boolean };

/** 進行中の落下アニメ（ちぎり／連鎖後落下で共用）。 */
interface PuyoDropState {
  target: number[][];
  anims: Array<{ c: number; cells: Array<{ fromR: number; toR: number; color: number; py: number }> }>;
  pxPerMs: number;
  vibCycles: (dropDist: number) => number;
}

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
  // ── 相手ぷよの連鎖/設置リプレイ（案D: 到着順キュー + 実タイミング再生） ──
  private puyoReplayQueue: PuyoReplayItem[] = [];
  private puyoReplayPhase: PuyoReplayPhase = "idle";
  private puyoReplayFrame: number | null = null;
  private puyoReplayLastNow = 0;
  private puyoDrop: PuyoDropState | null = null;
  /** _prepareChainTextDOM に渡すグループ境界。blink開始〜Erase(wait)適用まで保持する
   *  （実エンジンの this.pendingChainGroups と同じ役割）。 */
  private pendingChainGroups: Array<Array<{ r: number; c: number }>> | null = null;
  /** NEXT遷移(spawnAnim)中に保持する、遷移完了後に適用するspawnアイテム。 */
  private pendingSpawn: Extract<PuyoReplayItem, { kind: "spawn" }> | null = null;
  /** 決着後に凍結済みか。以後の受信フレームは全て捨てる。 */
  private frozen = false;
  /**
   * frozen 後も「決着直後に追送される最終スナップショット」（Lock→PieceState、
   * TETのblock-out用）だけは、この時刻までは例外的に受理する。
   * ★ GameOver 受信できずしなくても markDead() 経由で freeze() が同期的に呼ばれるため、
   *   Lock/PieceState は必ず freeze() より後に別メッセージとして届く。ここで短い猶予を
   *   設けないと、致命の原因になった最終盤面と衝突ミノが恒久的に相手へ表示されない。
   */
  private acceptFinalSnapshotUntil: number | null = null;
  /** 相手の初回データ（Spawn/PuyoSpawn＝NEXT等）を受信済みか。ロード画面の待機に使う。 */
  private dataReceived = false;
  private dataResolvers: Array<() => void> = [];

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
      // ★ ALL CLEAR明滅・浮遊フラッシュは実エンジンの this.elapsed 基準（draw.js）。
      //   パペットは _startTimer を回さないため放置すると 0 のまま静止する。
      this.puppet.elapsed = 0;
      // ★ 連鎖文字(48px固定DOM)を --ol-scale に合わせて縮小する（3P以降で相対的に
      //   巨大化しないため）。CPU戦の PuyoGame は既定の undefined(=1倍)のまま。
      this.puppet._chainTextScale = readOlScale();
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

  start(): void {
    // ★ 回転補間・ALL CLEAR明滅・浮遊フラッシュはキューが空でも毎フレーム進む必要があるため、
    //   対戦開始〜stop/freeze/markDeadまで常駐で回す（CPU戦の各PuyoGame自前_loopと同じ本数）。
    if (this.rule === "puyo") this.startPuyoLoop();
  }

  stop(): void {
    this.stopPuyoReplay();
    if (this.rule === "puyo") {
      // ★ freeze() が立てた _versusFinishing を戻す。放置すると puppet.stop() の
      //   キャンバスクリア/cancelAnimationFrame が丸ごとスキップされ続ける
      //   （第4ラウンド③で自分側のPuyoGameに起きた rAF リークと同じ罠）。
      this.puppet._versusFinishing = false;
    }
    this.puppet?.stop?.();
  }

  /** 相手からの最初の Spawn/PuyoSpawn（NEXT等）を受信したときに呼ぶ。 */
  private notifyDataReceived(): void {
    if (this.dataReceived) return;
    this.dataReceived = true;
    const resolvers = this.dataResolvers;
    this.dataResolvers = [];
    for (const r of resolvers) r();
  }

  /** 相手の初回データが届くまで待つ（ロード画面の同期待ちに使う）。既に届いていれば即解決。 */
  waitForFirstData(): Promise<void> {
    if (this.dataReceived) return Promise.resolve();
    return new Promise((resolve) => this.dataResolvers.push(resolve));
  }

  markDead(): void {
    this.onDead(this.id);
    if (this.rule === "puyo") {
      this.stopPuyoReplay();
      this.puppet.isAllClear = false; // ★ ゲームオーバー時にALL CLEARを消す（engine.js _beginGameOver と同じ）
      this.puppet.isPaused = true;
      this.puppet._render?.();
    } else {
      // ★ mino を null にしない: TET の本来の block-out は「出現位置と衝突したミノ」を
      //   残したまま gameOver() を呼ぶ（board.js popMino）。ここで null 化すると死亡直前の
      //   操作ミノだけ消え、実エンジンの見た目（CPU戦と同じ）と異なってしまう。
      this.puppet.isPaused = true;
      this.puppet.drawAll?.();
    }
    // 自分の盤面と同じく、脱落した相手の盤面にも GAME OVER を出す
    // （CPU戦が両盤面へ演出を出すのに合わせる。決着時は showWinner が WIN/LOSE で上書きする）
    showFieldFinish(onlineFieldPrefix(this.index, this.rule), "gameover");
    this.onNameDead(this.index);
  }

  /**
   * 決着時に相手スロットを凍結する（`stop()` と違い盤面は残す）。
   * 進行中の連鎖リプレイ rAF を止め、以後 applyFrame が来ても何も反映しない。
   *
   * ★ `_gs`（puyo）・`mino`（tet）は意図的に触らない。決着直前の操作ぷよ/ミノの
   *   スナップショットをそのまま残すため（2026-07-26 不具合の修正、freeze.ts と同じ理由）。
   */
  freeze(): void {
    if (this.frozen) return;
    this.frozen = true;
    // ★ TETのblock-outは、freeze()がGameOverフレーム処理と同じ呼び出しスタック内で
    //   同期的に呼ばれる（applyFrame内のmarkDead→onDead→…→freeze）。その直後に
    //   別メッセージとして届くLock/PieceStateを取りこぼさないよう、短い猶予を与える。
    if (this.rule === "tet") this.acceptFinalSnapshotUntil = performance.now() + 1500;
    this.stopPuyoReplay();
    this.puyoReplayQueue.length = 0;
    if (this.rule === "puyo") {
      // 実エンジンの停止条件は state。keepCanvas 相当で盤面だけ残す（freeze.ts と同じ作法）。
      this.puppet._versusFinishing = true;
      this.puppet.state = "gameover";
      this.puppet.isPaused = true;
      this.puppet._render?.();
    } else {
      this.puppet.isPaused = true;
      this.puppet.drawAll?.();
    }
  }

  setDisconnected(): void {
    if (this.rule === "puyo") {
      this.stopPuyoReplay();
      this.puppet.isPaused = true;
      this.puppet._render?.();
    } else {
      this.puppet.mino = null;
      this.puppet.drawAll?.();
    }
  }

  /** ワイヤー上の位置情報から実 Mino を組み立てる（PieceState / Spawn / Lock / GameOver 共通）。 */
  private buildMino(p: { type: number; x: number; y: number; rotation: number }): any {
    const mino = new Mino(p.type);
    for (let r = 0; r < p.rotation; r++) mino.rotate();
    mino.x = p.x;
    mino.y = p.y;
    return mino;
  }

  applyFrame(opcode: number, payload: Uint8Array): void {
    if (this.frozen) {
      // ★ TETのblock-outだけは、freeze()直後に追送される Lock（最終盤面＋衝突ミノを同梱）
      //   を短い猶予内だけ通す（online_game.ts の popMino フック参照）。
      //   それ以外（連鎖リプレイ・遅れて届いた古いPieceState等）は従来どおり捨てる。
      const isFinalSnapshot =
        this.rule === "tet" &&
        opcode === MatchOpcode.Lock &&
        this.acceptFinalSnapshotUntil !== null &&
        performance.now() < this.acceptFinalSnapshotUntil;
      if (!isFinalSnapshot) return;
    }
    const puppet = this.puppet;
    switch (opcode) {
      case MatchOpcode.PieceState: {
        if (this.rule === "puyo") {
          if (!puppet._imagesLoaded) return;
          // 連鎖/設置リプレイ中は操作ぷよを描かない（古い落下ぷよが演出に重なるのを防ぐ）。
          if (this.puyoReplayPhase !== "idle" || this.puyoReplayQueue.length > 0) return;
          const ps = decodePuyoPieceState(payload);
          puppet.pivotColor = ps.pivotColor; puppet.childColor = ps.childColor;
          puppet.pivotX = ps.pivotX; puppet.pivotY = ps.pivotY;
          puppet.targetRot = ps.rotation;
          // ★ targetAnimRot は mod を取らない累積値（engine.js）。ワイヤーは mod 256 の
          //   1バイトなので、現在の animRot に最も近い合同値へ復元する（回転演出用）。
          //   animRot 自体はここで代入しない＝_stepRotationAnim が実エンジンと同じ式で追従する。
          const base = Math.round((puppet.animRot ?? 0) / 256) * 256;
          let candidate = base + ps.targetAnimRot;
          if (candidate - puppet.animRot > 128) candidate -= 256;
          else if (candidate - puppet.animRot < -128) candidate += 256;
          puppet.targetAnimRot = candidate;
          puppet._gs = "falling";
          requestAnimationFrame(() => { if (puppet._imagesLoaded) puppet._render?.(); });
          return;
        }
        puppet.mino = this.buildMino(decodePieceState(payload));
        requestAnimationFrame(() => puppet.drawAll());
        return;
      }
      case MatchOpcode.Lock: {
        if (this.rule === "puyo") {
          const { field, phase } = decodePuyoLock(payload);
          this.puyoReplayQueue.push({ kind: "lock", phase, field });
          return;
        }
        const { board, dyingMino } = decodeLock(payload);
        const blocks: any[] = [];
        for (let i = 0; i < board.length; i++) {
          const value = board[i];
          if (value !== 0) blocks.push(new Block(
            i % BOARD_COLS,
            Math.floor(i / BOARD_COLS) - BOARD_BUFFER_ROWS,
            value - 1,
          ));
        }
        puppet.field.blocks = blocks;
        puppet.field.markDirty?.();
        // ★ 致命(block-out)時は、盤面へ固定されなかった衝突ミノが同梱されてくる。
        //   通常の設置Lockでは null（＝次のSpawnまで操作ミノなし）が正しい。
        puppet.mino = dyingMino ? this.buildMino(dyingMino) : null;
        puppet.drawAll();
        return;
      }
      case MatchOpcode.Spawn: {
        this.notifyDataReceived();
        if (this.rule === "puyo") {
          const sp = decodePuyoSpawn(payload);
          // 連鎖リプレイの後に新ペアを出すため、キューへ積んで順序を保つ。
          this.puyoReplayQueue.push({
            kind: "spawn",
            nextQueue: sp.nextPairs.length > 0 ? sp.nextPairs.map((p: [number, number]) => [p[0], p[1]]) : null,
            pivotColor: sp.pivotColor,
            childColor: sp.childColor,
            hasPair: sp.pivotColor !== 0 || sp.childColor !== 0,
          });
          return;
        }
        const sp = decodeSpawn(payload);
        if (sp.type === 0xff) {
          puppet.nextQueue = sp.nextTypes.filter((t: number) => t !== 0xff).map((t: number) => new Mino(t));
          puppet.holdMino = sp.holdType !== 0xff ? new Mino(sp.holdType) : null;
        } else {
          // ★ 出現位置は送信側の実値を使う。Mino.spawn() の既定位置で描くと、
          //   board.js popMino の「衝突時は1マス上へずらす」補正を取りこぼし、
          //   次のPieceStateが届くまで約1フレーム、ミノがスタックに埋まって見える。
          puppet.mino = sp.placement
            ? this.buildMino(sp.placement)
            : (() => { const m = new Mino(sp.type); m.spawn(); return m; })();
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
      case MatchOpcode.GameOver: {
        // ★ TET の block-out（出現位置での致命判定）は、衝突した操作ミノを GameOver
        //   フレームに同梱して送ってくる（online_game.ts）。適用してから凍結することで、
        //   相手にも「本人が見ていた死亡直前の画面」と同じ絵が出る。
        //   直後に届く Lock（最終盤面＋同じ衝突ミノ）が最終的な絵を確定させる。
        if (this.rule === "tet") {
          const { mino } = decodeGameOver(payload);
          if (mino) puppet.mino = this.buildMino(mino);
        }
        this.markDead();
        return;
      }
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
        this.puyoReplayQueue.push({
          kind: "blink",
          cells: chain.cells,
          chainCount: chain.chainCount,
          groups: chain.groups,
        });
        return;
      }
    }
  }

  // ── 相手ぷよ 連鎖/設置リプレイ（案D） ─────────────────────────────────────
  //
  // 送信側は各段階で phase 付き PuyoLock を送る:
  //   Fix   = 初手着地（_beginFixAnimWait, chainCount===0）
  //   Erase = 連鎖の消去直後（_applyErase, 該当セルを消した盤面）
  //   Drop  = 連鎖の落下確定後（_applyDropAnim, 落ち終わった盤面）
  // さらに連鎖開始時の点滅セルは ChainReplay(0x27) で届く。
  // これらを到着順にキューへ積み、実エンジン(PConfig)と同じ時間で
  //   点滅(eraseMs) → 消去swap → 間(eraseWaitMs) → 落下(gravity) → 着地振動
  // と再生する。reliable channel のバースト到着でも「一瞬で確定」せず本来の速度で見える。
  //
  // ★ タイマーの前進は実エンジン(engine.js)から抽出した _step*Anim 系メソッドをそのまま呼ぶ
  //   （PuyoGame.prototype に mixin されているので puppet からも同じ関数が呼べる＝
  //   「CPU戦とコードレベルで統一」）。PuyoGame 本体の状態遷移(_gs)自体には触れないので
  //   物理/RNG/SE/おじゃまの二重発火は起きない。
  //
  // ループは対戦開始(start)〜停止(stop/freeze/markDead)まで常駐で回す。回転補間・
  // ALL CLEAR明滅・浮遊フラッシュはキューが空でも毎フレーム進む必要があるため
  // （旧実装は「やることがない間はrAFを止める」形だったが、これらは常時動く演出のため不可）。

  /** 常駐ループを（動いていなければ）開始する。start() から呼ぶ。 */
  private startPuyoLoop(): void {
    if (this.puyoReplayFrame !== null) return;
    this.puyoReplayLastNow = performance.now();
    this.puyoReplayFrame = requestAnimationFrame((n) => this.stepPuyoLoop(n));
  }

  /** ループを止めてキューを捨てる（stop / freeze / markDead から呼ぶ）。 */
  private stopPuyoReplay(): void {
    if (this.puyoReplayFrame !== null) {
      cancelAnimationFrame(this.puyoReplayFrame);
      this.puyoReplayFrame = null;
    }
    this.puyoReplayQueue = [];
    this.puyoReplayPhase = "idle";
    this.puyoDrop = null;
    this.pendingChainGroups = null;
    this.pendingSpawn = null;
  }

  /** 毎フレーム: 振動・回転・elapsedを進め、現フェーズを1段進め、描画する。 */
  private stepPuyoLoop(now: number): void {
    const puppet = this.puppet;
    const dt = Math.min(100, now - this.puyoReplayLastNow);
    this.puyoReplayLastNow = now;

    // ★ ALL CLEAR明滅・浮遊フラッシュ(draw.js)は this.elapsed 基準。パペットは
    //   _startTimer を回さないので、ここで自前に進めないと常に静止したままになる。
    puppet.elapsed = (puppet.elapsed ?? 0) + dt;
    // 設置振動は実エンジンの _update と同様、フェーズ非依存で毎フレーム前進させる。
    puppet._stepVibAnims(dt);
    // 回転補間はPieceState受信で _gs='falling' になっている間、常に追従させる。
    if (puppet._gs === "falling") puppet._stepRotationAnim(dt);

    if (this.puyoReplayPhase === "idle") {
      this.startNextPuyoItem();
    } else if (this.advancePuyoPhase(dt)) {
      this.puyoReplayPhase = "idle";
      this.startNextPuyoItem();
    }

    if (puppet._imagesLoaded) puppet._render?.();

    this.puyoReplayFrame = requestAnimationFrame((n) => this.stepPuyoLoop(n));
  }

  /** キューから次アイテムを取り出し、時間のかかるフェーズが始まるまで瞬時アイテムを消化する。 */
  private startNextPuyoItem(): void {
    while (this.puyoReplayQueue.length > 0) {
      const item = this.puyoReplayQueue.shift()!;
      if (this.beginPuyoItem(item)) return; // timed フェーズ開始（次フレームで進める）
      // spawn(sentinel) / settle 等の瞬時アイテムは適用済み → 次へ
    }
  }

  /** 1アイテムを開始する。timed フェーズ(blink/wait/drop/vib/spawnAnim)を始めたら true。 */
  private beginPuyoItem(item: PuyoReplayItem): boolean {
    const puppet = this.puppet;
    if (item.kind === "blink") {
      puppet._dropAnim = null;
      puppet._erasingCells = item.cells;
      puppet._eraseTimer = 0;
      puppet._gs = "erasing";
      puppet.chainCount = item.chainCount;
      puppet.isAllClear = false; // ★ 1連鎖発生でALL CLEAR表示を消す（engine.js と同じ）
      this.pendingChainGroups = item.groups;
      this.puyoReplayPhase = "blink";
      return true;
    }
    if (item.kind === "spawn") {
      if (!item.hasPair) {
        // sentinel: カウントダウン中のNEXT早期同期のみ。演出は不要。
        if (item.nextQueue) puppet.nextQueue = item.nextQueue;
        return false;
      }
      // ★ NEXT遷移: 実エンジンと同じ spawnAnim(PConfig.spawnAnimMs) を挟んでから適用する。
      //   受信時点で保持しているnextQueueは「シフト前」の3ペア（PuyoSpawnは_spawnPuyo後に
      //   シフト済みの値を送るため）＝_renderNextの既存スライド演出がそのまま動く。
      this.pendingSpawn = item;
      puppet.spawnAnimTimer = 0;
      puppet._gs = "spawnAnim";
      this.puyoReplayPhase = "spawnAnim";
      return true;
    }
    // item.kind === "lock"
    if (item.phase === PuyoLockPhase.Erase) {
      puppet._dropAnim = null;
      puppet._erasingCells = null;
      puppet.field = this.copyPuyoField(item.field);
      if (this.pendingChainGroups) {
        puppet._prepareChainTextDOM(this.pendingChainGroups); // 実エンジンと同じ関数
        this.pendingChainGroups = null;
      }
      puppet._gs = "eraseWait";
      puppet.eraseWaitTimer = 0;
      this.puyoReplayPhase = "wait"; // 消去後の間(eraseWaitMs)
      return true;
    }
    if (item.phase === PuyoLockPhase.Drop) {
      if (this.setupPuyoDrop(item.field, PConfig.cellSize / 50, (d) => (d >= 2 ? 4 : 3))) {
        this.puyoReplayPhase = "drop";
        return true;
      }
      // 落下差分なし（既に現盤面と一致）→ 確定のみ
      puppet._dropAnim = null;
      puppet.field = this.copyPuyoField(item.field);
      puppet._gs = "idle";
      this.maybeSetAllClear();
      return false;
    }
    // item.phase === Fix
    return this.beginPuyoFix(item.field);
  }

  /**
   * 設置(Fix)スナップショットを実エンジン(engine.js の _fixPuyo/_addPuyoAnim)と同じ表現で始める:
   *   - 通常設置: 最終位置で「その場振動(squash)」（上端からの落下はしない）。
   *   - ちぎり  : 別列・別行の2セルは上(接地)側は静止、下側だけ接地行から落下し着地で振動。
   * 設置でない Fix（連鎖後の重複・おじゃま等）は盤面を確定するだけ。timed フェーズ開始なら true。
   */
  private beginPuyoFix(next: number[][]): boolean {
    const puppet = this.puppet;
    const { newCells, hasRemovalOrChange } = this.diffPuyo(puppet.field as number[][], next);
    const isPlacement =
      !hasRemovalOrChange &&
      newCells.length >= 1 && newCells.length <= 2 &&
      newCells.every((c) => c.color >= 1 && c.color <= 5);
    if (!isPlacement) {
      puppet._dropAnim = null;
      puppet.field = this.copyPuyoField(next);
      puppet._gs = "idle";
      this.maybeSetAllClear();
      return false;
    }

    // ちぎり: 別列・別行 → 上(小行=ロック接地)側は静止、下(大行)側が接地行から落下。
    let falling: { c: number; fromR: number; toR: number; color: number } | null = null;
    let staticCells = newCells;
    if (newCells.length === 2 && newCells[0].c !== newCells[1].c && newCells[0].r !== newCells[1].r) {
      const [hi, lo] = newCells[0].r < newCells[1].r ? [newCells[0], newCells[1]] : [newCells[1], newCells[0]];
      falling = { c: lo.c, fromR: hi.r, toR: lo.r, color: lo.color };
      staticCells = [hi];
    }

    const field = this.copyPuyoField(next);
    if (falling) field[falling.toR][falling.c] = 0; // 落下中セルは一時的に空
    puppet.field = field;
    puppet.mino = null;
    puppet._erasingCells = null;
    puppet._gs = "idle";
    for (const cell of staticCells) puppet._addPuyoAnim?.(cell.r, cell.c, PUYO_FIX_CYCLES);

    if (falling) {
      puppet._dropAnim = [{
        c: falling.c,
        cells: [{
          fromR: falling.fromR, toR: falling.toR, color: falling.color,
          py: (falling.fromR - PConfig.hiddenRows) * PConfig.cellSize,
        }],
      }];
      this.puyoDrop = {
        target: this.copyPuyoField(next),
        anims: puppet._dropAnim,
        // splitting状態(ちぎり)と同じ落下速度。real _stepDropAnim は cellSize/50 固定
        // （'dropping'状態専用）なのでここでは使えず、パラメタライズした自前ループで進める。
        pxPerMs: PConfig.cellSize / PConfig.splitDropSpeed,
        vibCycles: () => PUYO_FIX_CYCLES,
      };
      this.puyoReplayPhase = "drop";
      return true;
    }
    puppet._dropAnim = null;
    this.puyoReplayPhase = "vib";
    return true;
  }

  /** 現フェーズを dt 進める。アイテム完了で true（次アイテムへ）。 */
  private advancePuyoPhase(dt: number): boolean {
    const puppet = this.puppet;
    switch (this.puyoReplayPhase) {
      case "blink": {
        // eraseMs 点滅。消去(Erase)ロックが到着していれば消去へ、未着なら点滅継続。
        puppet._stepEraseBlink(dt);
        return puppet._eraseTimer >= PConfig.eraseMs && this.puyoReplayQueue.length > 0;
      }
      case "wait": {
        // 消去後の間(eraseWaitMs)。次アイテム（落下 or 次連鎖 or spawn）が来ていれば進む。
        puppet._stepEraseWait(dt);
        if (puppet.eraseWaitTimer >= PConfig.eraseWaitMs && this.puyoReplayQueue.length > 0) {
          puppet._clearChainTextDOM(); // 実エンジンと同じタイミング(eraseWait完了時)
          return true;
        }
        return false;
      }
      case "spawnAnim": {
        // NEXT遷移。時間のかかるフェーズだが対応するキュー項目は既に消費済み（pendingSpawn）。
        puppet._stepSpawnAnim(dt);
        if (puppet.spawnAnimTimer < PConfig.spawnAnimMs) return false;
        const item = this.pendingSpawn;
        this.pendingSpawn = null;
        if (item) {
          if (item.nextQueue) puppet.nextQueue = item.nextQueue;
          puppet.pivotColor = item.pivotColor; puppet.childColor = item.childColor;
          puppet.pivotX = 2; puppet.pivotY = -0.5;
          puppet.targetRot = 0; puppet.animRot = 0; puppet.targetAnimRot = 0;
          puppet._dropAnim = null; puppet._erasingCells = null;
        }
        puppet.chainCount = 0; // 実エンジンの spawnAnim→spawn 遷移と同じ
        puppet._gs = "falling";
        return true;
      }
      case "drop": {
        const drop = this.puyoDrop;
        if (!drop) return true;
        let allDone = true;
        for (const col of drop.anims) {
          for (const cell of col.cells) {
            const targetY = (cell.toR - PConfig.hiddenRows) * PConfig.cellSize;
            cell.py = Math.min(cell.py + drop.pxPerMs * dt, targetY);
            if (cell.py < targetY) allDone = false;
          }
        }
        if (!allDone) return false;
        // 着地: 最終盤面へ確定し、落ちたセルを振動させて vib へ継続（同アイテム内）。
        puppet.field = this.copyPuyoField(drop.target);
        puppet._dropAnim = null;
        for (const col of drop.anims) {
          for (const cell of col.cells) {
            if (cell.color === 6) continue; // おじゃまは振動しない
            puppet._addPuyoAnim?.(cell.toR, col.c, drop.vibCycles(cell.toR - cell.fromR));
          }
        }
        this.puyoDrop = null;
        puppet._gs = "idle";
        this.maybeSetAllClear();
        this.puyoReplayPhase = "vib";
        return false;
      }
      case "vib":
        return puppet.activeAnims.length === 0;
    }
    return true;
  }

  /**
   * ALL CLEAR判定を導出する（ワイヤー変更なし）。連鎖の最終Drop/Fixスナップショットを
   * 適用した直後に呼ぶ。★ spawnまで待つと実エンジンの順序（全消し判定→おじゃま降下→
   * spawnAnim）からずれ、おじゃまが降った後の盤面を見て見逃す（engine.js checkErase参照）。
   */
  private maybeSetAllClear(): void {
    const puppet = this.puppet;
    if (puppet.chainCount > 0 && puppet._isFieldEmpty?.()) {
      puppet.isAllClear = true;
    }
  }

  /**
   * 現盤面(prev) → next への落下をアニメ化する。連鎖後落下・おじゃま落下で使う。
   * 落下対象があれば true。
   *
   * ★ 実エンジンの `_buildDropAnim`（engine.js）と同じ「列を下から走査し、空白の
   *   連続数(emptyBelow)を積んで fromR→toR を決める」純粋な重力コラプスを prev だけから
   *   導出する。旧実装は next 側の各セルに対して「直近の未使用の同色セル」を貪欲に
   *   マッチングしていたため、同じ列に同色が複数段積まれている場合に上下の対応が
   *   反転しうる不具合があった（例: 3段のおじゃまが降る際、本来いちばん近い(浅い)段が
   *   いちばん遠くまで落ちるように誤って対応付けられ、「複数段が同じ高さから降ってくる」
   *   ように見えていた）。prev 単体からの走査は相対順序を必ず保つため反転しない。
   */
  private setupPuyoDrop(next: number[][], pxPerMs: number, vibCycles: (d: number) => number): boolean {
    const puppet = this.puppet;
    const prev = puppet.field as number[][];
    const field = this.copyPuyoField(next);
    const anims: PuyoDropState["anims"] = [];
    const rows = next.length;
    const cols = rows > 0 ? next[0].length : 6;

    for (let c = 0; c < cols; c++) {
      let emptyBelow = 0;
      const cells: Array<{ fromR: number; toR: number; color: number; py: number }> = [];
      for (let r = rows - 1; r >= 0; r--) {
        const color = prev[r]?.[c] ?? 0;
        if (!color) {
          emptyBelow++;
        } else if (emptyBelow > 0) {
          const toR = r + emptyBelow;
          cells.push({ fromR: r, toR, color, py: (r - PConfig.hiddenRows) * PConfig.cellSize });
          field[toR][c] = 0;
        }
      }
      if (cells.length > 0) anims.push({ c, cells });
    }

    if (anims.length === 0) return false;
    puppet.field = field;
    puppet._dropAnim = anims;
    puppet._gs = "dropping";
    this.puyoDrop = { target: this.copyPuyoField(next), anims, pxPerMs, vibCycles };
    return true;
  }

  /** prev → next の盤面差分。純増分セルと「消去/移動を含むか」を返す。 */
  private diffPuyo(
    prev: number[][],
    next: number[][],
  ): { newCells: Array<{ r: number; c: number; color: number }>; hasRemovalOrChange: boolean } {
    const rows = next.length;
    const cols = rows > 0 ? next[0].length : 6;
    const newCells: Array<{ r: number; c: number; color: number }> = [];
    let hasRemovalOrChange = false;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const nx = next[r]?.[c] ?? 0;
        const pv = prev[r]?.[c] ?? 0;
        if (nx === pv) continue;
        if (pv === 0 && nx !== 0) newCells.push({ r, c, color: nx });
        else hasRemovalOrChange = true;
      }
    }
    return { newCells, hasRemovalOrChange };
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
