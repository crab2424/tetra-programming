// Binary protocol for match data (0x2N opcodes).
// Server receives [opcode(1)][payload...] and relays as [opcode(1)][sender_uuid(16)][payload...].
// Encode functions return the raw send frame; decode functions receive the relayed payload
// (already stripped of opcode + UUID).

import { Payload, type Uuid } from "./payload.js";

// ── Opcodes ────────────────────────────────────────────────────────────
export const MatchOpcode = {
  PieceState: 0x20,    // unreliable: falling piece position (high-frequency)
  Spawn: 0x21,         // reliable: new piece spawned + next queue snapshot
  Lock: 0x22,          // reliable: piece locked + full board snapshot
  Clear: 0x23,         // reliable: lines cleared with flags
  Garbage: 0x24,       // reliable: garbage lines incoming
  Hold: 0x25,          // reliable: piece held
  GameOver: 0x26,      // reliable: player game over
  ChainReplay: 0x27,   // reliable: puyo chain board snapshot
  SE: 0x28,            // reliable: sound effect sync
  PendingUpdate: 0x29, // reliable: self incoming-garbage gauge state
  HoldState: 0x2a,    // reliable: current hold availability (0/1)
  StatsUpdate: 0x2b,  // reliable: display-only score/lines/chains snapshot
  /**
   * reliable: puyo送り手の連鎖終了トリガー（_confirmSentGarbage 発火の通知）。
   * CPU戦は送信元と着弾先が同一メモリ空間のためオブジェクト参照で ready 化できるが、
   * online は別プロセスなので明示フレームが要る。Hold(0x25) と opcode を共有するが
   * Hold(tetのホールド確定)は encodeHold/decodeHold とも未使用のため衝突しない。
   */
  GarbageConfirm: 0x25,
  // ── Rule-dependent payloads share the 0x20..0x28 opcodes ───────────
  // 受信側のルールはルーム情報で既知なので、TET/PUYO で opcode を分けない。
  PuyoPieceState: 0x20, // unreliable: puyo pair position/rotation (high-freq)
  PuyoSpawn: 0x21,      // reliable: new pair spawned + next queue
  PuyoLock: 0x22,       // reliable: full field snapshot
  GarbagePuyo: 0x24,    // reliable: ojama count + column sequence
  PuyoChain: 0x27,      // reliable: 連鎖消去開始（点滅するセル一覧 + 連鎖数）
} as const;
export type MatchOpcodeValue = typeof MatchOpcode[keyof typeof MatchOpcode];

// ── Board constants ────────────────────────────────────────────────────
export const BOARD_ROWS = 20;
export const BOARD_COLS = 10;
/**
 * 可視20行の上に持つバッファ行数。おじゃませり上がりで applyGarbage が全ブロックを
 * y-=1 するため、スタックは y<0（盤面上端より上）へはみ出す。可視行だけを送ると
 * せり上がった地形が相手の盤面から消えるので、y=-20..19 の40行を送る。
 */
export const BOARD_BUFFER_ROWS = 20;
export const BOARD_TOTAL_ROWS = BOARD_ROWS + BOARD_BUFFER_ROWS; // 40
export const BOARD_SIZE = BOARD_TOTAL_ROWS * BOARD_COLS; // 400 bytes

// ── Puyo board constants (PConfig.rows+hiddenRows × PConfig.cols) ──────
export const PUYO_ROWS = 17; // PConfig.rows(12) + PConfig.hiddenRows(5)
export const PUYO_COLS = 6;
export const PUYO_FIELD_SIZE = PUYO_ROWS * PUYO_COLS; // 102 bytes

