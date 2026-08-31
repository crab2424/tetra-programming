// ─────────────────────────────────────────────
// practice_snapshot.js
// PRACTICEモードの「1手ごとのスナップショット」直列化・復元
//
// 設計: source_assets/memory/tetlabo-practice-mode-design.md §5
//   ・保存地点は「次のツモが出現する直前」で統一する（＝ツモ消費前）。
//     この地点は操作ミノ/操作ぷよが未出現なので、決定「操作ミノは初期位置に
//     リセットして保存」が自動的に満たされる。
//   ・1手 = 1行の `|` 区切りテキスト。盤面は RLE（`char~count`）で縮める。
//   ・時間は巻き戻さない（startTime / elapsed は対象外）。
//   ・おじゃまは「保留分のみクリア」する（自動投下タイマーは実時間なので継続）。
// ─────────────────────────────────────────────

const PracticeSnapshot = (() => {

    // ─── セル文字の対応表 ─────────────────────────────
    // 盤面は「数字ではなく英字」で表す。RLE のカウントが数字なので、セル側にも
    // 数字を使うと `.~3` + `7`（'.'が3個 → 種別7）が `.~37` に化けて壊れるため。
    const CELL_EMPTY = '.';
    const CELL_CHARS = 'abcdefgh';           // index 0〜7 ⇄ ブロック種別 / ぷよ色
    const cellToChar = (v) => CELL_CHARS[v];
    const charToCell = (c) => CELL_CHARS.indexOf(c);

    // ─── RLE（同じ文字の連続を `char~count` に畳む）────────────────
    // 盤面はほとんどが空セルなので、これだけで 1/2 以下になる。
    function rleEncode(str) {
        let out = '';
        let i = 0;
        while (i < str.length) {
            const c = str[i];
            let n = 1;
            while (i + n < str.length && str[i + n] === c) n++;
            out += (n === 1) ? c : (c + '~' + n);
            i += n;
        }
        return out;
    }

    function rleDecode(str) {
        let out = '';
        let i = 0;
        while (i < str.length) {
            const c = str[i++];
            if (str[i] === '~') {
                i++;
                let num = '';
                while (i < str.length && str[i] >= '0' && str[i] <= '9') num += str[i++];
                out += c.repeat(parseInt(num, 10) || 1);
            } else {
                out += c;
            }
        }
        return out;
    }

    // ══════════════════════════════════════════════
    // tet
    // ══════════════════════════════════════════════

    // 盤面の走査範囲。valid() が y >= -5 を許すため、上方5行ぶんも保存対象にする
    // （部分オーバーフローして y<0 に固定されたブロックを取りこぼさない）。
    const TET_TOP = -5;

    function captureTet(game) {
        const rows = ROWS_COUNT - TET_TOP; // 25行
        const cells = new Array(rows * COLS_COUNT).fill(CELL_EMPTY);
        for (const b of game.field.blocks) {
            const ry = b.y - TET_TOP;
            if (ry < 0 || ry >= rows || b.x < 0 || b.x >= COLS_COUNT) continue;
            cells[ry * COLS_COUNT + b.x] = cellToChar(b.type);
        }

        return [
            'T',
            rleEncode(cells.join('')),
            (game.holdMino ? String(game.holdMino.type) : '-'),
            game.canHold ? '1' : '0',
            game.nextQueue.map(m => String(m.type)).join(''),
            game.bag.join(''),
            game.score,
            game.lines,
            game.level,
            game.ren,
            game.backToBack ? '1' : '0',
            game.attackSent || 0,
            game.pendingAttack || 0,
            game.pendingInternalAttack || 0,
        ].join('|');
    }

    function restoreTet(game, line) {
        const p = line.split('|');
        if (p[0] !== 'T') return false;

        // ─── 走っているタイマーを先に全部止める（設計 §5.7）───
        if (game.lockTimer) { clearTimeout(game.lockTimer); game.lockTimer = null; }
        if (game._garbageTimers && game._garbageTimers.length) {
            game._garbageTimers.forEach(t => { if (t.id) clearTimeout(t.id); });
        }
        game._garbageTimers = [];

        // ─── 盤面 ───
        // Field を作り直してから markDirty()。忘れると _occ / _fixedCanvas の
        // キャッシュが前局面のまま残り、消したはずのブロックが残像になる。
        const cells = rleDecode(p[1]);
        game.field = new Field();
        for (let i = 0; i < cells.length; i++) {
            const ch = cells[i];
            if (ch === CELL_EMPTY) continue;
            const x = i % COLS_COUNT;
            const y = Math.floor(i / COLS_COUNT) + TET_TOP;
            game.field.blocks.push(new Block(x, y, charToCell(ch)));
        }
        game.field.markDirty();

        // ─── ツモ・ホールド ───
        game.holdMino = (p[2] === '-') ? null : new Mino(parseInt(p[2], 10));
        game.canHold = (p[3] === '1');
        game.nextQueue = p[4].split('').map(c => new Mino(parseInt(c, 10)));
        game.bag = p[5] === '' ? [] : p[5].split('').map(c => parseInt(c, 10));

        // ─── スコア・火力 ───
        game.score = parseInt(p[6], 10);
        game.lines = parseInt(p[7], 10);
        game.level = parseInt(p[8], 10);
        game.ren = parseInt(p[9], 10);
        game.backToBack = (p[10] === '1');
        game.attackSent = parseInt(p[11], 10);
        game.pendingAttack = parseInt(p[12], 10);
        game.pendingInternalAttack = parseInt(p[13], 10);

        // ─── おじゃまは保留分のみクリア（設計 §5.5）───
        game.garbageQueue = [];

        // ─── 操作ミノの状態をリセットして再出現させる ───
        game.mino = null;
        game.isGrounded = false;
        game.moveCount = 0;
        game.lastActionWasRotation = false;
        game.lastRotUsedPoint5 = false;
        if (game.timer) { clearInterval(game.timer); game.timer = null; }

        game.updateStatsDisplay();
        game.updateAttackGauge();
        game.updateGarbageGauge();
        return true;
    }

    // ══════════════════════════════════════════════
    // puyo
    // ══════════════════════════════════════════════

    function capturePuyo(game) {
        const totalRows = PConfig.rows + PConfig.hiddenRows;
        let cells = '';
        for (let r = 0; r < totalRows; r++) {
            for (let c = 0; c < PConfig.cols; c++) cells += cellToChar(game.field[r][c]);
        }

        return [
            'P',
            rleEncode(cells),
            game.nextQueue.map(pair => '' + pair[0] + pair[1]).join(''),
            game.activeColors.join(''),
            game.score,
            game.chainMax,
            game.clearedPuyos,
            game.attackScore,
            game.generatedOjamaTotal,
            game.attackSent || 0,
            game.pendingFire,
            game.tetAttackCarry,
            game.tetAttackLines,
            game.tetPendingFire,
            game.tetDropScore,
            game.hasTetZenkeshi ? '1' : '0',
        ].join('|');
    }

    function restorePuyo(game, line) {
        const p = line.split('|');
        if (p[0] !== 'P') return false;

        // ─── 盤面（配列は作り直さず値だけ書き戻す）───
        const cells = rleDecode(p[1]);
        const totalRows = PConfig.rows + PConfig.hiddenRows;
        for (let r = 0; r < totalRows; r++) {
            for (let c = 0; c < PConfig.cols; c++) {
                game.field[r][c] = charToCell(cells[r * PConfig.cols + c]);
            }
        }

        // ─── ツモ・色 ───
        game.nextQueue = [];
        for (let i = 0; i + 1 < p[2].length; i += 2) {
            game.nextQueue.push([parseInt(p[2][i], 10), parseInt(p[2][i + 1], 10)]);
        }
        game.activeColors = p[3].split('').map(c => parseInt(c, 10));

        // ─── スコア・火力 ───
        game.score = parseInt(p[4], 10);
        game.chainMax = parseInt(p[5], 10);
        game.clearedPuyos = parseInt(p[6], 10);
        game.attackScore = parseInt(p[7], 10);
        game.generatedOjamaTotal = parseInt(p[8], 10);
        game.attackSent = parseInt(p[9], 10);
        game.pendingFire = parseInt(p[10], 10);
        game.tetAttackCarry = parseInt(p[11], 10);
        game.tetAttackLines = parseInt(p[12], 10);
        game.tetPendingFire = parseInt(p[13], 10);
        game.tetDropScore = parseInt(p[14], 10);
        game.hasTetZenkeshi = (p[15] === '1');

        // ─── おじゃまは保留分のみクリア（設計 §5.5）───
        game.garbageQueue = [];
        game.ojamaUpdateQueue = [];
        game.sentGarbageThisTurn = [];
        game.hasDroppedOjamaThisTurn = false;
        game._lastYokokuAmount = -1; // 差分更新キャッシュを無効化して必ず描き直させる

        // ─── アニメ状態を全クリア（設計 §5.3。連鎖中に巻き戻しても残らないように）───
        game.activeAnims = [];
        game._dropAnim = null;
        game._erasingCells = null;
        game._animMap = null;
        game._erasingSet = null;
        game.chainTextInfo = null;
        game._clearChainTextDOM();
        game.pendingChainGroups = null;
        game.chainScoreAdd = 0;
        game.chainScoreStr = '';
        game.chainCount = 0;
        game.splitPuyo = null;
        game.fixAnimTimer = 0;
        game.fixAnimDuration = 0;
        game.fw5fTimer = 0;
        game._eraseTimer = 0;
        game.eraseWaitTimer = 0;
        game.spawnAnimTimer = 0;
        game.isAllClear = false;
        game.lastRotationInfo = null;
        game.moveLockCount = 0;
        game.inputBuffer = [];

        game._gs = 'spawn';

        game._updateScoreDisplay();
        game._updateChainDisplay(0);
        game._updateOjamaYokoku();
        game._render();
        return true;
    }

    // ══════════════════════════════════════════════
    // 公開API
    // ══════════════════════════════════════════════
    return {
        capture(game, rule) {
            return (rule === 'puyo') ? capturePuyo(game) : captureTet(game);
        },
        restore(game, rule, line) {
            if (!line) return false;
            return (rule === 'puyo') ? restorePuyo(game, line) : restoreTet(game, line);
        },
    };
})();
