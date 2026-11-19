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
// MARGIN SCORE（ZONE BATTLE の MARGIN TRIGGER: SCORE）の突入の点。0 = 即時。以後の刻みはエンジンの TET_MARGIN_SCORE_STEP（game/tet/zone.js）
const MARGIN_SCORE_STEPS = [0, 20000, 40000, 80000, 100000, 160000, 200000];
// PHASE 02・03 へ進むスコア（PHASE TRIGGER: SCORE のとき。フェーズごとの値。既定は game/tet/zone.js ZONE_PHASE_TABLE の score）
const PHASE_SCORE_STEPS = [10000, 20000, 30000, 40000, 60000, 80000, 100000, 120000, 160000, 200000];

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
        marginTrigger: 'time',   // MARGIN TRIGGER: 'time' = MARGIN TIME で突入・32 秒ごと（今どおり）/ 'score' = MARGIN SCORE で突入・20,000 点ごと
        marginTime: 96,
        marginScore: 20000,
        attackBias: {
            player: 0,
            cpu:    0
        }
    },
    tet: {
        holdEnabled: true,
        garbageHoleRate: 90,
        garbageHoleChunk: 10, // HOLE RATE between: かたまりの間（次の攻撃の 1 段目）で同じ穴の確率（PHASE OFF のとき。10 ≒ 今までの「毎回ランダム」）
        garbageDamageOnClear: false,
        phaseTrigger: 'score', // PHASE TRIGGER: 'score' = 両者のスコアの最大値 / 'time' = 試合の時計（しきい値は game/tet/zone.js）
        phase: true,          // PHASE: ON = スコアでフェーズが進み、ZONE TIME / CHARGE はフェーズの表（game/tet/zone.js ZONE_PHASE_TABLE）。OFF = 下の 2 つを使う
        zoneTime: ZONE_VS_QUARTER_MS_DEFAULT,      // ZONE TIME: 1/4 ゲージあたりの長さ（ms。PHASE OFF のとき）
        zoneSplit: true,      // ZONE ATTACK: true=SPLIT（発動中の攻撃を 1 回ぶんずつ → 表のかたまりを後から順に）/ false=MERGE（まとめて同時に）
        zoneCharge: ZONE_VS_QUARTER_LINES_DEFAULT,  // ZONE CHARGE: 1/4 ゲージに必要なライン数（PHASE OFF のとき）
        // PHASE 01〜03 ごとの値（PHASE ON のとき）。既定はエンジンの原作の表（game/tet/zone.js ZONE_PHASE_TABLE）。
        // 画面の HOLE RATE と同じく穴は「同じ穴の確率」で持つ（エンジンの表は「変わる確率」なので 100 から引いて渡す）
        phaseTable: ZONE_PHASE_TABLE.map(r => ({
            holeRate: 100 - r.holeIn,       // HOLE RATE (in chunk)
            holeChunk: 100 - r.holeBetween, // HOLE RATE (between)
            zoneTime: r.quarterMs,          // ZONE TIME（1/4 の長さ ms）
            zoneCharge: r.quarterLines,     // ZONE CHARGE（1/4 のライン数）
            score: r.score                  // TRIGGER SCORE（このフェーズへ進むスコア。01 は 0 固定）
        }))
    }
};

const VS_SETTINGS_PROFILES = {
    standard: { key: VS_SETTINGS_STORAGE_KEY,      defaults: DEFAULT_VS_SETTINGS,          subtitle: 'VERSUS MODE ONLY', tabs: ['all', 'tet', 'puyo'] },
    zone:     { key: VS_SETTINGS_ZONE_STORAGE_KEY, defaults: DEFAULT_ZONE_BATTLE_SETTINGS, subtitle: 'ZONE BATTLE',      tabs: ['all', 'margin', 'phase'] },
};

// ZONE BATTLE のタブは役割で分ける（保存の形 all / tet とは別。設計 tetlabo-zone-battle-design.md §14）。
// RESET DEFAULT の THIS TAB はここに挙げたキーだけ戻す
const VS_ZONE_TAB_KEYS = {
    all:    [['all', 'attackBias'], ['tet', 'holdEnabled'], ['tet', 'garbageDamageOnClear'], ['tet', 'zoneSplit']],
    margin: [['all', 'marginEnabled'], ['all', 'marginTrigger'], ['all', 'marginTime'], ['all', 'marginScore']],
    phase:  [['tet', 'phase'], ['tet', 'phaseTrigger'], ['tet', 'phaseTable'],
             ['tet', 'garbageHoleRate'], ['tet', 'garbageHoleChunk'], ['tet', 'zoneTime'], ['tet', 'zoneCharge']],
};