// ── Seeded PRNG (shared tumo) ──────────────────────────────────────────
// StartMatchNotification.seed (16 bytes) から決定的な乱数列を生成する。
// 全クライアントが同じシードを使うことでツモ列が完全一致する (sfc32)。
export function createSeededRng(seedBytes: number[]): () => number {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = seedBytes[i] ?? 0;
  const dv = new DataView(bytes.buffer);
  let a = dv.getUint32(0, true);
  let b = dv.getUint32(4, true);
  let c = dv.getUint32(8, true);
  let d = dv.getUint32(12, true);
  const next = (): number => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  // 初期状態の偏りを除くウォームアップ
  for (let i = 0; i < 12; i++) next();
  return next;
}

// ── Parsed relay frame ─────────────────────────────────────────────────
export interface MatchFrame {
  opcode: number;
  senderId: Uuid;
  payload: Uint8Array;
}

export function parseMatchFrame(buf: Uint8Array): MatchFrame | null {
  if (buf.length < 17) return null;
  const opcode = buf[0];
  if (opcode < 0x20 || opcode > 0x3F) return null;
  const senderId = Payload.bytesToUuid(Array.from(buf.slice(1, 17)));
  return { opcode, senderId, payload: buf.slice(17) };
}

// ── Encode helpers (returns frame bytes sent to server) ────────────────

// PieceState: 5 bytes (opcode + type + x+64 + y+64 + rotation)
// x/y offset by 64 to allow negative coords without sign handling
export function encodePieceState(
  type: number, x: number, y: number, rotation: number,
): Uint8Array {
  return new Uint8Array([
    MatchOpcode.PieceState,
    type & 0xff,
    (x + 64) & 0xff,
    (y + 64) & 0xff,
    rotation & 0xff,
  ]);
}

/**
 * 操作ミノの位置。Spawn / Lock に同梱して「相手が実際に見ている絵」を1フレームの
 * ずれもなく再現するために使う（x/y は負値を扱うため +64 オフセットで格納する）。
 */
export interface MinoPlacement { type: number; x: number; y: number; rotation: number }

// Spawn: 8 bytes (opcode + type + holdType + next[5])
//        出現位置つきの場合は 11 bytes (+ x+64, y+64, rotation)。
// ★ 位置を必ず同梱する理由: board.js popMino は出現位置が既存ブロックと衝突するとき
//   `mino.y -= 1` で1マス上へずらす（致命判定間際に必ず起きる）。受信側が Mino.spawn() の
//   既定位置で描くと、この補正を取りこぼしてミノがスタックに埋まった絵が
//   次の PieceState(16ms間隔・unreliable) が届くまで約1フレーム表示されてしまう。
export function encodeSpawn(
  type: number, holdType: number, nextTypes: number[], placement?: MinoPlacement,
): Uint8Array {
  const buf = new Uint8Array(placement ? 11 : 8);
  buf[0] = MatchOpcode.Spawn;
  buf[1] = type & 0xff;
  buf[2] = holdType & 0xff; // 0xff = no hold
  for (let i = 0; i < 5; i++) buf[3 + i] = (nextTypes[i] ?? 0xff) & 0xff;
  if (placement) {
    buf[8] = (placement.x + 64) & 0xff;
    buf[9] = (placement.y + 64) & 0xff;
    buf[10] = placement.rotation & 0xff;
  }
  return buf;
}

