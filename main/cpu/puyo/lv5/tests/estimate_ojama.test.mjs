// ─────────────────────────────────────────────────────────────────────────────
// estimate_ojama.test.mjs
//   PuyoCPU4 の VERSUS おじゃま予測（ぷよ相手）ロジックのユニットテスト。
//
//   実行: node --test cpu/puyo/lv5/tests/        （プロジェクトルートから）
//        または node --test cpu/puyo/lv5/tests/estimate_ojama.test.mjs
//
//   背景:
//     cpu5_worker_io.js の _estimateOpponentPuyoChainOjama() は「相手が発火中の連鎖を
//     最後まで打ち切ったときの総おじゃま量(個)」を推定する。実機では連鎖は1段ずつ
//     アニメ解決され火力は pendingFire に貯まってから送られるため、途中段で読むと
//     量が確定しない。そこで相手盤面のコピー上で残り連鎖をシミュレートして全段量を出す。
//
//   このテストは:
//     (1) PConfig（base.js のスコア計算テーブル）を実ソースから読み込んで同期。
//     (2) engine.js の _findErasableInField と _calcChainScore に対応する純粋ロジックを
//         移植し、推定値が「スコア→おじゃま量」の式どおりに出ることを固定値で検証。
//     (3) ★再発ガード: cpu5_worker_io.js に window.PConfig が復活していないか静的検査。
//         （PConfig は base.js のトップレベル const＝グローバルレキシカル束縛で、
//           classic script では window のプロパティにならない。過去 window.PConfig が
//           undefined になり推定が常に 0＝「ぷよ同士の予測がコンソールに出ない」バグの原因だった。）
//
//   注意: (2) は engine.js のロジックの“移植”であり、engine.js を直接変更したら
//         このテスト側も追従させること（各関数に対応元の関数名をコメント明記）。
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../../..'); // main/

// ── 実ソースから PConfig を取り出して同期（スコアテーブルがドリフトしないように） ──
function loadPConfig() {
    const src = readFileSync(resolve(ROOT, 'src/core/base.js'), 'utf8');
    const m = src.match(/const\s+PConfig\s*=\s*(\{[\s\S]*?\n\});/);
    if (!m) throw new Error('base.js から PConfig を抽出できませんでした');
    // 値はすべて数値/文字列/配列リテラルのみ。安全に評価できる。
    return Function(`"use strict"; return (${m[1]});`)();
}
const PConfig = loadPConfig();

// ── engine.js _findErasableInField(checkField) の移植 ──
//   4連結以上の色ぷよ群と、それに隣接するおじゃま(6)を返す。
function findErasable(field, eraseCount) {
    const totalRows = PConfig.rows + PConfig.hiddenRows;
    const cols = PConfig.cols;
    const visited = Array.from({ length: totalRows }, () => new Array(cols).fill(false));
    const groups = [];
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];

    for (let r = PConfig.hiddenRows; r < totalRows; r++) {
        for (let c = 0; c < cols; c++) {
            if (visited[r][c]) continue;
            const color = field[r][c];
            if (color <= 0 || color === 6) continue;
            const group = [];
            const queue = [{ r, c }];
            visited[r][c] = true;
            while (queue.length) {
                const cur = queue.shift();
                group.push({ r: cur.r, c: cur.c, color });
                for (const [dr, dc] of dirs) {
                    const nr = cur.r + dr, nc = cur.c + dc;
                    if (nr < PConfig.hiddenRows || nr >= totalRows) continue;
                    if (nc < 0 || nc >= cols) continue;
                    if (visited[nr][nc]) continue;
                    if (field[nr][nc] !== color) continue;
                    visited[nr][nc] = true;
                    queue.push({ r: nr, c: nc });
                }
            }
            if (group.length >= eraseCount) groups.push(group);
        }
    }

    const ojamaToErase = [];
    const seen = new Set();
    for (const g of groups) for (const cell of g) for (const [dr, dc] of dirs) {
        const nr = cell.r + dr, nc = cell.c + dc;
        if (nr < PConfig.hiddenRows || nr >= totalRows) continue;
        if (nc < 0 || nc >= cols) continue;
        if (field[nr][nc] === 6) {
            const key = `${nr},${nc}`;
            if (!seen.has(key)) { seen.add(key); ojamaToErase.push({ r: nr, c: nc }); }
        }
    }
    return { groups, ojamaToErase };
}

