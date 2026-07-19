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
  // ── Puyo frames (0x3N) ──────────────────────────────────────────────
  PuyoPieceState: 0x30, // unreliable: puyo pair position/rotation (high-freq)
  PuyoSpawn: 0x31,      // reliable: new pair spawned + next queue
  PuyoLock: 0x32,       // reliable: full field snapshot
  GarbagePuyo: 0x33,    // reliable: ojama count incoming (puyo sender)
  PuyoChain: 0x34,      // reliable: 連鎖消去開始（点滅するセル一覧 + 連鎖数）
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

// Spawn: 8 bytes (opcode + type + holdType + next[5])
export function encodeSpawn(
  type: number, holdType: number, nextTypes: number[],
): Uint8Array {
  const buf = new Uint8Array(8);
  buf[0] = MatchOpcode.Spawn;
  buf[1] = type & 0xff;
  buf[2] = holdType & 0xff; // 0xff = no hold
  for (let i = 0; i < 5; i++) buf[3 + i] = (nextTypes[i] ?? 0xff) & 0xff;
  return buf;
}

// Lock: 1 + BOARD_SIZE bytes (opcode + 400 board bytes, row-major)
// boardTypes[row * 10 + col] = block type (0 = empty, 1-8 = type 0-7)
// row 0 = y=-BOARD_BUFFER_ROWS（上方バッファ最上段）, row 20 = y=0（可視最上段）
export function encodeLock(boardTypes: number[]): Uint8Array {
  const buf = new Uint8Array(1 + BOARD_SIZE);
  buf[0] = MatchOpcode.Lock;
  for (let i = 0; i < BOARD_SIZE; i++) buf[1 + i] = (boardTypes[i] ?? 0) & 0xff;
  return buf;
}

// Clear: 4 bytes (opcode + lines + flags + combo)
// flags: bit0=T-spin, bit1=B2B, bit2=PC
export function encodeClear(lines: number, flags: number, combo: number): Uint8Array {
  return new Uint8Array([MatchOpcode.Clear, lines & 0xff, flags & 0xff, combo & 0xff]);
}

// Garbage: 2 + N bytes (opcode + amount + holes[amount])
// holes: 各おじゃま段の穴のX座標（送信側で確定＝両者の盤面表示が一致する）
export function encodeGarbage(lines: number, holes?: number[]): Uint8Array {
  const n = lines & 0xff;
  const withHoles = holes && holes.length > 0;
  const buf = new Uint8Array(2 + (withHoles ? n : 0));
  buf[0] = MatchOpcode.Garbage;
  buf[1] = n;
  if (withHoles) {
    for (let i = 0; i < n; i++) buf[2 + i] = (holes[i] ?? 0) & 0xff;
  }
  return buf;
}

// Hold: 2 bytes (opcode + type, 0xff = empty)
export function encodeHold(type: number): Uint8Array {
  return new Uint8Array([MatchOpcode.Hold, type & 0xff]);
}

// GameOver: 2 bytes (opcode + 0)
export function encodeGameOver(): Uint8Array {
  return new Uint8Array([MatchOpcode.GameOver, 0]);
}

// SE: 2 bytes (opcode + seId)
export function encodeSE(seId: number): Uint8Array {
  return new Uint8Array([MatchOpcode.SE, seId & 0xff]);
}

// PendingUpdate: 3 bytes (opcode + ready u8 + unready u8)
// 自分の incoming-garbage ゲージ状態を相手へ通知する（相手スロットの予告ゲージ表示に使用）
export function encodePendingUpdate(ready: number, unready: number): Uint8Array {
  return new Uint8Array([MatchOpcode.PendingUpdate, ready & 0xff, unready & 0xff]);
}
export interface PendingUpdateData { ready: number; unready: number; }
export function decodePendingUpdate(p: Uint8Array): PendingUpdateData {
  return { ready: p[0] ?? 0, unready: p[1] ?? 0 };
}

export function encodeHoldState(canHold: boolean): Uint8Array {
  return new Uint8Array([MatchOpcode.HoldState, canHold ? 1 : 0]);
}

export function decodeHoldState(p: Uint8Array): boolean {
  return (p[0] ?? 0) !== 0;
}

export type StatsRule = "tet" | "puyo";
export interface StatsUpdateData {
  rule: StatsRule;
  score: number;
  lines: number;
  chainMax: number;
}

// StatsUpdate: opcode + rule(0=tet/1=puyo) + score(u32 LE) + lines(u16 LE) + chainMax(u16 LE)
export function encodeStatsUpdate(
  rule: StatsRule, score: number, lines: number, chainMax: number,
): Uint8Array {
  const buf = new Uint8Array(10);
  const view = new DataView(buf.buffer);
  buf[0] = MatchOpcode.StatsUpdate;
  buf[1] = rule === "puyo" ? 1 : 0;
  view.setUint32(2, Math.max(0, Math.min(0xffffffff, Math.trunc(score))), true);
  view.setUint16(6, Math.max(0, Math.min(0xffff, Math.trunc(lines))), true);
  view.setUint16(8, Math.max(0, Math.min(0xffff, Math.trunc(chainMax))), true);
  return buf;
}