// Lock: 1 + BOARD_SIZE bytes (opcode + 400 board bytes, row-major)
// boardTypes[row * 10 + col] = block type (0 = empty, 1-8 = type 0-7)
// row 0 = y=-BOARD_BUFFER_ROWS（上方バッファ最上段）, row 20 = y=0（可視最上段）
// 致命時のみ末尾4バイト(type, x+64, y+64, rotation)に「盤面へ固定されなかった衝突ミノ」を同梱する。
//
// ★ なぜ Lock に相乗りするのか: PieceState(0x20) はサーバーが reliable チャネルで
//   明示的に拒否する（tetra-server の connection/reliable.rs）ため、致命直後の確定した
//   絵を PieceState で送ることはできない。Lock(0x22) は reliable 中継が許可されており、
//   盤面と衝突ミノを1フレームで原子的に送れるので順序の心配もない。
export function encodeLock(boardTypes: number[], dyingMino?: MinoPlacement): Uint8Array {
  const buf = new Uint8Array(1 + BOARD_SIZE + (dyingMino ? 4 : 0));
  buf[0] = MatchOpcode.Lock;
  for (let i = 0; i < BOARD_SIZE; i++) buf[1 + i] = (boardTypes[i] ?? 0) & 0xff;
  if (dyingMino) {
    buf[1 + BOARD_SIZE] = dyingMino.type & 0xff;
    buf[2 + BOARD_SIZE] = (dyingMino.x + 64) & 0xff;
    buf[3 + BOARD_SIZE] = (dyingMino.y + 64) & 0xff;
    buf[4 + BOARD_SIZE] = dyingMino.rotation & 0xff;
  }
  return buf;
}

// Clear: 4 bytes (opcode + lines + flags + combo)
// flags: bit0=T-spin, bit1=B2B, bit2=PC
export function encodeClear(lines: number, flags: number, combo: number): Uint8Array {
  return new Uint8Array([MatchOpcode.Clear, lines & 0xff, flags & 0xff, combo & 0xff]);
}

const GARBAGE_PROTOCOL_VERSION = 1;
const MAX_GARBAGE_AMOUNT = 1000;

// Garbage: opcode + version:u8 + amount:u16(LE) + holes:u8[amount]
// TET受信時の holes は穴X座標、PUYO受信時はおじゃま列番号。
export function encodeGarbage(lines: number, holes?: number[]): Uint8Array {
  const n = Math.max(0, Math.min(MAX_GARBAGE_AMOUNT, Math.trunc(lines)));
  const buf = new Uint8Array(1 + 1 + 2 + n);
  buf[0] = MatchOpcode.Garbage;
  buf[1] = GARBAGE_PROTOCOL_VERSION;
  new DataView(buf.buffer).setUint16(2, n, true);
  for (let i = 0; i < n; i++) {
    buf[4 + i] = (holes?.[i] ?? 0) & 0xff;
  }
  return buf;
}

// Hold: 2 bytes (opcode + type, 0xff = empty)
export function encodeHold(type: number): Uint8Array {
  return new Uint8Array([MatchOpcode.Hold, type & 0xff]);
}

// GameOver: 2 bytes (opcode + hasMino=0), or 6 bytes with a colliding TET piece attached.
// ★ TET の block-out（出現位置での致命判定）は、衝突した操作ミノをフィールドに固定せず
//   this.mino に残したまま gameOver() を呼ぶ（board.js popMino）。このミノを同梱しないと、
//   相手側パペットは「death直前の1手前」の盤面で止まったまま見える。
export interface GameOverMino { type: number; x: number; y: number; rotation: number }
export function encodeGameOver(mino?: GameOverMino): Uint8Array {
  if (!mino) return new Uint8Array([MatchOpcode.GameOver, 0]);
  return new Uint8Array([
    MatchOpcode.GameOver,
    1,
    mino.type & 0xff,
    (mino.x + 64) & 0xff,
    (mino.y + 64) & 0xff,
    mino.rotation & 0xff,
  ]);
}
export interface GameOverData { mino: GameOverMino | null }
export function decodeGameOver(p: Uint8Array): GameOverData {
  if ((p[0] ?? 0) !== 1) return { mino: null };
  return {
    mino: {
      type: p[1] ?? 0,
      x: (p[2] ?? 64) - 64,
      y: (p[3] ?? 64) - 64,
      rotation: p[4] ?? 0,
    },
  };
}

// SE: 2 bytes (opcode + seId)
export function encodeSE(seId: number): Uint8Array {
  return new Uint8Array([MatchOpcode.SE, seId & 0xff]);
}