// HOLE RATE の選択肢（0〜100 の 10 刻み）
const vsValidHoleRate = (v) => Number.isInteger(v) && v >= 0 && v <= 100 && v % 10 === 0;

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
                // PHASE 01〜03 の値: 形が違う・選べない値は既定（原作の表）へ戻す
                merged.tet.phaseTable = _sanitizePhaseTable(merged.tet.phaseTable, defaults.tet.phaseTable);
            }
            return merged;
        } catch (e) {
            try { localStorage.removeItem(prof.key); } catch (e2) { /* 無視 */ }
        }
    }
    return _deepClone(defaults);
}

function _sanitizePhaseTable(v, d) {
    const src = Array.isArray(v) ? v : [];
    let prevScore = 0;
    return d.map((def, i) => {
        const r = (src[i] && typeof src[i] === 'object') ? src[i] : {};
        // 進むスコア: 01 は 0。選べない値は既定。前のフェーズより小さい値は前のフェーズにそろえる
        let score = i === 0 ? 0 : (PHASE_SCORE_STEPS.includes(r.score) ? r.score : def.score);
        score = Math.max(prevScore, score);
        prevScore = score;
        return {
            holeRate: vsValidHoleRate(r.holeRate) ? r.holeRate : def.holeRate,
            holeChunk: vsValidHoleRate(r.holeChunk) ? r.holeChunk : def.holeChunk,
            zoneTime: VS_ZONE_TIME_OPTIONS.includes(r.zoneTime) ? r.zoneTime : def.zoneTime,
            zoneCharge: VS_ZONE_CHARGE_OPTIONS.includes(r.zoneCharge) ? r.zoneCharge : def.zoneCharge,
            score,
        };
    });
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
    if (choice === 'tab' && vsSettingsProfile === 'zone') {
        for (const [sec, key] of (VS_ZONE_TAB_KEYS[tab] || [])) currentVsSettings[sec][key] = _deepClone(defaults[sec][key]);
    }
    else if (choice === 'tab') currentVsSettings[tab] = _deepClone(defaults[tab]);
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
        // PHASE 01〜03 の値（エンジンの表の形 ZONE_PHASE_TABLE。穴は「変わる確率」へ直す）。PHASE OFF・通常 VERSUS は入れない
        if (g.vsZonePhase && Array.isArray(s.tet.phaseTable)) {
            g.vsZonePhaseTable = s.tet.phaseTable.map(r => ({
                quarterLines: r.zoneCharge, quarterMs: r.zoneTime,
                holeIn: 100 - r.holeRate, holeBetween: 100 - r.holeChunk,
                score: r.score,
            }));
        } else delete g.vsZonePhaseTable;
        // ZONE BATTLE の穴の決め方（かたまりの間も着弾をまたいでつなぐ）。通常 VERSUS は入れない＝今までの決め方
        if (zoneOn) g.vsGarbageHoleChunk = s.tet.garbageHoleChunk;
        else delete g.vsGarbageHoleChunk;
        // PHASE TRIGGER・MARGIN TRIGGER（ZONE BATTLE だけ。通常 VERSUS は入れない＝スコアのフェーズなし・時間のマージン）
        if (zoneOn) {
            g.vsZonePhaseTrigger = s.tet.phaseTrigger === 'time' ? 'time' : 'score';
            g.vsMarginTrigger = (s.all.marginEnabled && s.all.marginTrigger === 'score') ? 'score' : 'time';
            g.vsMarginScore = s.all.marginScore;
        } else {
            delete g.vsZonePhaseTrigger;
            delete g.vsMarginTrigger;
            delete g.vsMarginScore;
        }
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

    if (isZone) {
        _renderZoneBattleSections(container);
        setVsSettingsTab(currentVsSettingsTab);
        return;
    }

    // ── ALL（共通） ────────────────────────────
    container.appendChild(_buildSection('ALL', [
        _buildMarginEnabledRow(),
        _buildMarginTimeRow(),
        _buildAttackBiasRow('player'),
        _buildAttackBiasRow('cpu')
    ]));

    // ── TET ───────────────────────────────────
    // ZONE の行は ZONE BATTLE だけ（_renderZoneBattleSections）
    container.appendChild(_buildSection('TET', [
        _buildHoldToggleRow(),
        _buildGarbageHoleRateRow(),
        _buildGarbageDamageRow()
    ]));

    // ── PUYO ──
    container.appendChild(_buildSection('PUYO', [
        _buildOjamaRateRow(),
        _buildEraseCountRow(),
        _buildColorCountRow(),
        _buildChainMinRow(),
        _buildPuyoSpeedRow('player'),
        _buildPuyoSpeedRow('cpu')
    ]));

    setVsSettingsTab(currentVsSettingsTab);
}