// ── engine.js _calcChainScore / 推定側 calcGroupsScore の移植 ──
function calcGroupsScore(groups, chainCnt) {
    let n = 0;
    const usedColors = new Set();
    let groupB = 0;
    for (const g of groups) {
        n += g.length;
        for (const cell of g) usedColors.add(cell.color);
        groupB += PConfig.groupBonusTable[Math.min(g.length, PConfig.groupBonusTable.length - 1)];
    }
    const cb = PConfig.chainBonusTable[Math.min(Math.max(0, chainCnt - 1), PConfig.chainBonusTable.length - 1)];
    const colorB = PConfig.colorBonusTable[Math.min(Math.max(0, usedColors.size - 1), PConfig.colorBonusTable.length - 1)];
    const bonus = Math.max(1, cb + colorB + groupB);
    return PConfig.scoreBase * n * bonus;
}

// ── _estimateOpponentPuyoChainOjama の核（settled盤面の全段シミュレート部分）の移植 ──
//   _erasingCells/点滅中の特殊処理はここでは扱わず、settled盤面からの推定に絞ってテストする。
function estimateOjama(field, { chainCount = 0, attackScore = 0, rate = 70, eraseCount = PConfig.eraseCount } = {}) {
    const totalRows = PConfig.rows + PConfig.hiddenRows;
    const cols = PConfig.cols;
    const f = field.map(row => row.slice());

    const applyGravity = () => {
        for (let c = 0; c < cols; c++) {
            const stack = [];
            for (let r = totalRows - 1; r >= 0; r--) if (f[r][c] !== 0) stack.push(f[r][c]);
            for (let r = totalRows - 1; r >= 0; r--) {
                const k = totalRows - 1 - r;
                f[r][c] = k < stack.length ? stack[k] : 0;
            }
        }
    };

    let chainCnt = chainCount;
    let score = attackScore;
    for (let iter = 0; iter < 40; iter++) {
        const { groups, ojamaToErase } = findErasable(f, eraseCount);
        if (!groups.length) break;
        chainCnt++;
        score += calcGroupsScore(groups, chainCnt);
        for (const g of groups) for (const cell of g) f[cell.r][cell.c] = 0;
        for (const cell of ojamaToErase) f[cell.r][cell.c] = 0;
        applyGravity();
    }
    return rate > 0 ? Math.floor(score / rate) : 0;
}

// ── 盤面ビルダ: 17行(0-4隠し,5-16可視)×6列。bottom() で下から積む ──
function emptyField() {
    return Array.from({ length: PConfig.rows + PConfig.hiddenRows }, () => new Array(PConfig.cols).fill(0));
}
// rows: 下から上へ [[col値...], ...]。色は 1..4、おじゃま=6、空=0。
function bottomUp(rows) {
    const f = emptyField();
    const bottom = PConfig.rows + PConfig.hiddenRows - 1; // 16
    rows.forEach((row, i) => {
        const r = bottom - i;
        row.forEach((v, c) => { if (v) f[r][c] = v; });
    });
    return f;
}

// ─────────────────────────────────────────────────────────────────────────────
// _getIncomingBaseline の相殺カスケード（個単位）の移植。
//   engine._applyOjamaOffset の順序を再現:
//     ① CPU 未送出火力(selfFire) が自分の受けキュー(committed) を相殺
//     ② 余剰(leftoverSelfFire) は相手キューへ回り相手火力を吸収
//     ③ 既に相手キューに居る CPU 送出分(oppQueueGross) も相手火力を吸収
//     ④ 相手の残り火力 − ②③吸収 の差分だけが CPU に届く(anticipated)
//   返り値 = committed + anticipated（＝ネット受け量）。
// ─────────────────────────────────────────────────────────────────────────────
function netIncoming({ grossQueue = 0, selfFire = 0, oppQueueGross = 0, oppChainFull = 0, oppGenerated = 0 }) {
    const committedNet     = Math.max(0, grossQueue - selfFire);
    const leftoverSelfFire = Math.max(0, selfFire - grossQueue);
    const absorbAtOpp      = oppQueueGross + leftoverSelfFire;
    const oppRemainingFire = Math.max(0, oppChainFull - oppGenerated);
    const anticipated      = Math.max(0, oppRemainingFire - absorbAtOpp);
    return { net: committedNet + anticipated, committed: committedNet, anticipated };
}

// ─────────────────────────────────────────────────────────────────────────────
// テスト本体
// ─────────────────────────────────────────────────────────────────────────────

test('settled盤面（4連結なし）は 0 個＝過大評価しない', () => {
    const f = bottomUp([[1, 1, 1, 0, 0, 0]]); // 赤3個（消えない）
    assert.equal(estimateOjama(f, { rate: 10 }), 0);
});

test('単発1連鎖: 横4赤, rate=10 → floor(40/10)=4 個', () => {
    // n=4, chainBonus[0]=0, colorBonus[0]=0, groupBonus[4]=0 → bonus=1, add=10*4*1=40
    const f = bottomUp([[1, 1, 1, 1, 0, 0]]);
    assert.equal(estimateOjama(f, { rate: 10 }), 4);
});