// PendingUpdate: 自分の incoming-garbage ゲージ状態（＋TETのアタックゲージ状態）を
// 相手へ通知する（相手スロットの予告ゲージ／アタックゲージ表示に使用）。
// 6 bytes: opcode + ready(u8) + unready(u8) + attack(u16 LE) + attackVisible(u8)。
// ★ 新opcodeは切らず既存0x29のpayloadを後方互換拡張。サーバー(reliable.rs)は
//   opcode 0x20-0x2Bをそのまま中継するだけでpayload長は見ないため、サーバー変更不要。
// attack/attackVisible は tet が対ぷよ戦で溜める送信用火力(pendingAttack)の表示同期用
// （tet同士・puyo送信では常に 0/false。旧クライアント(3バイト)から見ればready/unready
// はそのまま読め、attackはbyteLengthガードで0扱いになる＝相互に安全）。
export function encodePendingUpdate(
  ready: number, unready: number, attack: number = 0, attackVisible: boolean = false,
): Uint8Array {
  const buf = new Uint8Array(6);
  const view = new DataView(buf.buffer);
  buf[0] = MatchOpcode.PendingUpdate;
  buf[1] = ready & 0xff;
  buf[2] = unready & 0xff;
  view.setUint16(3, Math.max(0, Math.min(0xffff, Math.trunc(attack))), true);
  buf[5] = attackVisible ? 1 : 0;
  return buf;
}
export interface PendingUpdateData { ready: number; unready: number; attack: number; attackVisible: boolean; }
export function decodePendingUpdate(p: Uint8Array): PendingUpdateData {
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
  return {
    ready: p[0] ?? 0,
    unready: p[1] ?? 0,
    attack: p.byteLength >= 4 ? view.getUint16(2, true) : 0,
    attackVisible: p.byteLength >= 5 ? p[4] !== 0 : false,
  };
}

export function encodeHoldState(canHold: boolean): Uint8Array {
  return new Uint8Array([MatchOpcode.HoldState, canHold ? 1 : 0]);
}

export function decodeHoldState(p: Uint8Array): boolean {
  return (p[0] ?? 0) !== 0;
}

// GarbageConfirm: 2 bytes (opcode + 1 dummy byte).
// ★ サーバー(reliable.rs)は data.len() < 2 のフレームを opcode 判定前に破棄するため、
//   opcode 1バイトだけだと中継されず相手に届かない。ダミー1バイトを足して最小長を満たす。
//   受信側は opcode しか見ないので2バイト目の値は不問。
export function encodeGarbageConfirm(): Uint8Array {
  return new Uint8Array([MatchOpcode.GarbageConfirm, 0]);
}

export type StatsRule = "tet" | "puyo";
export interface StatsUpdateData {
  rule: StatsRule;
  score: number;
  lines: number;
  chainMax: number;
  /** APM/LPM算出用の累積送信攻撃量（tet単位）。旧クライアント(v2.1.0以前)からは常に0 */
  attackSent: number;
  /** APM/LPM算出用の実プレイ経過ms（ポーズ除く）。旧クライアントからは常に0 */
  activeMs: number;
}

// StatsUpdate: opcode + rule(0=tet/1=puyo) + score(u32 LE) + lines(u16 LE) + chainMax(u16 LE)
//              + attackSent(u16 LE) + activeMs(u32 LE)
// ★ 末尾2フィールドはv2.1.1で追加。decode側はbyteLengthガード付きなので、
//   旧v2.1.0クライアント(10byte)からの受信でも安全に0として解釈できる（後方互換）。
export function encodeStatsUpdate(
  rule: StatsRule, score: number, lines: number, chainMax: number,
  attackSent = 0, activeMs = 0,
): Uint8Array {
  const buf = new Uint8Array(16);
  const view = new DataView(buf.buffer);
  buf[0] = MatchOpcode.StatsUpdate;
  buf[1] = rule === "puyo" ? 1 : 0;
  view.setUint32(2, Math.max(0, Math.min(0xffffffff, Math.trunc(score))), true);
  view.setUint16(6, Math.max(0, Math.min(0xffff, Math.trunc(lines))), true);
  view.setUint16(8, Math.max(0, Math.min(0xffff, Math.trunc(chainMax))), true);
  view.setUint16(10, Math.max(0, Math.min(0xffff, Math.trunc(attackSent))), true);
  view.setUint32(12, Math.max(0, Math.min(0xffffffff, Math.trunc(activeMs))), true);
  return buf;
}

