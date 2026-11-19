// ─────────────────────────────────────────────
// vs_settings.js
// VERSUS モード専用設定の管理・UI生成・エンジン注入
// settings.js とは独立して動作する（保存キーも別）
// ─────────────────────────────────────────────

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 定数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 保存は対戦の種類（プロファイル）ごと。通常 VERSUS = 'standard'、ZONE BATTLE = 'zone'
// （設計 source_assets/memory/mode/tet_zone/tetlabo-zone-battle-design.md §2.4）
const VS_SETTINGS_STORAGE_KEY = 'game_vs_settings';
const VS_SETTINGS_ZONE_STORAGE_KEY = 'game_vs_settings_zone';

/**
 * 火力補正テーブル（bias + 3 をインデックスとする）
 * TET・PUYOで共通の乗率。表示用の % は四捨五入した値。
 * 適用は floor(火力 × 乗率)（最低 1 には引き上げない＝ −3 の 1〜2 ラインは 0）。
 * 乗率は分数のまま持つ（0.33 だと 6 × 0.33 = 1.98 → 1 のように 3 の倍数が 1 つ下へ切り捨てられていた）。
 * bias: -3 / -2 / -1 / 0 / +1 / +2 / +3
 */
const ATTACK_BIAS_TABLE = [
    { num: 1, den: 3, pct: 33 },
    { num: 1, den: 2, pct: 50 },
    { num: 3, den: 4, pct: 75 },
    { num: 1, den: 1, pct: 100 },
    { num: 4, den: 3, pct: 133 },
    { num: 2, den: 1, pct: 200 },
    { num: 3, den: 1, pct: 300 },
];

/**
 * マージンタイムのステップ定義
 * 正の数 = 発動までの秒数（0 = 即時発動）
 * 負の数 = その秒数ぶん「すでにマージンが経過した状態」で即突入する
 *          （マージンテーブルを進めた状態でVSを開始する）。-160でTET/PUYO両テーブルが上限。
 */
// ZONE TIME / ZONE CHARGE で選べる値・既定値はエンジン（game/tet/zone.js）のもの。
// index.html でこのファイルは game/tet/zone.js より後に読み込む（読み込み時に loadVsSettings が使うため）
const VS_ZONE_TIME_OPTIONS = ZONE_QUARTER_MS_OPTIONS;
const VS_ZONE_CHARGE_OPTIONS = ZONE_QUARTER_LINES_OPTIONS;
const MARGIN_TIME_STEPS = [-160, -128, -96, -64, -32, 0, 32, 64, 96, 128, 160, 192];

/**
 * PUYO SPEED の段階（演出時間の倍率。設計 source_assets/memory/v2.3.2/tetlabo-v2.3.2-puyo-speed-design.md）
 * 点滅・消去後の間・落下・着地振動・fixWait・NEXT遷移・ちぎりだけを速くする（操作・おじゃまの配送は等速）。
 */
const PUYO_SPEED_STEPS = [1, 1.25, 1.5, 2, 3];

/** デフォルト設定値 */
const DEFAULT_VS_SETTINGS = {
    all: {
        marginEnabled: true,  // false=マージンタイム無効（marginTime は保持される）
        marginTime: 96,       // 0=即時、正の整数=秒数、負数=事前経過秒数
        attackBias: {
            player: 0,        // -3 ~ +3
            cpu:    0         // -3 ~ +3
        }
    },
    tet: {
        holdEnabled: true,
        garbageHoleRate: 70,
        garbageDamageOnClear: true
        // ZONE は ZONE BATTLE（DEFAULT_ZONE_BATTLE_SETTINGS）だけ。通常 VERSUS は常に ZONE なし
    },
    puyo: {
        ojamaRate:  70,       // 10~120 (10刻み)
        eraseCount: 4,        // 2~6
        colorCount: 4,        // 2~5（使用色数）
        chainMin:   0,        // 連鎖縛り: 0=OFF、2~20=n連鎖未満の火力を0にする
        speed: {              // PUYO SPEED（演出時間の倍率。PUYO_SPEED_STEPS）
            player: 1,
            cpu:    1
        }
    }
};

/**
 * ZONE BATTLE の既定値（テト同士だけなので PUYO の節は持たない。ZONE は常に ON）。
 * ZONE TIME / CHARGE の値と既定はエンジン（game/tet/zone.js）のもの。
 * B2 以降でフェーズ・MARGIN TRIGGER などをここへ足す。
 */