test('連鎖継続: 同盤面でも chainCount/attackScore を相手から継続すると増える', () => {
    const f = bottomUp([[1, 1, 1, 1, 0, 0]]);
    // chainCount=3 → 消去で4段目。chainBonus[3]=32, bonus=32, add=10*4*32=1280
    // score = attackScore(200) + 1280 = 1480 → floor(1480/10)=148
    assert.equal(estimateOjama(f, { rate: 10, chainCount: 3, attackScore: 200 }), 148);
});

test('2連鎖: 重力で2段目が成立するレイアウト, rate=10 → 36 個', () => {
    // 下から:
    //   r16: [赤, 青, 青, 0,0,0]
    //   r15: [青, 青, 0,...]
    //   r14: [赤, 赤, 0,...]
    //   r13: [赤, 0, ...]
    // 赤群(col0 r15/r14/r13 + col1 r14)=4 → 1連鎖(add=40)。消去後の重力で
    // 青(col0r16,col1r16,col1r15,col2r16)=4 → 2連鎖(chainBonus[1]=8, add=320)。
    // score=360 → floor(360/10)=36
    const B = 2, R = 1;
    const f = bottomUp([
        [R, B, B, 0, 0, 0], // r16
        [B, B, 0, 0, 0, 0], // r15
        [R, R, 0, 0, 0, 0], // r14
        [R, 0, 0, 0, 0, 0], // r13
    ]);
    assert.equal(estimateOjama(f, { rate: 10 }), 36);
});

test('rate=0 ガード: 0 個（ゼロ除算しない）', () => {
    const f = bottomUp([[1, 1, 1, 1, 0, 0]]);
    assert.equal(estimateOjama(f, { rate: 0 }), 0);
});

// ── 相殺カスケード（カウンター判定のネット受け量） ──

test('相殺: CPUが先に9連鎖(60個)を放った後、相手8連鎖(45個)は全吸収→届く0', () => {
    // CPUの9連鎖は相手キューに居座る(oppQueueGross=60)。相手8連鎖(45)はそこで吸収され差分0。
    const r = netIncoming({ oppQueueGross: 60, oppChainFull: 45 });
    assert.equal(r.anticipated, 0);
    assert.equal(r.net, 0); // → fast に入らない
});

test('相殺: 相手が9連鎖(60個)より強い11連鎖(100個)なら差分40個だけ届く', () => {
    const r = netIncoming({ oppQueueGross: 60, oppChainFull: 100 });
    assert.equal(r.anticipated, 40);
    assert.equal(r.net, 40); // → 閾値=(40+1)*rate＝差分+α
});

test('相殺: 吸収力ゼロ（CPU未発火）なら相手連鎖がそのまま届く', () => {
    const r = netIncoming({ oppChainFull: 45 });
    assert.equal(r.net, 45);
});

test('相殺: CPU未送出火力(pendingFire)はまず自分の受けキューを相殺する', () => {
    // 受けキュー20個、CPU未送出12個 → committed=8、余剰0（相手側へ回らない）
    const r = netIncoming({ grossQueue: 20, selfFire: 12, oppChainFull: 0 });
    assert.equal(r.committed, 8);
    assert.equal(r.net, 8);
});

test('相殺: 自キューを相殺しきった余剰は相手火力を吸収する', () => {
    // 受けキュー5個、CPU未送出20個 → committed=0、余剰15が相手キュー(10)に加わり吸収25
    // 相手連鎖30個 → 届く5個
    const r = netIncoming({ grossQueue: 5, selfFire: 20, oppQueueGross: 10, oppChainFull: 30 });
    assert.equal(r.committed, 0);
    assert.equal(r.anticipated, 5);
    assert.equal(r.net, 5);
});

test('相殺: 相手の既送出分(oppGenerated)は二重計上しない', () => {
    // 全段100個のうち40個は既に送信済(committed側へ)。残り60個が吸収50を超え届く10個
    const r = netIncoming({ oppChainFull: 100, oppGenerated: 40, oppQueueGross: 50 });
    assert.equal(r.anticipated, 10);
});

// ★ 回帰ガード（今回の実バグ）: cpu5_worker_io.js に window.PConfig が無いこと。
//   window.PConfig は classic script では undefined になり、推定が常に 0 になる。
test('回帰ガード: cpu5_worker_io.js に window.PConfig が存在しない', () => {
    const io = readFileSync(resolve(ROOT, 'cpu/puyo/lv5/js/cpu5_worker_io.js'), 'utf8');
    const hits = io.split('\n')
        .map((line, i) => ({ code: line.replace(/\/\/.*$/, ''), n: i + 1 })) // 行コメントを除去
        .filter(({ code }) => /window\.PConfig/.test(code));
    assert.equal(hits.length, 0,
        `window.PConfig は undefined になり予測が常に0になる。bare PConfig を使うこと。該当行: ` +
        hits.map(h => h.n).join(', '));
});