export function decodeStatsUpdate(p: Uint8Array): StatsUpdateData {
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
  return {
    rule: p[0] === 1 ? "puyo" : "tet",
    score: p.byteLength >= 5 ? view.getUint32(1, true) : 0,
    lines: p.byteLength >= 7 ? view.getUint16(5, true) : 0,
    chainMax: p.byteLength >= 9 ? view.getUint16(7, true) : 0,
    attackSent: p.byteLength >= 11 ? view.getUint16(9, true) : 0,
    activeMs: p.byteLength >= 15 ? view.getUint32(11, true) : 0,
  };
}

// ── SE name → ID table (送受信ともに使用) ─────────────────────────────
// 相手の操作音も自分と同じように聞こえるよう、操作系(move/rotate/softdrop)も含めて
// エンジンが鳴らす SE は原則すべて同期する。1フレーム2バイト・reliable 中継で、
// 高頻度なもの（softdrop は毎マス、move は DAS 中に連続）でも実測の帯域影響は小さい。
// ★ ID は追加専用（既存の値は変えない）。未知IDは受信側で SE_NAMES 逆引きが失敗して
//   無視されるだけなので、新旧クライアントの混在でも安全。
export const SE_IDS: Record<string, number> = {
  // tet
  lock: 1,
  lock_hard: 2,
  tspin: 3,
  '4lines': 4,
  '3lines': 5,
  '2lines': 6,
  '1line': 7,
  harddrop: 8,
  hold: 9,
  gameover: 10, // tet/puyo 共通のゲームオーバー音
  // puyo
  puyo_fix: 12,
  puyo_drop: 13,
  puyo_chain1: 14,
  puyo_chain2: 15,
  puyo_chain3: 16,
  puyo_chain4: 17,
  puyo_chain5: 18,
  puyo_chain6: 19,
  puyo_chain7: 20,
  puyo_rotate: 21,
  // 操作系（旧実装では「高頻度」を理由に同期対象外だった分）
  rotate: 22,      // tet 通常回転
  tspin_rot: 23,   // tet T-spin 成立回転
  move: 24,        // tet 横移動
  drop: 25,        // tet ソフトドロップ（毎マス）
  puyo_move: 26,   // puyo 横移動
};
// ID → name の逆引き
export const SE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(SE_IDS).map(([k, v]) => [v, k]),
);

// ── Decode helpers (called with frame.payload) ─────────────────────────

export interface PieceStateData {
  type: number; x: number; y: number; rotation: number;
}
export function decodePieceState(p: Uint8Array): PieceStateData {
  return { type: p[0], x: p[1] - 64, y: p[2] - 64, rotation: p[3] };
}

export interface SpawnData {
  type: number; holdType: number; nextTypes: number[];
  /** 出現位置。旧形式(8バイト)や NEXT/HOLD だけの sentinel では null。 */
  placement: MinoPlacement | null;
}
export function decodeSpawn(p: Uint8Array): SpawnData {
  const type = p[0];
  return {
    type,
    holdType: p[1],
    nextTypes: Array.from(p.slice(2, 7)),
    placement: p.length >= 10
      ? { type, x: p[7] - 64, y: p[8] - 64, rotation: p[9] }
      : null,
  };
}