const DEFAULT_ZONE_BATTLE_SETTINGS = {
    all: {
        marginEnabled: true,
        marginTime: 96,
        attackBias: {
            player: 0,
            cpu:    0
        }
    },
    tet: {
        holdEnabled: true,
        garbageHoleRate: 70,
        garbageDamageOnClear: true,
        phase: true,          // PHASE: ON = スコアでフェーズが進み、ZONE TIME / CHARGE はフェーズの表（game/tet/zone.js ZONE_PHASE_TABLE）。OFF = 下の 2 つを使う
        zoneTime: ZONE_VS_QUARTER_MS_DEFAULT,      // ZONE TIME: 1/4 ゲージあたりの長さ（ms。PHASE OFF のとき）
        zoneSplit: true,      // ZONE ATTACK: true=SPLIT（発動中の攻撃を 1 回ぶんずつ → 表のかたまりを後から順に）/ false=MERGE（まとめて同時に）
        zoneCharge: ZONE_VS_QUARTER_LINES_DEFAULT  // ZONE CHARGE: 1/4 ゲージに必要なライン数（PHASE OFF のとき）
    }
};

const VS_SETTINGS_PROFILES = {
    standard: { key: VS_SETTINGS_STORAGE_KEY,      defaults: DEFAULT_VS_SETTINGS,          subtitle: 'VERSUS MODE ONLY', tabs: ['all', 'tet', 'puyo'] },
    zone:     { key: VS_SETTINGS_ZONE_STORAGE_KEY, defaults: DEFAULT_ZONE_BATTLE_SETTINGS, subtitle: 'ZONE BATTLE',      tabs: ['all', 'tet'] },
};

// いま読み書きしているプロファイル（versus.js の setVersusBattle が switchVsSettingsProfile で切り替える）
let vsSettingsProfile = 'standard';

function _vsProfile() {
    return VS_SETTINGS_PROFILES[vsSettingsProfile] || VS_SETTINGS_PROFILES.standard;
}

function _vsDefaults() {
    return _vsProfile().defaults;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ロード / セーブ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function loadVsSettings() {
    const prof = _vsProfile();
    const defaults = prof.defaults;
    let saved = null;
    try { saved = localStorage.getItem(prof.key); } catch (e) { /* 読めなければ既定 */ }
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            // 旧形式（marginTime:null=OFF）→ marginEnabled:false へ移行
            if (parsed && parsed.all && parsed.all.marginTime === null) {
                parsed.all.marginEnabled = false;
                delete parsed.all.marginTime;
            }
            const merged = _deepMerge(defaults, parsed);
            // 既定に無い節・キーは読み捨てる（通常 VERSUS に以前あった tet.zone / zoneTime などは
            // ZONE BATTLE へ移さず、ここで捨てる。設計 §2.4）
            _dropUnknownKeys(merged, defaults);
            if (vsSettingsProfile === 'zone') {
                // ZONE CHARGE / ZONE TIME: 選べない値（以前の選択肢 4 など）は既定へ戻す
                if (!VS_ZONE_CHARGE_OPTIONS.includes(merged.tet.zoneCharge)) merged.tet.zoneCharge = defaults.tet.zoneCharge;
                if (!VS_ZONE_TIME_OPTIONS.includes(merged.tet.zoneTime)) merged.tet.zoneTime = defaults.tet.zoneTime;
            }
            return merged;
        } catch (e) {
            try { localStorage.removeItem(prof.key); } catch (e2) { /* 無視 */ }
        }
    }
    return _deepClone(defaults);
}

/**
 * 読み書きするプロファイルを切り替え、その保存を読み直す（未保存の変更は捨てる）。
 * @param {'standard'|'zone'} profile
 */
function switchVsSettingsProfile(profile) {
    const next = VS_SETTINGS_PROFILES[profile] ? profile : 'standard';
    if (next === vsSettingsProfile) return;
    vsSettingsProfile = next;
    currentVsSettings = loadVsSettings();
    if (!_vsProfile().tabs.includes(currentVsSettingsTab)) currentVsSettingsTab = 'all';
    _updateVsSettingsSummary();
}

// 各コントロールの変更はメモリ上の currentVsSettings に入れるだけ（SAVE を押すまで確定しない。
// ホーム画面の SETTINGS と同じ扱い）。保存は commitVsSettings()。
function saveVsSettings() {
    _updateVsSettingsSummary();
}

function commitVsSettings() {
    try { localStorage.setItem(_vsProfile().key, JSON.stringify(currentVsSettings)); } catch (e) { /* 保存できなくても続ける */ }
    _updateVsSettingsSummary();
}

