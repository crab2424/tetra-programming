// ─────────────────────────────────────────────
// vs_settings.js
// VERSUS モード専用設定の管理・UI生成・エンジン注入
// settings.js とは独立して動作する（保存キーも別）
// ─────────────────────────────────────────────

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const VS_SETTINGS_STORAGE_KEY = 'game_vs_settings';

/**
 * 火力補正テーブル（bias + 3 をインデックスとする）
 * TET・PUYOで共通の乗率(%)。切り捨て適用。
 * bias: -3 / -2 / -1 / 0 / +1 / +2 / +3
 */
const ATTACK_BIAS_TABLE = [33, 50, 75, 100, 133, 200, 300];

/**
 * マージンタイムのステップ定義
 * null = OFF（機能無効）、数値 = 発動までの秒数（0 = 即時発動）
 */
const MARGIN_TIME_STEPS = [null, 0, 32, 64, 96, 128, 160, 192];

/** デフォルト設定値 */
const DEFAULT_VS_SETTINGS = {
    all: {
        marginTime: 96,       // null=OFF、0=即時、正の整数=秒数
        attackBias: {
            player: 0,        // -3 ~ +3
            cpu:    0         // -3 ~ +3
        }
    },
    tet: {
        holdEnabled: true,
        garbageHoleRate: 70,
        garbageDamageOnClear: true
    },
    puyo: {
        ojamaRate:  70,       // 10~120 (10刻み)
        eraseCount: 4         // 2~6
    }
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ロード / セーブ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function loadVsSettings() {
    const saved = localStorage.getItem(VS_SETTINGS_STORAGE_KEY);
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            return _deepMerge(DEFAULT_VS_SETTINGS, parsed);
        } catch (e) {
            localStorage.removeItem(VS_SETTINGS_STORAGE_KEY);
        }
    }
    return _deepClone(DEFAULT_VS_SETTINGS);
}

function saveVsSettings() {
    localStorage.setItem(VS_SETTINGS_STORAGE_KEY, JSON.stringify(currentVsSettings));
    _updateVsSettingsSummary();
}