// ── ZONE BATTLE: タブは役割で分ける（ALL = 共通 / MARGIN = 火力の上がり方 / PHASE = フェーズとフェーズごとの値。
// 設計 tetlabo-zone-battle-design.md §14）。保存の形（all / tet）はそのまま
function _renderZoneBattleSections(container) {
    container.appendChild(_buildSection('ALL', [
        _buildAttackBiasRow('player'),
        _buildAttackBiasRow('cpu'),
        _buildHoldToggleRow(),
        _buildGarbageDamageRow(),
        _buildZoneSplitRow()
    ]));
    container.appendChild(_buildSection('MARGIN', [
        _buildMarginEnabledRow(),
        _buildMarginTriggerRow(),
        _buildMarginTimeRow(),
        _buildMarginScoreRow()
    ]));
    container.appendChild(_buildSection('PHASE', [
        _buildZonePhaseRow(),
        _buildZonePhaseTriggerRow(),
        _buildZonePhaseValuesGroup()
    ]));
}

// 見出し下のプロファイル名と、タブのボタン（ZONE BATTLE は ALL / MARGIN / PHASE、通常 VERSUS は ALL / TET / PUYO）。
// ZONE BATTLE の色（src/css/pages/zone.css の .is-zone-battle）もここで切り替える
function _syncVsSettingsChrome() {
    const prof = _vsProfile();
    const page = document.getElementById('vs-settings-page');
    if (page) page.classList.toggle('is-zone-battle', vsSettingsProfile === 'zone');
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

// MARGIN が OFF の間は秒数の行を減光する（値は保持され、ONに戻すとそのまま使われる）。
// ZONE BATTLE は MARGIN TRIGGER で使わないほう（TIME / SCORE）も減光する
function _syncMarginTimeInert() {
    const on = currentVsSettings.all.marginEnabled;
    const byScore = vsSettingsProfile === 'zone' && currentVsSettings.all.marginTrigger === 'score';
    const set = (id, inert) => { const row = document.getElementById(id); if (row) row.classList.toggle('is-inert', inert); };
    set('vss-row-marginTime', !on || byScore);
    set('vss-row-marginTrigger', !on);
    set('vss-row-marginScore', !on || !byScore);
}

// ボタンを並べた行（選んだボタンだけ active）。options: [{ label, value }]
function _buildChoiceRow(label, sub, options, get, set, rowId, onChange) {
    const ctrl = document.createElement('div');
    ctrl.className = 'vs-setting-control';
    const btnGroup = document.createElement('div');
    btnGroup.className = 'vs-setting-btn-group';
    options.forEach((o, i) => {
        const btn = document.createElement('button');
        btn.className = 'vs-setting-step-btn' + (o.value === get() ? ' active' : '');
        btn.textContent = o.label;
        btn.dataset.idx = String(i);
        btn.onclick = () => {
            set(o.value);
            saveVsSettings();
            btnGroup.querySelectorAll('.vs-setting-step-btn').forEach(b => {
                b.classList.toggle('active', options[+b.dataset.idx].value === get());
            });
            if (onChange) onChange();
        };
        btnGroup.appendChild(btn);
    });
    ctrl.appendChild(btnGroup);
    const row = _buildRow(label, sub, ctrl);
    if (rowId) row.id = rowId;
    return row;
}

// ── MARGIN TRIGGER（ZONE BATTLE だけ。TIME = MARGIN TIME / SCORE = MARGIN SCORE） ──
function _buildMarginTriggerRow() {
    const row = _buildChoiceRow('MARGIN TRIGGER', '',
        [{ label: 'TIME', value: 'time' }, { label: 'SCORE', value: 'score' }],
        () => (currentVsSettings.all.marginTrigger === 'score' ? 'score' : 'time'),
        (v) => { currentVsSettings.all.marginTrigger = v; },
        'vss-row-marginTrigger', _syncMarginTimeInert);
    row.classList.toggle('is-inert', !currentVsSettings.all.marginEnabled);
    return row;
}

function _formatMarginScore(v) {
    return v === 0 ? 'INSTANT' : `${v / 1000}K`;
}

// ── MARGIN SCORE（ZONE BATTLE だけ。突入の点。以後 TET_MARGIN_SCORE_STEP ごとに 1 段階）。MARGIN TIME と同じスライダー ──
function _buildMarginScoreRow() {
    const row = _buildStepSliderRow('MARGIN SCORE', `(+1 / ${TET_MARGIN_SCORE_STEP / 1000}K)`,
        MARGIN_SCORE_STEPS, _formatMarginScore,
        () => currentVsSettings.all.marginScore,
        (v) => { currentVsSettings.all.marginScore = v; },
        _vsDefaults().all.marginScore, true);
    row.id = 'vss-row-marginScore';
    row.classList.toggle('is-inert', !currentVsSettings.all.marginEnabled || currentVsSettings.all.marginTrigger !== 'score');
    return row;
}

// 決まった値の並び（steps）から選ぶスライダーの行（つまみは並びの番号）。値が並びに無いときは fallback の位置。
// 返す行の refresh() で、外から値を変えたときに表示をそろえる
function _buildStepSliderRow(label, sub, steps, fmt, get, set, fallback, wide) {
    const idxOf = (v) => {
        const i = steps.indexOf(v);
        if (i !== -1) return i;
        const j = steps.indexOf(fallback);
        return j !== -1 ? j : 0;
    };
    const ctrl = document.createElement('div');
    ctrl.className = 'vs-setting-control';

    const valLabel = document.createElement('span');
    valLabel.className = 'vs-setting-value-label';

    const slider = document.createElement('input');
    slider.type  = 'range';
    slider.min   = '0';
    slider.max   = String(steps.length - 1);
    slider.step  = '1';
    slider.className = 'vs-setting-slider' + (wide ? ' vs-setting-slider--wide' : '');

    const refresh = () => {
        const i = idxOf(get());
        slider.value = String(i);
        valLabel.textContent = fmt(steps[i]);
    };
    slider.oninput = () => {
        const val = steps[parseInt(slider.value)];
        set(val);
        valLabel.textContent = fmt(val);
        saveVsSettings();
        if (row.onStepChange) row.onStepChange(val);
    };
    refresh();

    ctrl.appendChild(valLabel);
    ctrl.appendChild(slider);
    ctrl.appendChild(_buildSliderMarkers(steps.map((v, i) => ({ pos: i, label: fmt(v) })), 0, steps.length - 1, wide));

    const row = _buildRow(label, sub, ctrl);
    row.refresh = refresh;
    return row;
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
    row.classList.toggle('is-inert', !currentVsSettings.all.marginEnabled
        || (vsSettingsProfile === 'zone' && currentVsSettings.all.marginTrigger === 'score'));
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
// 0〜100%（10 刻み）のスライダーの行。get / set で読み書きする値を決める（ZONE BATTLE のフェーズごとの値でも使う）
function _buildPctSliderRow(label, sub, get, set) {
    const current = get();

    const ctrl = document.createElement('div');
    ctrl.className = 'vs-setting-control';

    const valLabel = document.createElement('span');
    valLabel.className = 'vs-setting-value-label';
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
        set(val);
        valLabel.textContent = `${val}%`;
        saveVsSettings();
    };

    ctrl.appendChild(valLabel);
    ctrl.appendChild(slider);

    ctrl.appendChild(_buildSliderMarkers([0, 50, 100].map(v => ({ pos: v, label: String(v) })), 0, 100));

    return _buildRow(label, sub, ctrl);
}

// 通常 VERSUS の HOLE RATE（同じ着弾の中で同じ穴の確率）
function _buildGarbageHoleRateRow() {
    return _buildPctSliderRow('HOLE RATE', '',
        () => currentVsSettings.tet.garbageHoleRate,
        (v) => { currentVsSettings.tet.garbageHoleRate = v; });
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
            _syncZonePhaseGroup();
        };
        btnGroup.appendChild(btn);
    });

    ctrl.appendChild(btnGroup);
    return _buildRow('PHASE', '', ctrl);
}