function saveVsSettingsFromUi() {
    commitVsSettings();
    if (typeof showToast === 'function') showToast();
    window.SeManager?.play('menu_decide');
}

// タブ（ALL / TET / PUYO）。設定のキー（currentVsSettings.all など）と同じ名前
let currentVsSettingsTab = 'all';

function setVsSettingsTab(tab) {
    if (!_vsProfile().tabs.includes(tab)) tab = 'all';
    if (!document.querySelector(`.vs-settings-tab-panel[data-tab="${tab}"]`)) return;
    currentVsSettingsTab = tab;
    document.querySelectorAll('#vs-settings-tab-toggle .opt-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.vs-settings-tab-panel').forEach(panel => {
        panel.classList.toggle('active', panel.dataset.tab === tab);
    });
}

// RESET DEFAULT: 確認ダイアログで「表示中のタブだけ」か「すべて」かを選ばせる（SAVE まで確定しない）
async function resetVsSettings() {
    if (typeof stopListeningBind === 'function') stopListeningBind();
    const tab = currentVsSettingsTab;
    const choice = await TetDialog.choose({
        title: 'RESET DEFAULT',
        message: `${tab.toUpperCase()} タブの設定を初期値に戻します。\nSAVE を押すまで確定しません。`,
        buttons: [
            { label: 'THIS TAB', value: 'tab', kind: 'danger' },
            { label: 'ALL TABS', value: 'all', kind: 'danger' },
            { label: 'CANCEL', value: 'cancel', kind: 'secondary', cancel: true },
        ],
        initial: 'cancel',
    });
    const defaults = _vsDefaults();
    if (choice === 'tab') currentVsSettings[tab] = _deepClone(defaults[tab]);
    else if (choice === 'all') currentVsSettings = _deepClone(defaults);
    else return;
    _updateVsSettingsSummary();
    renderVsSettingsPage();
    window.SeManager?.play('menu_decide');
}

// 保存済みの値と比べて未保存の変更があるか
function isVsSettingsDirty() {
    return JSON.stringify(currentVsSettings) !== JSON.stringify(loadVsSettings());
}