function resetVsSettings() {
    currentVsSettings = _deepClone(DEFAULT_VS_SETTINGS);
    saveVsSettings();
    renderVsSettingsPage();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 現在値
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** @type {typeof DEFAULT_VS_SETTINGS} */
let currentVsSettings = loadVsSettings();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// エンジン注入 API
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 火力補正の乗率を取得する（TET・PUYO共通）。
 * @param {'player'|'cpu'} side
 * @returns {number} 例: bias=0 → 1.0、bias=+1 → 1.33
 */
function getAttackMultiplier(side) {
    const bias = currentVsSettings.all.attackBias[side] ?? 0;
    return ATTACK_BIAS_TABLE[bias + 3] / 100;
}

/**
 * マージンタイムをミリ秒で取得する。
 * @returns {number|null} null=OFF、0=即時、正数=ミリ秒
 */
function getMarginTimeMs() {
    const val = currentVsSettings.all.marginTime;
    if (val === null) return null;   // OFF
    return val * 1000;               // 0ms（即時）または正数ms
}

/**
 * VERSUS モード開始時に両エンジンへ設定を注入する。
 * router.js の startVersusGame() 内、インスタンス初期化完了後に呼ぶこと。
 *
 * @param {object|null} playerGame - window._game
 * @param {object|null} cpuGame    - window._cpuGame
 * @param {string}      playerRule - 'tet' | 'puyo'
 * @param {string}      cpuRule    - 'tet' | 'puyo'
 */
function applyVsSettings(playerGame, cpuGame, playerRule, cpuRule) {
    const s = currentVsSettings;

    // ── プレイヤー側 ──────────────────────────
    if (playerGame) {
        playerGame.vsAttackMultiplier = getAttackMultiplier('player');
        playerGame.vsMarginTimeMs     = getMarginTimeMs();

        if (playerRule === 'tet') {
            playerGame.vsHoldEnabled = s.tet.holdEnabled;
            playerGame.vsGarbageHoleRate = s.tet.garbageHoleRate;
            playerGame.vsGarbageDamageOnClear = s.tet.garbageDamageOnClear;
        }
        if (playerRule === 'puyo') {
            playerGame.vsOjamaRate  = s.puyo.ojamaRate;
            playerGame.vsEraseCount = s.puyo.eraseCount;
        }
    }

    // ── CPU 側 ───────────────────────────────
    if (cpuGame) {
        cpuGame.vsAttackMultiplier = getAttackMultiplier('cpu');
        cpuGame.vsMarginTimeMs     = getMarginTimeMs();

        if (cpuRule === 'tet') {
            cpuGame.vsHoldEnabled = s.tet.holdEnabled;
            cpuGame.vsGarbageHoleRate = s.tet.garbageHoleRate;
            cpuGame.vsGarbageDamageOnClear = s.tet.garbageDamageOnClear;
        }
        if (cpuRule === 'puyo') {
            cpuGame.vsOjamaRate  = s.puyo.ojamaRate;
            cpuGame.vsEraseCount = s.puyo.eraseCount;
        }
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// UI 生成・描画
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function renderVsSettingsPage() {
    const container = document.getElementById('vs-settings-items');
    if (!container) return;

    container.innerHTML = '';

    // ── ALL（共通） ────────────────────────────
    container.appendChild(_buildSection('ALL', [
        _buildMarginTimeRow(),
        _buildAttackBiasRow('player'),
        _buildAttackBiasRow('cpu')
    ]));

    // ── TET ───────────────────────────────────
    container.appendChild(_buildSection('TET', [
        _buildHoldToggleRow(),
        _buildGarbageHoleRateRow(),
        _buildGarbageDamageRow()
    ]));

    // ── PUYO ──────────────────────────────────
    container.appendChild(_buildSection('PUYO', [
        _buildOjamaRateRow(),
        _buildEraseCountRow()
    ]));

    // ── リセットボタン ─────────────────────────
    const resetBtn = document.createElement('button');
    resetBtn.className = 'menu-btn btn-reset vs-settings-reset-btn';
    resetBtn.innerHTML = '<span class="menu-btn-icon">↺</span><span>RESET DEFAULT</span>';
    resetBtn.onclick = () => resetVsSettings();
    container.appendChild(resetBtn);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 各設定行のビルダー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _buildSection(title, rows) {
    const sec = document.createElement('div');
    sec.className = 'vs-setting-section';

    const label = document.createElement('p');
    label.className = 'vs-setting-section-label';
    label.textContent = title;
    sec.appendChild(label);

    rows.forEach(row => sec.appendChild(row));
    return sec;
}

function _buildRow(labelText, subText, controlEl) {
    const row = document.createElement('div');
    row.className = 'vs-setting-row';

    const labelWrap = document.createElement('div');
    labelWrap.className = 'vs-setting-label-wrap';

    const lbl = document.createElement('span');
    lbl.className = 'vs-setting-label';
    lbl.textContent = labelText;
    labelWrap.appendChild(lbl);

    if (subText) {
        const sub = document.createElement('span');
        sub.className = 'vs-setting-sublabel';
        sub.textContent = subText;
        labelWrap.appendChild(sub);
    }

    row.appendChild(labelWrap);
    row.appendChild(controlEl);
    return row;
}

// ── マージンタイム ──────────────────────────
// MARGIN_TIME_STEPS: [null, 0, 32, 64, 96, 128, 160, 192]
// null=OFF、0=即時発動、正数=秒数
function _buildMarginTimeRow() {
    const current = currentVsSettings.all.marginTime;

    // 現在値に対応するスライダーインデックスを求める
    // null(OFF)=0、それ以外は steps 内の位置
    const currentIdx = (() => {
        if (current === null) return 0;
        const idx = MARGIN_TIME_STEPS.indexOf(current);
        return idx !== -1 ? idx : 4; // 見つからなければデフォルト(96s=index4)
    })();

    const ctrl = document.createElement('div');
    ctrl.className = 'vs-setting-control';

    const valLabel = document.createElement('span');
    valLabel.className = 'vs-setting-value-label';
    valLabel.id = 'vss-val-marginTime';
    valLabel.textContent = _formatMarginTime(current);

    const slider = document.createElement('input');
    slider.type  = 'range';
    slider.min   = '0';
    slider.max   = String(MARGIN_TIME_STEPS.length - 1);
    slider.step  = '1';
    slider.value = String(currentIdx);
    slider.className = 'vs-setting-slider';

    slider.oninput = () => {
        const val = MARGIN_TIME_STEPS[parseInt(slider.value)];
        currentVsSettings.all.marginTime = val;
        valLabel.textContent = _formatMarginTime(val);
        saveVsSettings();
    };

    ctrl.appendChild(valLabel);
    ctrl.appendChild(slider);

    // 目盛り
    const markers = document.createElement('div');
    markers.className = 'vs-setting-markers';
    MARGIN_TIME_STEPS.forEach(s => {
        const m = document.createElement('span');
        m.textContent = _formatMarginTime(s);
        markers.appendChild(m);
    });
    ctrl.appendChild(markers);

    return _buildRow('MARGIN TIME', '(sec)', ctrl);
}

function _formatMarginTime(val) {
    if (val === null) return 'OFF';
    if (val === 0)    return 'INSTANT';
    return `${val}s`;
}

// ── 火力補正 ──────────────────────────────
function _buildAttackBiasRow(side) {
    const current   = currentVsSettings.all.attackBias[side];
    const sideLabel = side === 'player' ? 'YOUR SIDE' : 'CPU SIDE';
    const steps     = [-3, -2, -1, 0, 1, 2, 3];

    const ctrl = document.createElement('div');
    ctrl.className = 'vs-setting-control';

    const valLabel = document.createElement('span');
    valLabel.className = 'vs-setting-value-label';
    valLabel.id = `vss-val-attackBias-${side}`;
    valLabel.textContent = _formatBias(current);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'vs-setting-btn-group';
    btnGroup.id = `vss-btngroup-attackBias-${side}`;

    steps.forEach(step => {
        const btn = document.createElement('button');
        btn.className = 'vs-setting-step-btn' + (step === current ? ' active' : '');
        btn.textContent = step > 0 ? `+${step}` : String(step);
        btn.dataset.value = String(step);
        btn.onclick = () => {
            currentVsSettings.all.attackBias[side] = step;
            saveVsSettings();
            btnGroup.querySelectorAll('.vs-setting-step-btn').forEach(b => {
                b.classList.toggle('active', parseInt(b.dataset.value) === step);
            });
            valLabel.textContent = _formatBias(step);
        };
        btnGroup.appendChild(btn);
    });

    ctrl.appendChild(valLabel);
    ctrl.appendChild(btnGroup);

    return _buildRow('ATTACK BIAS', sideLabel, ctrl);
}

function _formatBias(bias) {
    const pct  = ATTACK_BIAS_TABLE[bias + 3];
    const sign = bias > 0 ? '+' : '';
    return `${sign}${bias}  (${pct}%)`;
}

// ── HOLD ON/OFF ───────────────────────────
function _buildHoldToggleRow() {
    const current = currentVsSettings.tet.holdEnabled;

    const ctrl = document.createElement('div');
    ctrl.className = 'vs-setting-control';

    const btnGroup = document.createElement('div');
    btnGroup.className = 'vs-setting-btn-group';

    ['ON', 'OFF'].forEach(label => {
        const btn = document.createElement('button');
        const isActive = (label === 'ON') ? current : !current;
        btn.className = 'vs-setting-step-btn' + (isActive ? ' active' : '');
        btn.textContent = label;
        btn.onclick = () => {
            currentVsSettings.tet.holdEnabled = (label === 'ON');
            saveVsSettings();
            btnGroup.querySelectorAll('.vs-setting-step-btn').forEach(b => {
                b.classList.toggle('active',
                    (b.textContent === 'ON') === currentVsSettings.tet.holdEnabled
                );
            });
        };
        btnGroup.appendChild(btn);
    });

    ctrl.appendChild(btnGroup);
    return _buildRow('HOLD', '', ctrl);
}

// ── おじゃま直列確率 ───────────────────────────
function _buildGarbageHoleRateRow() {
    const current = currentVsSettings.tet.garbageHoleRate;

    const ctrl = document.createElement('div');
    ctrl.className = 'vs-setting-control';

    const valLabel = document.createElement('span');
    valLabel.className = 'vs-setting-value-label';
    valLabel.id = 'vss-val-garbageHoleRate';
    valLabel.textContent = `${current}%`;

    const slider = document.createElement('input');
    slider.type  = 'range';
    slider.min   = '0';
    slider.max   = '100';
    slider.step  = '10';
    slider.value = String(current);
    slider.className = 'vs-setting-slider';

    slider.oninput = () => {
        const val = parseInt(slider.value);
        currentVsSettings.tet.garbageHoleRate = val;
        valLabel.textContent = `${val}%`;
        saveVsSettings();
    };

    ctrl.appendChild(valLabel);
    ctrl.appendChild(slider);

    const markers = document.createElement('div');
    markers.className = 'vs-setting-markers';
    [0, 50, 100].forEach(v => {
        const m = document.createElement('span');
        m.textContent = String(v);
        markers.appendChild(m);
    });
    ctrl.appendChild(markers);

    return _buildRow('HOLE RATE', '', ctrl);
}

// ── ライン消去中ダメージ ───────────────────────
function _buildGarbageDamageRow() {
    const current = currentVsSettings.tet.garbageDamageOnClear;

    const ctrl = document.createElement('div');
    ctrl.className = 'vs-setting-control';

    const btnGroup = document.createElement('div');
    btnGroup.className = 'vs-setting-btn-group';

    ['ON', 'OFF'].forEach(label => {
        const btn = document.createElement('button');
        const isActive = (label === 'ON') ? current : !current;
        btn.className = 'vs-setting-step-btn' + (isActive ? ' active' : '');
        btn.textContent = label;
        btn.onclick = () => {
            currentVsSettings.tet.garbageDamageOnClear = (label === 'ON');
            saveVsSettings();
            btnGroup.querySelectorAll('.vs-setting-step-btn').forEach(b => {
                b.classList.toggle('active',
                    (b.textContent === 'ON') === currentVsSettings.tet.garbageDamageOnClear
                );
            });
        };
        btnGroup.appendChild(btn);
    });

    ctrl.appendChild(btnGroup);
    return _buildRow('DMG ON CLR', '', ctrl);
}

// ── おじゃまレート（スライダー、10〜700、10刻み） ──
function _buildOjamaRateRow() {
    const current = currentVsSettings.puyo.ojamaRate;

    const ctrl = document.createElement('div');
    ctrl.className = 'vs-setting-control';

    const valLabel = document.createElement('span');
    valLabel.className = 'vs-setting-value-label';
    valLabel.id = 'vss-val-ojamaRate';
    valLabel.textContent = String(current);

    const slider = document.createElement('input');
    slider.type  = 'range';
    slider.min   = '10';
    slider.max   = '700';
    slider.step  = '10';
    slider.value = String(current);
    slider.className = 'vs-setting-slider';

    slider.oninput = () => {
        const val = parseInt(slider.value);
        currentVsSettings.puyo.ojamaRate = val;
        valLabel.textContent = String(val);
        saveVsSettings();
    };

    ctrl.appendChild(valLabel);
    ctrl.appendChild(slider);

    const markers = document.createElement('div');
    markers.className = 'vs-setting-markers';
    [10, 70, 140, 280, 420, 560, 700].forEach(v => {
        const m = document.createElement('span');
        m.textContent = String(v);
        markers.appendChild(m);
    });
    ctrl.appendChild(markers);

    return _buildRow('OJAMA RATE', '', ctrl);
}

// ── 最小連結数 ─────────────────────────────
function _buildEraseCountRow() {
    const options = [2, 3, 4, 5, 6];
    const current = currentVsSettings.puyo.eraseCount;

    const ctrl = document.createElement('div');
    ctrl.className = 'vs-setting-control';

    const btnGroup = document.createElement('div');
    btnGroup.className = 'vs-setting-btn-group';

    options.forEach(val => {
        const btn = document.createElement('button');
        btn.className = 'vs-setting-step-btn' + (val === current ? ' active' : '');
        btn.textContent = String(val);
        btn.dataset.value = String(val);
        btn.onclick = () => {
            currentVsSettings.puyo.eraseCount = val;
            saveVsSettings();
            btnGroup.querySelectorAll('.vs-setting-step-btn').forEach(b => {
                b.classList.toggle('active', parseInt(b.dataset.value) === val);
            });
        };
        btnGroup.appendChild(btn);
    });

    ctrl.appendChild(btnGroup);
    return _buildRow('MIN CONNECT', '', ctrl);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// サマリー表示（versus-check-page に反映）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _updateVsSettingsSummary() {
    const el = document.getElementById('vs-settings-summary');
    if (!el) return;

    const s = currentVsSettings;
    const isDefault = JSON.stringify(s) === JSON.stringify(DEFAULT_VS_SETTINGS);

    if (isDefault) {
        el.textContent = 'ALL DEFAULT';
        el.style.color = '';
        return;
    }

    const parts = [];

    const mt = s.all.marginTime;
    if (mt !== DEFAULT_VS_SETTINGS.all.marginTime) {
        parts.push(`MARGIN:${_formatMarginTime(mt)}`);
    }

    const bp = s.all.attackBias.player;
    const bc = s.all.attackBias.cpu;
    if (bp !== 0) parts.push(`P-BIAS:${bp > 0 ? '+' : ''}${bp}`);
    if (bc !== 0) parts.push(`C-BIAS:${bc > 0 ? '+' : ''}${bc}`);

    if (!s.tet.holdEnabled) parts.push('HOLD:OFF');
    if (s.tet.garbageHoleRate !== DEFAULT_VS_SETTINGS.tet.garbageHoleRate) {
        parts.push(`HOLE:${s.tet.garbageHoleRate}%`);
    }
    if (!s.tet.garbageDamageOnClear) {
        parts.push('DMG-ON-CLR:OFF');
    }

    if (s.puyo.ojamaRate !== DEFAULT_VS_SETTINGS.puyo.ojamaRate) {
        parts.push(`RATE:${s.puyo.ojamaRate}`);
    }
    if (s.puyo.eraseCount !== DEFAULT_VS_SETTINGS.puyo.eraseCount) {
        parts.push(`CONNECT:${s.puyo.eraseCount}`);
    }

    el.textContent = parts.join(' / ');
    el.style.color = 'var(--accent, #c471ed)';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ユーティリティ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function _deepMerge(defaults, overrides) {
    const result = _deepClone(defaults);
    for (const key in overrides) {
        if (
            overrides[key] !== null &&
            typeof overrides[key] === 'object' &&
            !Array.isArray(overrides[key]) &&
            typeof result[key] === 'object'
        ) {
            result[key] = _deepMerge(result[key], overrides[key]);
        } else {
            result[key] = overrides[key];
        }
    }
    return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 初期化
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_updateVsSettingsSummary();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// router.js からのエントリポイント
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * versus-check ページのサマリー表示を更新する。
 * router.js の switchPage('versus-check') から呼ばれる。
 */
function renderVsSettingsSummary() {
    _updateVsSettingsSummary();
}

/**
 * vs-settings ページを開くときに呼ばれる。
 * 設定ページのUI全体を（再）描画する。
 * router.js の switchPage('vs-settings') から呼ばれる。
 */
function _updateVsSettingsPage() {
    renderVsSettingsPage();
}