// PHASE TRIGGER のしきい値。SCORE はフェーズごとの TRIGGER SCORE（PHASE タブの 02・03）、
// TIME は画面で選ばせない（game/tet/zone.js の ZONE_PHASE_TIMES_MS）
function _phaseScores() {
    return currentVsSettings.tet.phaseTable.slice(1).map(r => r.score);
}
function _phaseTriggerSub() {
    return currentVsSettings.tet.phaseTrigger === 'time'
        ? '(' + ZONE_PHASE_TIMES_MS.map(v => `${v / 1000}s`).join(' / ') + ')'
        : '(' + _phaseScores().map(v => v.toLocaleString('en-US')).join(' / ') + ')';
}
function _formatPhaseScore(v) {
    return `${v / 1000}K`;
}

// ── PHASE TRIGGER（SCORE = 両者のスコアの最大値 / TIME = 試合の時計） ──
function _buildZonePhaseTriggerRow() {
    const row = _buildChoiceRow('PHASE TRIGGER', _phaseTriggerSub(),
        [{ label: 'SCORE', value: 'score' }, { label: 'TIME', value: 'time' }],
        () => (currentVsSettings.tet.phaseTrigger === 'time' ? 'time' : 'score'),
        (v) => { currentVsSettings.tet.phaseTrigger = v; },
        'vss-row-phaseTrigger',
        () => {
            const sub = document.querySelector('#vss-row-phaseTrigger .vs-setting-sublabel');
            if (sub) sub.textContent = _phaseTriggerSub();
            _syncZonePhaseGroup();
        });
    row.classList.toggle('is-inert', currentVsSettings.tet.phase === false);
    return row;
}