// board: 400要素(row-major, 0=空)。dyingMino は致命時のみ（盤面へ固定されなかった衝突ミノ）。
export interface LockData { board: number[]; dyingMino: MinoPlacement | null }
export function decodeLock(p: Uint8Array): LockData {
  return {
    board: Array.from(p.slice(0, BOARD_SIZE)),
    dyingMino: p.length >= BOARD_SIZE + 4
      ? {
        type: p[BOARD_SIZE],
        x: p[BOARD_SIZE + 1] - 64,
        y: p[BOARD_SIZE + 2] - 64,
        rotation: p[BOARD_SIZE + 3],
      }
      : null,
  };
}

export interface ClearData { lines: number; flags: number; combo: number; }
export function decodeClear(p: Uint8Array): ClearData {
  return { lines: p[0], flags: p[1], combo: p[2] };
}

export interface GarbageData { amount: number; holes: number[]; }
export function decodeGarbage(p: Uint8Array): GarbageData {
  if (p.length < 3 || p[0] !== GARBAGE_PROTOCOL_VERSION) {
    throw new Error("Unsupported Garbage payload");
  }
  const amount = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint16(1, true);
  if (amount < 1 || amount > MAX_GARBAGE_AMOUNT || p.length !== 3 + amount) {
    throw new Error("Invalid Garbage amount/length");
  }
  const holes = Array.from(p.slice(3, 3 + amount));
  return { amount, holes };
}
export function decodeHold(p: Uint8Array): number { return p[0]; }

// ── Board serialization helpers ────────────────────────────────────────
// Convert game field.blocks array → flat type array (for encodeLock)
// ★ wire上は「0=空セル」「1〜7=ミノtype 0〜6」とする(+1オフセット)。
//   Iミノは type 0 のため、+1しないと空セルと区別できず相手盤面で消える。
//   デコード側 (Lock handler) は値が非0のとき type = 値-1 で復元する。
// ★ おじゃませり上がりでスタックが y<0 へはみ出すため、y=-BOARD_BUFFER_ROWS..BOARD_ROWS-1
//   の40行を row = y + BOARD_BUFFER_ROWS で格納する。バッファ外(y<-20)は実質トップアウトなので破棄。
export function fieldBlocksToArray(blocks: Array<{x: number; y: number; type: number}>): number[] {
  const arr = new Array(BOARD_SIZE).fill(0);
  for (const b of blocks) {
    if (b.x >= 0 && b.x < BOARD_COLS && b.y >= -BOARD_BUFFER_ROWS && b.y < BOARD_ROWS) {
      arr[(b.y + BOARD_BUFFER_ROWS) * BOARD_COLS + b.x] = ((b.type ?? 6) + 1);
    }
  }
  return arr;
}

// ── Puyo encode/decode helpers ────────────────────────────────────────

// PuyoPieceState: 6 bytes (opcode + pivotColor + childColor + pivotX + pivotY_encoded + rotation + targetAnimRot_encoded)
// pivotY: float, encoded as round(pivotY * 2) + 64 → 8-bit unsigned
// targetAnimRot: 回転演出用の非mod累積値（engine.js targetAnimRot）。byte1個(mod 256)で送り、
// 受信側(driver.ts)は現在のanimRotに最も近い合同値へ復元する（256ラップは長時間の空中回転でしか起きない想定）。
export function encodePuyoPieceState(
  pivotColor: number, childColor: number,
  pivotX: number, pivotY: number, rotation: number, targetAnimRot: number = rotation,
): Uint8Array {
  return new Uint8Array([
    MatchOpcode.PuyoPieceState,
    pivotColor & 0xff,
    childColor & 0xff,
    (pivotX + 16) & 0xff,
    (Math.round(pivotY * 2) + 64) & 0xff,
    rotation & 0xff,
    (Math.round(targetAnimRot) + 128) & 0xff,
  ]);
}
export interface PuyoPieceStateData {
  pivotColor: number; childColor: number;
  pivotX: number; pivotY: number; rotation: number; targetAnimRot: number;
}
export function decodePuyoPieceState(p: Uint8Array): PuyoPieceStateData {
  return {
    pivotColor: p[0],
    childColor: p[1],
    pivotX: p[2] - 16,
    pivotY: (p[3] - 64) / 2,
    rotation: p[4],
    // 後方互換: 旧5バイトフレーム（targetAnimRot未送信）は rotation を代用値にする
    targetAnimRot: p.length > 5 ? p[5] - 128 : p[4],
  };
}

