// game.js を Game.prototype mixin 方式で src/tet/ に分割する一時スクリプト
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src', 'game.js');
const OUTDIR = path.join(__dirname, 'src', 'tet');

const raw = fs.readFileSync(SRC, 'utf8');
const lines = raw.split('\n');

const idxClassStart = lines.findIndex(l => /^class Game \{/.test(l));
if (idxClassStart < 0) throw new Error('class Game not found');
let idxClassEnd = -1;
for (let i = idxClassStart + 1; i < lines.length; i++) {
    if (lines[i] === '}') { idxClassEnd = i; break; }
}
if (idxClassEnd < 0) throw new Error('class end not found');

const topBanner = lines.slice(0, idxClassStart);
const bodyLines = lines.slice(idxClassStart + 1, idxClassEnd);
const tail = lines.slice(idxClassEnd + 1); // クラス後（このファイルでは空）

const METHOD_START = /^    (?:get |set )?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;
const METHOD_END = /^    \}$/;

const blocks = [];
let pending = [];
let i = 0;
while (i < bodyLines.length) {
    const m = METHOD_START.exec(bodyLines[i]);
    if (m) {
        const name = m[1];
        let j = i, endIdx = -1;
        for (; j < bodyLines.length; j++) if (METHOD_END.test(bodyLines[j])) { endIdx = j; break; }
        if (endIdx < 0) throw new Error('method end not found for ' + name);
        blocks.push({ name, leading: pending, lines: bodyLines.slice(i, endIdx + 1) });
        pending = [];
        i = endIdx + 1;
    } else { pending.push(bodyLines[i]); i++; }
}
if (pending.some(l => l.trim() !== '')) console.warn('WARN trailing:', pending);

const CORE = new Set(['constructor']);
const MAP = {
    lifecycle: ['start', '_initGameState', '_startGameplay', 'startGravity', 'gameOver',
        'togglePause', 'pause', 'resume', 'showPauseOverlay', 'hidePauseOverlay',
        'startTimerLoop', 'updateTimeDisplay'],
    board: ['getNextType', 'popMino', 'secureMino', 'hardDrop', 'dropMino', 'checkGroundState',
        'updateLowestY', 'startLockTimer', 'valid', 'applyDebugBoard', 'moveLeft', 'moveRight', 'softDropOne'],
    rotation: ['tryRotate', 'validRotated', 'holdCurrentMino', 'checkTSpin'],
    scoring: ['Scoring', 'showActionLabels', 'updateStatsDisplay'],
    garbage: ['sendGarbage', 'applyGarbage', 'offsetGarbage', 'updateGarbageGauge', 'updateAttackGauge'],
    render: ['initMainCanvas', 'initNextCanvas', 'initHoldCanvas', 'drawGrid', 'getGhostY', 'drawAll'],
    input: ['playSe', 'setKeyEvent'],
};
const name2file = {};
for (const [file, names] of Object.entries(MAP)) for (const n of names) name2file[n] = file;

const unassigned = blocks.filter(b => !CORE.has(b.name) && !name2file[b.name]).map(b => b.name);
if (unassigned.length) throw new Error('UNASSIGNED: ' + unassigned.join(', '));

const FILE_ORDER = ['lifecycle', 'board', 'rotation', 'scoring', 'garbage', 'render', 'input'];

// core.js
const coreBlocks = blocks.filter(b => CORE.has(b.name));
let core = topBanner.join('\n') + '\n';
core += 'class Game {\n';
for (const b of coreBlocks) {
    if (b.leading.length) core += b.leading.join('\n') + '\n';
    core += b.lines.join('\n') + '\n';
}
core += '}\n';
if (tail.length) core += tail.join('\n');
fs.writeFileSync(path.join(OUTDIR, 'core.js'), core);

const titles = {
    lifecycle: 'ライフサイクル（開始/初期化・重力/ゲームオーバー・ポーズ・タイマー）',
    board: 'ボード操作（ミノ生成/設置・落下/接地・移動・盤面判定）',
    rotation: '回転・ホールド・Tスピン判定',
    scoring: 'スコア計算・アクションラベル・スタッツ表示',
    garbage: '対戦・おじゃま/火力ゲージ',
    render: 'キャンバス初期化・グリッド/ゴースト/全体描画',
    input: '入力（キー/ゲームパッド）・SE再生',
};
function banner(file) {
    return [
        '// ─────────────────────────────────────────────',
        `// tet/${file}.js  ―  Game.prototype mixin`,
        `// ${titles[file]}`,
        '// ※ core.js（class Game 定義）より後に読み込むこと',
        '// ─────────────────────────────────────────────',
    ].join('\n');
}

for (const file of FILE_ORDER) {
    const fileBlocks = MAP[file].map(n => blocks.find(b => b.name === n));
    let out = banner(file) + '\n\n';
    out += 'Object.assign(Game.prototype, {\n';
    for (const b of fileBlocks) {
        if (b.leading.length) out += b.leading.join('\n') + '\n';
        const ml = b.lines.slice();
        ml[ml.length - 1] = ml[ml.length - 1].replace(/^    \}$/, '    },');
        out += ml.join('\n') + '\n';
    }
    out += '});\n';
    fs.writeFileSync(path.join(OUTDIR, file + '.js'), out);
}

console.log('OK: split done. methods =', blocks.length, '(core', coreBlocks.length, ')');
for (const f of ['core', ...FILE_ORDER]) {
    const p = path.join(OUTDIR, f + '.js');
    console.log('  ', f + '.js', fs.readFileSync(p, 'utf8').split('\n').length, 'lines');
}