// ── フェーズごとの値（PHASE タブの枠。設計 §14） ──
// PHASE ON: 枠の頭の 01 / 02 / 03 の切替（カルーセル）で、そのフェーズの HOLE RATE ×2・ZONE TIME・ZONE CHARGE を出す。
// PHASE OFF: 切替を隠し、試合を通して使う値（FIXED）の 4 行を出す。
// 4 行の組は 01〜03・FIXED の 4 つを最初に全部作り、表示だけ切り替える（キー操作のフォーカスが切替の行から外れないように）
let vsPhaseEdit = 1; // いま開いているフェーズ（保存しない）

// 4 行の組（HOLE RATE in / between・ZONE TIME・ZONE CHARGE）。obj はその値を持つオブジェクト、keys はキーの名前
function _buildZoneValueRows(obj, keys) {
    return [
        _buildPctSliderRow('HOLE RATE', '(in chunk)', () => obj()[keys.holeIn], (v) => { obj()[keys.holeIn] = v; }),
        _buildPctSliderRow('HOLE RATE', '(between)', () => obj()[keys.holeBetween], (v) => { obj()[keys.holeBetween] = v; }),
        _buildChoiceRow('ZONE TIME', '(sec / 25%)',
            VS_ZONE_TIME_OPTIONS.map(v => ({ label: (v / 1000) + 's', value: v })),
            () => obj()[keys.time], (v) => { obj()[keys.time] = v; }),
        _buildChoiceRow('ZONE CHARGE', '(lines / 25%)',
            VS_ZONE_CHARGE_OPTIONS.map(v => ({ label: String(v), value: v })),
            () => obj()[keys.charge], (v) => { obj()[keys.charge] = v; }),
    ];
}

// フェーズに進む条件（切替の行のサブラベル）
function _phaseStartSub(p) {
    if (p <= 1) return '(start)';
    return currentVsSettings.tet.phaseTrigger === 'time'
        ? `(${ZONE_PHASE_TIMES_MS[p - 2] / 1000}s~)`
        : `(${currentVsSettings.tet.phaseTable[p - 1].score.toLocaleString('en-US')}~)`;
}