// PuyoSpawn: 8 bytes payload (pivotColor + childColor + 3 next pairs)
// nextPairs: [[piv,chi], ...] — at most 3 pairs encoded
export function encodePuyoSpawn(
  pivotColor: number, childColor: number, nextPairs: [number, number][],
): Uint8Array {
  const buf = new Uint8Array(9);
  buf[0] = MatchOpcode.PuyoSpawn;
  buf[1] = pivotColor & 0xff;
  buf[2] = childColor & 0xff;
  for (let i = 0; i < 3; i++) {
    buf[3 + i * 2] = (nextPairs[i]?.[0] ?? 0) & 0xff;
    buf[4 + i * 2] = (nextPairs[i]?.[1] ?? 0) & 0xff;
  }
  return buf;
}
export interface PuyoSpawnData {
  pivotColor: number; childColor: number; nextPairs: [number, number][];
}
export function decodePuyoSpawn(p: Uint8Array): PuyoSpawnData {
  const nextPairs: [number, number][] = [];
  for (let i = 0; i < 3; i++) {
    nextPairs.push([p[2 + i * 2] ?? 0, p[3 + i * 2] ?? 0]);
  }
  return { pivotColor: p[0], childColor: p[1], nextPairs };
}

/**
 * PuyoLock のスナップショット種別（連鎖再生のペーシングに使う）。
 * opcode は 0x22 のまま payload 先頭に 1 バイト付与する。サーバーは中身を見ないため
 * プロトコル/サーバー変更なしで受信側が「どの段階の盤面か」を確定できる。
 */
export const PuyoLockPhase = { Fix: 0, Erase: 1, Drop: 2 } as const;
export type PuyoLockPhaseValue = typeof PuyoLockPhase[keyof typeof PuyoLockPhase];

// PuyoLock: 1(phase) + 102(field) bytes。field は 17×6 の内部盤面（hidden 行込み）。
export function encodePuyoLock(field: number[][], phase: number = PuyoLockPhase.Fix): Uint8Array {
  const buf = new Uint8Array(2 + PUYO_FIELD_SIZE);
  buf[0] = MatchOpcode.PuyoLock;
  buf[1] = phase & 0xff;
  let idx = 2;
  for (let r = 0; r < PUYO_ROWS; r++) {
    for (let c = 0; c < PUYO_COLS; c++) {
      buf[idx++] = (field[r]?.[c] ?? 0) & 0xff;
    }
  }
  return buf;
}
export interface PuyoLockData { field: number[][]; phase: number; }
export function decodePuyoLock(p: Uint8Array): PuyoLockData {
  // payload は受信層で opcode + 送信元UUID(16B) を除去済み → [phase, ...field]
  const phase = p[0] ?? 0;
  const field: number[][] = [];
  for (let r = 0; r < PUYO_ROWS; r++) {
    const row: number[] = [];
    for (let c = 0; c < PUYO_COLS; c++) {
      row.push(p[1 + r * PUYO_COLS + c] ?? 0);
    }
    field.push(row);
  }
  return { field, phase };
}

// PUYO のおじゃまも unified Garbage(0x24) を使う。各おじゃまの列を送信側で確定する。
export function encodeGarbagePuyo(amount: number): Uint8Array {
  const n = Math.max(0, Math.min(MAX_GARBAGE_AMOUNT, Math.trunc(amount)));
  const columns = Array.from({ length: n }, () => Math.floor(Math.random() * PUYO_COLS));
  return encodeGarbage(n, columns);
}