// BACK（Esc もここへ来る）。未保存の変更があれば確認ダイアログを出す
async function requestLeaveVsSettings() {
    if (!isVsSettingsDirty()) { backFromVsSettings(); return; }
    const choice = await TetDialog.choose({
        title: 'UNSAVED CHANGES',
        message: '変更が保存されていません。保存してから戻りますか？',
        buttons: [
            { label: 'SAVE & BACK', value: 'save', kind: 'primary' },
            { label: 'DISCARD', value: 'discard', kind: 'danger' },
            { label: 'CANCEL', value: 'cancel', kind: 'secondary', cancel: true },
        ],
        initial: 'save',
    });
    if (choice === 'save') { commitVsSettings(); backFromVsSettings(); }
    else if (choice === 'discard') { currentVsSettings = loadVsSettings(); _updateVsSettingsSummary(); backFromVsSettings(); }
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
 * @returns {number} 例: bias=0 → 1.0、bias=+1 → 4/3、bias=−3 → 1/3
 */
function getAttackMultiplier(side) {
    const bias = currentVsSettings.all.attackBias[side] ?? 0;
    const e = ATTACK_BIAS_TABLE[bias + 3] || ATTACK_BIAS_TABLE[3];
    return e.num / e.den;
}

/**
 * マージンタイムをミリ秒で取得する。
 * @returns {number|null} null=OFF、0=即時、正数=突入までのms、負数=事前経過ms（テーブルを進めて即突入）
 */
function getMarginTimeMs() {
    if (!currentVsSettings.all.marginEnabled) return null;   // OFF
    return currentVsSettings.all.marginTime * 1000;          // 0ms（即時）/ 正数ms / 負数ms（事前経過）
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

    // ZONE は ZONE BATTLE（テト同士）のときだけ。通常 VERSUS は常に無し。両者へ同じ値を入れる
    // （ZONE の値が無い通常 VERSUS ではエンジンの既定を入れておく。vsZone=false なので使われない）
    const zoneOn = vsSettingsProfile === 'zone' && playerRule === 'tet' && cpuRule === 'tet';
    for (const g of [playerGame, cpuGame]) {
        if (!g) continue;
        g.vsZone = zoneOn;
        g.vsZoneQuarterLines = zoneOn ? s.tet.zoneCharge : ZONE_VS_QUARTER_LINES_DEFAULT;
        g.vsZoneQuarterMs = zoneOn ? s.tet.zoneTime : ZONE_VS_QUARTER_MS_DEFAULT;
        g.vsZoneSplit = zoneOn ? s.tet.zoneSplit !== false : true;
        g.vsZonePhase = zoneOn && s.tet.phase !== false;
    }

    // ── プレイヤー側 ──────────────────────────
    if (playerGame) {
        playerGame.vsAttackMultiplier = getAttackMultiplier('player');
        playerGame.vsMarginTimeMs     = getMarginTimeMs();
        // HOLE RATE/DAMAGE ON CLEAR は「TET側の盤面に積むおじゃま」の設定。
        // 送信元が puyo でも tet 盤面へのおじゃま生成で参照されるため、
        // playerRule に関係なく常に注入する。
        playerGame.vsGarbageHoleRate = s.tet.garbageHoleRate;
        playerGame.vsGarbageDamageOnClear = s.tet.garbageDamageOnClear;

        if (playerRule === 'tet') {
            playerGame.vsHoldEnabled = s.tet.holdEnabled;
        }
        if (playerRule === 'puyo') {
            playerGame.vsOjamaRate  = s.puyo.ojamaRate;
            playerGame.vsEraseCount = s.puyo.eraseCount;
            playerGame.vsColorCount = s.puyo.colorCount;
            playerGame.vsChainMin   = s.puyo.chainMin;
            playerGame.vsPuyoSpeed  = s.puyo.speed.player;
        }
    }

    // ── CPU 側 ───────────────────────────────
    if (cpuGame) {
        cpuGame.vsAttackMultiplier = getAttackMultiplier('cpu');
        cpuGame.vsMarginTimeMs     = getMarginTimeMs();
        cpuGame.vsGarbageHoleRate = s.tet.garbageHoleRate;
        cpuGame.vsGarbageDamageOnClear = s.tet.garbageDamageOnClear;

        if (cpuRule === 'tet') {
            cpuGame.vsHoldEnabled = s.tet.holdEnabled;
        }
        if (cpuRule === 'puyo') {
            cpuGame.vsOjamaRate  = s.puyo.ojamaRate;
            cpuGame.vsEraseCount = s.puyo.eraseCount;
            cpuGame.vsColorCount = s.puyo.colorCount;
            cpuGame.vsChainMin   = s.puyo.chainMin;
            cpuGame.vsPuyoSpeed  = s.puyo.speed.cpu;
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
    const isZone = vsSettingsProfile === 'zone';
    _syncVsSettingsChrome();

    // ── ALL（共通） ────────────────────────────
    container.appendChild(_buildSection('ALL', [
        _buildMarginEnabledRow(),
        _buildMarginTimeRow(),
        _buildAttackBiasRow('player'),
        _buildAttackBiasRow('cpu')
    ]));

    // ── TET ───────────────────────────────────
    // ZONE の行は ZONE BATTLE だけ（常に ON なので ON/OFF の行は無い）
    container.appendChild(_buildSection('TET', [
        _buildHoldToggleRow(),
        _buildGarbageHoleRateRow(),
        _buildGarbageDamageRow(),
        ...(isZone ? [_buildZonePhaseRow(), _buildZoneTimeRow(), _buildZoneChargeRow(), _buildZoneSplitRow()] : [])
    ]));

    // ── PUYO（ZONE BATTLE はテト同士だけなので無し） ──
    if (!isZone) container.appendChild(_buildSection('PUYO', [
        _buildOjamaRateRow(),
        _buildEraseCountRow(),
        _buildColorCountRow(),
        _buildChainMinRow(),
        _buildPuyoSpeedRow('player'),
        _buildPuyoSpeedRow('cpu')
    ]));

    setVsSettingsTab(currentVsSettingsTab);
}

// 見出し下のプロファイル名と、タブのボタン（ZONE BATTLE は PUYO タブを出さない）
function _syncVsSettingsChrome() {
    const prof = _vsProfile();
    const sub = document.querySelector('#vs-settings-header .vs-settings-subtitle');
    if (sub) sub.textContent = prof.subtitle;
    document.querySelectorAll('#vs-settings-tab-toggle .opt-btn').forEach(btn => {
        btn.style.display = prof.tabs.includes(btn.dataset.tab) ? '' : 'none';
    });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 各設定行のビルダー
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _buildSection(title, rows) {
    const sec = document.createElement('div');
    sec.className = 'vs-setting-section vs-settings-tab-panel';
    sec.dataset.tab = title.toLowerCase();

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
// ON/OFF は別行（MARGIN）、秒数は MARGIN TIME のスライダー。
// MARGIN_TIME_STEPS: [-160, ..., -32, 0, 32, ..., 192]
// 0=即時発動、正数=突入までの秒数、負数=テーブルを進めた状態で即突入
function _buildMarginEnabledRow() {
    const ctrl = document.createElement('div');
    ctrl.className = 'vs-setting-control';

    const btnGroup = document.createElement('div');
    btnGroup.className = 'vs-setting-btn-group';

    ['ON', 'OFF'].forEach(label => {
        const btn = document.createElement('button');
        btn.className = 'vs-setting-step-btn'
            + ((label === 'ON') === currentVsSettings.all.marginEnabled ? ' active' : '');
        btn.textContent = label;
        btn.onclick = () => {
            currentVsSettings.all.marginEnabled = (label === 'ON');
            saveVsSettings();
            btnGroup.querySelectorAll('.vs-setting-step-btn').forEach(b => {
                b.classList.toggle('active', (b.textContent === 'ON') === currentVsSettings.all.marginEnabled);
            });
            _syncMarginTimeInert();
        };
        btnGroup.appendChild(btn);
    });

    ctrl.appendChild(btnGroup);
    return _buildRow('MARGIN', '', ctrl);
}

// MARGIN が OFF の間は秒数の行を減光する（値は保持され、ONに戻すとそのまま使われる）
function _syncMarginTimeInert() {
    const row = document.getElementById('vss-row-marginTime');
    if (row) row.classList.toggle('is-inert', !currentVsSettings.all.marginEnabled);
}

function _buildMarginTimeRow() {
    const current = currentVsSettings.all.marginTime;

    // 現在値に対応するスライダーインデックス（見つからなければデフォルト値の位置）
    const currentIdx = (() => {
        const idx = MARGIN_TIME_STEPS.indexOf(current);
        return idx !== -1 ? idx : MARGIN_TIME_STEPS.indexOf(_vsDefaults().all.marginTime);
    })();

    const ctrl = document.createElement('div');
    ctrl.className = 'vs-setting-control';

    const valLabel = document.createElement('span');
    valLabel.className = 'vs-setting-value-label';
    valLabel.id = 'vss-val-marginTime';
    valLabel.textContent = _formatMarginTime(MARGIN_TIME_STEPS[currentIdx]);

    const slider = document.createElement('input');
    slider.type  = 'range';
    slider.min   = '0';
    slider.max   = String(MARGIN_TIME_STEPS.length - 1);
    slider.step  = '1';
    slider.value = String(currentIdx);
    // ステップ数が多いため、この行だけスライダーを広げる
    slider.className = 'vs-setting-slider vs-setting-slider--wide';

    slider.oninput = () => {
        const val = MARGIN_TIME_STEPS[parseInt(slider.value)];
        currentVsSettings.all.marginTime = val;
        valLabel.textContent = _formatMarginTime(val);
        saveVsSettings();
    };

    ctrl.appendChild(valLabel);
    ctrl.appendChild(slider);

    // 目盛り
    ctrl.appendChild(_buildSliderMarkers(
        MARGIN_TIME_STEPS.map((s, i) => ({ pos: i, label: _formatMarginTime(s) })),
        0, MARGIN_TIME_STEPS.length - 1, true));

    const row = _buildRow('MARGIN TIME', '(sec)', ctrl);
    row.id = 'vss-row-marginTime';
    row.classList.toggle('is-inert', !currentVsSettings.all.marginEnabled);
    return row;
}

// スライダーの目盛り。items = [{ pos: スライダー値, label }]、min/max はスライダーの範囲。
// 各目盛りを「つまみの中心が来る位置」（両端はつまみ半分だけ内側）に置く。
// 値が等間隔でない目盛り（OJAMA RATE 等）もずれない。位置は CSS の --f（0〜1）で指定。
function _buildSliderMarkers(items, min, max, wide) {
    const markers = document.createElement('div');
    markers.className = 'vs-setting-markers' + (wide ? ' vs-setting-markers--wide' : '');
    items.forEach(({ pos, label }) => {
        const m = document.createElement('span');
        m.textContent = label;
        m.style.setProperty('--f', String((pos - min) / (max - min)));
        markers.appendChild(m);
    });
    return markers;
}

function _formatMarginTime(val) {
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

// ── PUYO SPEED（演出時間の倍率・側ごと）──────
function _buildPuyoSpeedRow(side) {
    const current   = currentVsSettings.puyo.speed[side];
    const sideLabel = side === 'player' ? 'YOUR SIDE' : 'CPU SIDE';

    const ctrl = document.createElement('div');
    ctrl.className = 'vs-setting-control';

    const valLabel = document.createElement('span');
    valLabel.className = 'vs-setting-value-label';
    valLabel.id = `vss-val-puyoSpeed-${side}`;
    valLabel.textContent = _formatPuyoSpeed(current);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'vs-setting-btn-group';
    btnGroup.id = `vss-btngroup-puyoSpeed-${side}`;

    PUYO_SPEED_STEPS.forEach(step => {
        const btn = document.createElement('button');
        btn.className = 'vs-setting-step-btn' + (step === current ? ' active' : '');
        btn.textContent = _formatPuyoSpeed(step);
        btn.dataset.value = String(step);
        btn.onclick = () => {
            currentVsSettings.puyo.speed[side] = step;
            saveVsSettings();
            btnGroup.querySelectorAll('.vs-setting-step-btn').forEach(b => {
                b.classList.toggle('active', parseFloat(b.dataset.value) === step);
            });
            valLabel.textContent = _formatPuyoSpeed(step);
        };
        btnGroup.appendChild(btn);
    });

    ctrl.appendChild(valLabel);
    ctrl.appendChild(btnGroup);

    return _buildRow('PUYO SPEED', sideLabel, ctrl);
}

function _formatPuyoSpeed(v) {
    return `×${v.toFixed(v * 100 % 10 === 0 ? 1 : 2)}`;
}

function _formatBias(bias) {
    const pct  = ATTACK_BIAS_TABLE[bias + 3].pct;
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

    ctrl.appendChild(_buildSliderMarkers([0, 50, 100].map(v => ({ pos: v, label: String(v) })), 0, 100));

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

// ── PHASE（ZONE BATTLE。ON の間は ZONE TIME / CHARGE をフェーズの表で決めるので、その 2 行を減光） ──
function _buildZonePhaseRow() {
    const ctrl = document.createElement('div');
    ctrl.className = 'vs-setting-control';

    const btnGroup = document.createElement('div');
    btnGroup.className = 'vs-setting-btn-group';

    const isOn = () => currentVsSettings.tet.phase !== false;
    ['ON', 'OFF'].forEach(label => {
        const btn = document.createElement('button');
        btn.className = 'vs-setting-step-btn' + ((label === 'ON') === isOn() ? ' active' : '');
        btn.textContent = label;
        btn.onclick = () => {
            currentVsSettings.tet.phase = (label === 'ON');
            saveVsSettings();
            btnGroup.querySelectorAll('.vs-setting-step-btn').forEach(b => {
                b.classList.toggle('active', (b.textContent === 'ON') === isOn());
            });
            _syncZonePhaseInert();
        };
        btnGroup.appendChild(btn);
    });

    ctrl.appendChild(btnGroup);
    // しきい値は画面で選ばせない（game/tet/zone.js の ZONE_PHASE_SCORES）。サブラベルに出すだけ
    return _buildRow('PHASE', '(score ' + ZONE_PHASE_SCORES.map(v => v.toLocaleString('en-US')).join(' / ') + ')', ctrl);
}

function _syncZonePhaseInert() {
    const on = currentVsSettings.tet.phase !== false;
    for (const id of ['vss-row-zoneTime', 'vss-row-zoneCharge']) {
        const row = document.getElementById(id);
        if (row) row.classList.toggle('is-inert', on);
    }
}

// ── ZONE TIME（1/4 ゲージあたりの長さ） ──
function _buildZoneTimeRow() {
    const current = currentVsSettings.tet.zoneTime;

    const ctrl = document.createElement('div');
    ctrl.className = 'vs-setting-control';

    const btnGroup = document.createElement('div');
    btnGroup.className = 'vs-setting-btn-group';

    VS_ZONE_TIME_OPTIONS.forEach(val => {
        const btn = document.createElement('button');
        btn.className = 'vs-setting-step-btn' + (val === current ? ' active' : '');
        btn.textContent = (val / 1000) + 's';
        btn.dataset.value = String(val);
        btn.onclick = () => {
            currentVsSettings.tet.zoneTime = val;
            saveVsSettings();
            btnGroup.querySelectorAll('.vs-setting-step-btn').forEach(b => {
                b.classList.toggle('active', parseInt(b.dataset.value) === val);
            });
        };
        btnGroup.appendChild(btn);
    });

    ctrl.appendChild(btnGroup);
    const row = _buildRow('ZONE TIME', '(sec / 25%)', ctrl);
    row.id = 'vss-row-zoneTime';
    row.classList.toggle('is-inert', currentVsSettings.tet.phase !== false);
    return row;
}

// ── ZONE ATTACK（終了時の火力の送り方。SPLIT=分けて送る / MERGE=まとめて送る） ──
function _buildZoneSplitRow() {
    const ctrl = document.createElement('div');
    ctrl.className = 'vs-setting-control';

    const btnGroup = document.createElement('div');
    btnGroup.className = 'vs-setting-btn-group';

    const isSplit = () => currentVsSettings.tet.zoneSplit !== false;
    ['SPLIT', 'MERGE'].forEach(label => {
        const btn = document.createElement('button');
        btn.className = 'vs-setting-step-btn' + ((label === 'SPLIT') === isSplit() ? ' active' : '');
        btn.textContent = label;
        btn.onclick = () => {
            currentVsSettings.tet.zoneSplit = (label === 'SPLIT');
            saveVsSettings();
            btnGroup.querySelectorAll('.vs-setting-step-btn').forEach(b => {
                b.classList.toggle('active', (b.textContent === 'SPLIT') === isSplit());
            });
        };
        btnGroup.appendChild(btn);
    });

    ctrl.appendChild(btnGroup);
    const row = _buildRow('ZONE ATTACK', '(send)', ctrl);
    row.id = 'vss-row-zoneSplit';
    return row;
}

// ── ZONE CHARGE（1/4 ゲージに必要なライン数） ──
function _buildZoneChargeRow() {
    const options = VS_ZONE_CHARGE_OPTIONS;
    const current = currentVsSettings.tet.zoneCharge;

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
            currentVsSettings.tet.zoneCharge = val;
            saveVsSettings();
            btnGroup.querySelectorAll('.vs-setting-step-btn').forEach(b => {
                b.classList.toggle('active', parseInt(b.dataset.value) === val);
            });
        };
        btnGroup.appendChild(btn);
    });

    ctrl.appendChild(btnGroup);
    const row = _buildRow('ZONE CHARGE', '(lines / 25%)', ctrl);
    row.id = 'vss-row-zoneCharge';
    row.classList.toggle('is-inert', currentVsSettings.tet.phase !== false);
    return row;
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

    ctrl.appendChild(_buildSliderMarkers([10, 70, 140, 280, 420, 560, 700].map(v => ({ pos: v, label: String(v) })), 10, 700));

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

// ── 使用色数（2〜5） ───────────────────────
function _buildColorCountRow() {
    const options = [2, 3, 4, 5];
    const current = currentVsSettings.puyo.colorCount;

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
            currentVsSettings.puyo.colorCount = val;
            saveVsSettings();
            btnGroup.querySelectorAll('.vs-setting-step-btn').forEach(b => {
                b.classList.toggle('active', parseInt(b.dataset.value) === val);
            });
        };
        btnGroup.appendChild(btn);
    });

    // MIN CONNECT(5個)と値の縦位置を揃えるための不可視ダミー（FocusNav は visibility:hidden を除外する）
    const pad = document.createElement('button');
    pad.className = 'vs-setting-step-btn';
    pad.style.visibility = 'hidden';
    pad.tabIndex = -1;
    pad.setAttribute('aria-hidden', 'true');
    pad.textContent = '0';
    btnGroup.appendChild(pad);

    ctrl.appendChild(btnGroup);
    return _buildRow('COLORS', '', ctrl);
}

// ── 連鎖縛り（スライダー、OFF / 2〜20） ──────
// スライダー値 1=OFF、2〜20=n連鎖。保存値は OFF=0。
function _formatChainMin(val) {
    return val ? `${val} CHAIN` : 'OFF';
}

function _buildChainMinRow() {
    const current = currentVsSettings.puyo.chainMin || 0;

    const ctrl = document.createElement('div');
    ctrl.className = 'vs-setting-control';

    const valLabel = document.createElement('span');
    valLabel.className = 'vs-setting-value-label';
    valLabel.id = 'vss-val-chainMin';
    valLabel.textContent = _formatChainMin(current);

    const slider = document.createElement('input');
    slider.type  = 'range';
    slider.min   = '1';
    slider.max   = '20';
    slider.step  = '1';
    slider.value = String(current || 1);
    slider.className = 'vs-setting-slider';

    slider.oninput = () => {
        const v = parseInt(slider.value);
        const val = v <= 1 ? 0 : v;
        currentVsSettings.puyo.chainMin = val;
        valLabel.textContent = _formatChainMin(val);
        saveVsSettings();
    };

    ctrl.appendChild(valLabel);
    ctrl.appendChild(slider);

    // スライダー値 1=OFF（下限）、5 / 10 / 15 / 20 は値そのものの位置
    ctrl.appendChild(_buildSliderMarkers(
        [{ pos: 1, label: 'OFF' }, ...[5, 10, 15, 20].map(v => ({ pos: v, label: String(v) }))], 1, 20));

    return _buildRow('CHAIN LIMIT', '(min chain)', ctrl);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// サマリー表示（versus-check-page に反映）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _updateVsSettingsSummary() {
    const el = document.getElementById('vs-settings-summary');
    if (!el) return;

    const s = currentVsSettings;
    const D = _vsDefaults();
    const isDefault = JSON.stringify(s) === JSON.stringify(D);

    if (isDefault) {
        el.textContent = 'ALL DEFAULT';
        el.style.color = '';
        return;
    }

    const parts = [];

    const mt = s.all.marginTime;
    if (!s.all.marginEnabled) {
        parts.push('MARGIN:OFF');
    } else if (mt !== D.all.marginTime) {
        parts.push(`MARGIN:${_formatMarginTime(mt)}`);
    }

    const bp = s.all.attackBias.player;
    const bc = s.all.attackBias.cpu;
    if (bp !== 0) parts.push(`P-BIAS:${bp > 0 ? '+' : ''}${bp}`);
    if (bc !== 0) parts.push(`C-BIAS:${bc > 0 ? '+' : ''}${bc}`);

    if (!s.tet.holdEnabled) parts.push('HOLD:OFF');
    if (s.tet.garbageHoleRate !== D.tet.garbageHoleRate) {
        parts.push(`HOLE:${s.tet.garbageHoleRate}%`);
    }
    if (!s.tet.garbageDamageOnClear) {
        parts.push('DMG-ON-CLR:OFF');
    }
    // ZONE BATTLE: ZONE TIME / CHARGE / ATTACK は既定と違うものだけ
    // PHASE OFF のときだけ PHASE:OFF と ZONE TIME / CHARGE（ON の間は使わないので出さない）
    if (D.tet.zoneTime !== undefined) {
        if (s.tet.phase === false) {
            parts.push('PHASE:OFF');
            parts.push(`ZONE TIME:${s.tet.zoneTime / 1000}s`);
            parts.push(`ZONE CHARGE:${s.tet.zoneCharge}`);
        }
        if ((s.tet.zoneSplit !== false) !== (D.tet.zoneSplit !== false)) parts.push(`ZONE ATTACK:${s.tet.zoneSplit === false ? 'MERGE' : 'SPLIT'}`);
    }

    if (s.puyo) _pushPuyoSummary(parts, s, D);

    el.textContent = parts.join(' / ');
    el.style.color = 'var(--accent, #c471ed)';
}

function _pushPuyoSummary(parts, s, D) {
    if (s.puyo.ojamaRate !== D.puyo.ojamaRate) {
        parts.push(`RATE:${s.puyo.ojamaRate}`);
    }
    if (s.puyo.eraseCount !== D.puyo.eraseCount) {
        parts.push(`CONNECT:${s.puyo.eraseCount}`);
    }
    if (s.puyo.colorCount !== D.puyo.colorCount) {
        parts.push(`COLORS:${s.puyo.colorCount}`);
    }
    if (s.puyo.chainMin) {
        parts.push(`CHAIN-LIMIT:${s.puyo.chainMin}`);
    }
    if (s.puyo.speed.player !== 1) parts.push(`P-SPEED:${_formatPuyoSpeed(s.puyo.speed.player)}`);
    if (s.puyo.speed.cpu !== 1)    parts.push(`C-SPEED:${_formatPuyoSpeed(s.puyo.speed.cpu)}`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ユーティリティ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

// 既定に無いキーを消す（入れ子のオブジェクトも。値の形は _deepMerge の結果のまま）
function _dropUnknownKeys(obj, defaults) {
    for (const key of Object.keys(obj)) {
        if (!(key in defaults)) { delete obj[key]; continue; }
        const d = defaults[key];
        if (d && typeof d === 'object' && !Array.isArray(d) && obj[key] && typeof obj[key] === 'object') {
            _dropUnknownKeys(obj[key], d);
        }
    }
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