function _buildZonePhaseValuesGroup() {
    const group = document.createElement('div');
    group.className = 'vs-setting-group';
    group.id = 'vss-phase-group';

    const head = document.createElement('div');
    head.className = 'vs-setting-group-head';
    const title = document.createElement('p');
    title.className = 'vs-setting-group-label';
    title.id = 'vss-phase-group-label';
    const note = document.createElement('p');
    note.className = 'vs-setting-group-note';
    note.id = 'vss-phase-group-note';
    head.appendChild(title);
    head.appendChild(note);
    group.appendChild(head);

    // 01 / 02 / 03 の切替（←/→ でも切り替わる。行として FocusNav に載る）
    const sel = _buildChoiceRow('PHASE', _phaseStartSub(vsPhaseEdit),
        [1, 2, 3].map(p => ({ label: String(p).padStart(2, '0'), value: p })),
        () => vsPhaseEdit, (v) => { vsPhaseEdit = v; },
        'vss-row-phaseSelect', _syncZonePhaseGroup);
    sel.classList.add('vs-setting-phase-select');
    group.appendChild(sel);

    const table = () => currentVsSettings.tet.phaseTable;
    const phaseKeys = { holeIn: 'holeRate', holeBetween: 'holeChunk', time: 'zoneTime', charge: 'zoneCharge' };
    const scoreRows = {};
    [1, 2, 3].forEach(p => {
        const set = document.createElement('div');
        set.className = 'vs-setting-group-set';
        set.dataset.set = String(p);
        // 02・03: このフェーズへ進むスコア（PHASE TRIGGER: SCORE のとき。TIME の間は減光）。
        // 前後のフェーズと逆にならないよう、02 を 03 より上げたら 03 も、03 を 02 より下げたら 02 もそろえる
        if (p >= 2) {
            const row = _buildStepSliderRow('TRIGGER SCORE', '(max of both)', PHASE_SCORE_STEPS, _formatPhaseScore,
                () => table()[p - 1].score,
                (v) => {
                    const t = table();
                    t[p - 1].score = v;
                    for (let i = p; i < t.length; i++) if (t[i].score < v) t[i].score = v;
                    for (let i = p - 2; i >= 1; i--) if (t[i].score > v) t[i].score = v;
                },
                _vsDefaults().tet.phaseTable[p - 1].score, true);
            row.classList.add('vs-setting-phase-score');
            row.onStepChange = () => {
                Object.keys(scoreRows).forEach(k => { if (+k !== p) scoreRows[k].refresh(); });
                _syncZonePhaseGroup();
            };
            scoreRows[p] = row;
            set.appendChild(row);
        }
        _buildZoneValueRows(() => table()[p - 1], phaseKeys).forEach(r => set.appendChild(r));
        group.appendChild(set);
    });
    const fixed = document.createElement('div');
    fixed.className = 'vs-setting-group-set';
    fixed.dataset.set = 'fixed';
    _buildZoneValueRows(() => currentVsSettings.tet,
        { holeIn: 'garbageHoleRate', holeBetween: 'garbageHoleChunk', time: 'zoneTime', charge: 'zoneCharge' })
        .forEach(r => fixed.appendChild(r));
    group.appendChild(fixed);

    // 描いた直後に表示をそろえる（まだ DOM に入っていないので要素を直接渡す）
    _syncZonePhaseGroup(group);
    return group;
}