export function decodeStatsUpdate(p: Uint8Array): StatsUpdateData {
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
  return {
    rule: p[0] === 1 ? "puyo" : "tet",
    score: p.byteLength >= 5 ? view.getUint32(1, true) : 0,
    lines: p.byteLength >= 7 ? view.getUint16(5, true) : 0,
    chainMax: p.byteLength >= 9 ? view.getUint16(7, true) : 0,
  };
}

// ── SE name → ID table (送受信ともに使用) ─────────────────────────────
// move/drop/rotate 等の高頻度 SE は除外し、インパクトのある音だけを同期する
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
  gameover: 10,
  // 注: tet の 'drop' はソフトドロップ音（毎マス発火）で高頻度のため同期しない
  // puyo（move/rotate も高頻度なので除外）
  puyo_fix: 12,
  puyo_drop: 13,
  puyo_chain1: 14,
  puyo_chain2: 15,
  puyo_chain3: 16,
  puyo_chain4: 17,
  puyo_chain5: 18,
  puyo_chain6: 19,
  puyo_chain7: 20,
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
}
export function decodeSpawn(p: Uint8Array): SpawnData {
  return { type: p[0], holdType: p[1], nextTypes: Array.from(p.slice(2, 7)) };
}

// Returns 200-element array (row-major, 0=empty)
export function decodeLock(p: Uint8Array): number[] {
  return Array.from(p.slice(0, BOARD_SIZE));
}

export interface ClearData { lines: number; flags: number; combo: number; }
export function decodeClear(p: Uint8Array): ClearData {
  return { lines: p[0], flags: p[1], combo: p[2] };
}

export interface GarbageData { amount: number; holes: number[] | null; }
// 旧形式（amountのみ・穴なし）も受理する後方互換デコード
export function decodeGarbage(p: Uint8Array): GarbageData {
  const amount = p[0];
  const holes = p.length >= 1 + amount && amount > 0
    ? Array.from(p.slice(1, 1 + amount))
    : null;
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

// PuyoPieceState: 5 bytes (opcode + pivotColor + childColor + pivotX + pivotY_encoded + rotation)
// pivotY: float, encoded as round(pivotY * 2) + 64 → 8-bit unsigned
export function encodePuyoPieceState(
  pivotColor: number, childColor: number,
  pivotX: number, pivotY: number, rotation: number,
): Uint8Array {
  return new Uint8Array([
    MatchOpcode.PuyoPieceState,
    pivotColor & 0xff,
    childColor & 0xff,
    (pivotX + 16) & 0xff,
    (Math.round(pivotY * 2) + 64) & 0xff,
    rotation & 0xff,
  ]);
}
export interface PuyoPieceStateData {
  pivotColor: number; childColor: number;
  pivotX: number; pivotY: number; rotation: number;
}
export function decodePuyoPieceState(p: Uint8Array): PuyoPieceStateData {
  return {
    pivotColor: p[0],
    childColor: p[1],
    pivotX: p[2] - 16,
    pivotY: (p[3] - 64) / 2,
    rotation: p[4],
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

// PuyoLock: 102 bytes (field[r][c] row-major, 0=empty 1-5=color 6=ojama)
// field is the 17×6 internal field array (rows include hidden rows)
export function encodePuyoLock(field: number[][]): Uint8Array {
  const buf = new Uint8Array(1 + PUYO_FIELD_SIZE);
  buf[0] = MatchOpcode.PuyoLock;
  let idx = 1;
  for (let r = 0; r < PUYO_ROWS; r++) {
    for (let c = 0; c < PUYO_COLS; c++) {
      buf[idx++] = (field[r]?.[c] ?? 0) & 0xff;
    }
  }
  return buf;
}
export function decodePuyoLock(p: Uint8Array): number[][] {
  const field: number[][] = [];
  for (let r = 0; r < PUYO_ROWS; r++) {
    const row: number[] = [];
    for (let c = 0; c < PUYO_COLS; c++) {
      row.push(p[r * PUYO_COLS + c] ?? 0);
    }
    field.push(row);
  }
  return field;
}

// GarbagePuyo: 1 byte payload (ojama count)
export function encodeGarbagePuyo(amount: number): Uint8Array {
  return new Uint8Array([MatchOpcode.GarbagePuyo, amount & 0xff]);
}

// PuyoChain: [chainCount][count][r,c × count] — 連鎖消去開始時の点滅セル
export function encodePuyoChain(
  chainCount: number, cells: Array<{ r: number; c: number }>,
): Uint8Array {
  const n = Math.min(cells.length, 255);
  const buf = new Uint8Array(3 + n * 2);
  buf[0] = MatchOpcode.PuyoChain;
  buf[1] = chainCount & 0xff;
  buf[2] = n;
  for (let i = 0; i < n; i++) {
    buf[3 + i * 2] = cells[i].r & 0xff;
    buf[4 + i * 2] = cells[i].c & 0xff;
  }
  return buf;
}
export interface PuyoChainData { chainCount: number; cells: Array<{ r: number; c: number }>; }
export function decodePuyoChain(p: Uint8Array): PuyoChainData {
  const chainCount = p[0] ?? 0;
  const n = p[1] ?? 0;
  const cells: Array<{ r: number; c: number }> = [];
  for (let i = 0; i < n; i++) {
    cells.push({ r: p[2 + i * 2] ?? 0, c: p[3 + i * 2] ?? 0 });
  }
  return { chainCount, cells };
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