// PuyoChain: [chainCount][groupCount][groupLen × groupCount][cells(r,c) …グループ順][ojamaCount][ojama cells(r,c)]
// 連鎖消去開始時の点滅セル。グループ境界を持つのは _prepareChainTextDOM（実エンジンと
// 同じ関数、driver.tsから流用）が「最下段・最左のグループ」を選ぶのにグループ単位の
// 構造が必要なため（cells をフラットにしただけでは境界もおじゃまとの区別も失われる）。
export function encodePuyoChain(
  chainCount: number,
  groups: Array<Array<{ r: number; c: number }>>,
  ojamaCells: Array<{ r: number; c: number }> = [],
): Uint8Array {
  const groupCount = Math.min(groups.length, 255);
  const groupLens = groups.slice(0, groupCount).map((g) => Math.min(g.length, 255));
  const totalGroupCells = groupLens.reduce((a, b) => a + b, 0);
  const n = Math.min(ojamaCells.length, 255);
  const buf = new Uint8Array(1 + 1 + 1 + groupCount + totalGroupCells * 2 + 1 + n * 2);
  let i = 0;
  buf[i++] = MatchOpcode.PuyoChain;
  buf[i++] = chainCount & 0xff;
  buf[i++] = groupCount;
  for (let g = 0; g < groupCount; g++) buf[i++] = groupLens[g];
  for (let g = 0; g < groupCount; g++) {
    for (let k = 0; k < groupLens[g]; k++) {
      buf[i++] = groups[g][k].r & 0xff;
      buf[i++] = groups[g][k].c & 0xff;
    }
  }
  buf[i++] = n;
  for (let j = 0; j < n; j++) {
    buf[i++] = ojamaCells[j].r & 0xff;
    buf[i++] = ojamaCells[j].c & 0xff;
  }
  return buf;
}
export interface PuyoChainData {
  chainCount: number;
  groups: Array<Array<{ r: number; c: number }>>;
  ojamaCells: Array<{ r: number; c: number }>;
  /** groups.flat() + ojamaCells（消去点滅の対象セル全体。従来の _erasingCells 相当）。 */
  cells: Array<{ r: number; c: number }>;
}
export function decodePuyoChain(p: Uint8Array): PuyoChainData {
  let i = 0;
  const chainCount = p[i++] ?? 0;
  const groupCount = p[i++] ?? 0;
  const groupLens: number[] = [];
  for (let g = 0; g < groupCount; g++) groupLens.push(p[i++] ?? 0);
  const groups: Array<Array<{ r: number; c: number }>> = [];
  for (let g = 0; g < groupCount; g++) {
    const grp: Array<{ r: number; c: number }> = [];
    for (let k = 0; k < groupLens[g]; k++) {
      grp.push({ r: p[i] ?? 0, c: p[i + 1] ?? 0 });
      i += 2;
    }
    groups.push(grp);
  }
  const n = p[i++] ?? 0;
  const ojamaCells: Array<{ r: number; c: number }> = [];
  for (let j = 0; j < n; j++) {
    ojamaCells.push({ r: p[i] ?? 0, c: p[i + 1] ?? 0 });
    i += 2;
  }
  return { chainCount, groups, ojamaCells, cells: [...groups.flat(), ...ojamaCells] };
}

// ── Cross-game conversion tables (same as garbage.js) ────────────────
const TET_TO_OJAMA = [0, 4, 5, 6, 8, 10, 13, 16, 20, 24, 28, 33, 38, 43, 49, 55, 61, 68];
export function tetLinesToOjama(n: number): number {
  if (n < TET_TO_OJAMA.length) return TET_TO_OJAMA[n];
  return Math.floor((n * n - 21 * n + 204) / 2);
}
export function ojamaToTetLines(ojama: number): number {
  for (let i = TET_TO_OJAMA.length - 1; i >= 1; i--) {
    if (TET_TO_OJAMA[i] <= ojama) return i;
  }
  return 0;
}