// PHASE の ON/OFF・切替に合わせて、PHASE TRIGGER の減光と枠の中の表示をそろえる
function _syncZonePhaseGroup(groupEl) {
    const on = currentVsSettings.tet.phase !== false;
    const trig = document.getElementById('vss-row-phaseTrigger');
    if (trig) {
        trig.classList.toggle('is-inert', !on);
        const tsub = trig.querySelector('.vs-setting-sublabel');
        if (tsub) tsub.textContent = _phaseTriggerSub();
    }
    const group = (groupEl instanceof Element) ? groupEl : document.getElementById('vss-phase-group');
    if (!group) return;
    // TRIGGER SCORE は PHASE TRIGGER: TIME の間は使わないので減光
    const byTime = currentVsSettings.tet.phaseTrigger === 'time';
    group.querySelectorAll('.vs-setting-phase-score').forEach(r => r.classList.toggle('is-inert', byTime));
    const show = on ? String(vsPhaseEdit) : 'fixed';
    group.querySelectorAll('.vs-setting-group-set').forEach(set => {
        const visible = set.dataset.set === show;
        if (visible && set.style.display === 'none') {
            // 切り替えたときだけ軽く出す（タブと同じ動き）
            set.classList.remove('is-entering'); void set.offsetWidth; set.classList.add('is-entering');
        }
        set.style.display = visible ? '' : 'none';
    });
    const sel = group.querySelector('#vss-row-phaseSelect');
    if (sel) {
        sel.style.display = on ? '' : 'none';
        const sub = sel.querySelector('.vs-setting-sublabel');
        if (sub) sub.textContent = _phaseStartSub(vsPhaseEdit);
    }
    const label = group.querySelector('#vss-phase-group-label');
    if (label) label.textContent = on ? 'PER PHASE' : 'FIXED';
    const note = group.querySelector('#vss-phase-group-note');
    if (note) note.textContent = on
        ? 'フェーズごとに、おじゃまの穴の変わり方と ZONE の長さ・たまり方を決める'
        : 'PHASE OFF の試合で通して使う値';
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
    } else if (s.all.marginTrigger === 'score') {
        parts.push(`MARGIN:SCORE ${_formatMarginScore(s.all.marginScore)}`);
    } else if (mt !== D.all.marginTime) {
        parts.push(`MARGIN:${_formatMarginTime(mt)}`);
    }

    const bp = s.all.attackBias.player;
    const bc = s.all.attackBias.cpu;
    if (bp !== 0) parts.push(`P-BIAS:${bp > 0 ? '+' : ''}${bp}`);
    if (bc !== 0) parts.push(`C-BIAS:${bc > 0 ? '+' : ''}${bc}`);

    if (!s.tet.holdEnabled) parts.push('HOLD:OFF');
    // ZONE BATTLE の PHASE ON の間は穴の 2 行を使わないので出さない
    const holeUsed = D.tet.garbageHoleChunk === undefined || s.tet.phase === false;
    if (holeUsed && s.tet.garbageHoleRate !== D.tet.garbageHoleRate) {
        parts.push(`HOLE:${s.tet.garbageHoleRate}%`);
    }
    if (holeUsed && D.tet.garbageHoleChunk !== undefined && s.tet.garbageHoleChunk !== D.tet.garbageHoleChunk) {
        parts.push(`HOLE-BETWEEN:${s.tet.garbageHoleChunk}%`);
    }
    // 既定と違うときだけ（ZONE BATTLE は既定が OFF のことがある）
    if (s.tet.garbageDamageOnClear !== D.tet.garbageDamageOnClear) {
        parts.push(`DMG-ON-CLR:${s.tet.garbageDamageOnClear ? 'ON' : 'OFF'}`);
    }
    // ZONE BATTLE: ZONE TIME / CHARGE / ATTACK は既定と違うものだけ
    // PHASE OFF のときだけ PHASE:OFF と ZONE TIME / CHARGE（ON の間は使わないので出さない）
    if (D.tet.zoneTime !== undefined) {
        if (s.tet.phase !== false && s.tet.phaseTrigger === 'time') parts.push('PHASE:TIME');
        if (s.tet.phase === false) {
            parts.push('PHASE:OFF');
            parts.push(`ZONE TIME:${s.tet.zoneTime / 1000}s`);
            parts.push(`ZONE CHARGE:${s.tet.zoneCharge}`);
        }
        // PHASE ON: フェーズごとの値は既定（原作の表）と違うものだけ（例 P02 ZONE TIME:5s）
        if (s.tet.phase !== false && Array.isArray(s.tet.phaseTable) && Array.isArray(D.tet.phaseTable)) {
            s.tet.phaseTable.forEach((r, i) => {
                const d = D.tet.phaseTable[i] || {};
                const tag = 'P' + String(i + 1).padStart(2, '0');
                if (r.holeRate !== d.holeRate) parts.push(`${tag} HOLE:${r.holeRate}%`);
                if (r.holeChunk !== d.holeChunk) parts.push(`${tag} HOLE-BETWEEN:${r.holeChunk}%`);
                if (r.zoneTime !== d.zoneTime) parts.push(`${tag} ZONE TIME:${r.zoneTime / 1000}s`);
                if (r.zoneCharge !== d.zoneCharge) parts.push(`${tag} ZONE CHARGE:${r.zoneCharge}`);
                if (i > 0 && s.tet.phaseTrigger !== 'time' && r.score !== d.score) parts.push(`${tag} SCORE:${_formatPhaseScore(r.score)}`);
            });
        }
        if ((s.tet.zoneSplit !== false) !== (D.tet.zoneSplit !== false)) parts.push(`ZONE ATTACK:${s.tet.zoneSplit === false ? 'MERGE' : 'SPLIT'}`);
    }

    if (s.puyo) _pushPuyoSummary(parts, s, D);

    el.textContent = parts.join(' / ');
    el.style.color = vsSettingsProfile === 'zone' ? 'var(--zone-battle-color)' : 'var(--accent, #c471ed)';
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