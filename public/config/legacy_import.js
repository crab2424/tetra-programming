// ─────────────────────────────────────────────
// legacy_import.js — 旧URL（citgame.pptlabo.workers.dev）からの引き継ぎの受け取り側（v2.6.1）
//
// 旧URLのお知らせ画面（public/legacy.html）の「IMPORT & OPEN」が、このページを `/#legacy-import` で
// 新しいタブに開く。流れ:
//   1. ここ → 旧URL（window.opener）: { type: 'tetlabo-legacy-ready' }
//   2. 旧URL → ここ: { type: 'tetlabo-legacy-data', items: { <localStorage のキー>: <文字列> } }
//   3. 確認ダイアログ → YES なら取り込んで読み込み直す。結果を旧URLへ done / cancel / error で返す
// 送り元のオリジンと window.opener の両方を確かめる。KEYS に無いキーは受け取らない。
// 取り込み方（ロードマップ §0.2・2026-11-22 決定）:
//   設定 … 旧URLの値で置き換える
//   自己ベスト … 良い方を残す（Records.adopt。同期と同じ比べ方）
//   成績（STATS） … 足し合わせる（Stats.importLegacy）。同じ旧URLの端末からは 1 回だけ（二重に数えない）
// ─────────────────────────────────────────────
(function () {
    const HASH = '#legacy-import';
    if (location.hash !== HASH) return;
    // 読み込み直しやブックマークでもう一度動かないよう、すぐに # を消す
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* 消せなくても動く */ }

    // 送り元（旧URL）。手元の確認用に localhost で開いたときは 127.0.0.1 の同じポート（legacy.html と揃える）
    function legacyOrigin() {
        const h = location.hostname;
        if (h === 'tetlabo.com') return 'https://citgame.pptlabo.workers.dev';
        if (h === 'localhost') return 'http://127.0.0.1' + (location.port ? ':' + location.port : '');
        return null;
    }

    const SETTING_KEYS = [
        'game_tuning', 'game_display', 'game_binds', 'game_gamepad_options', 'game_keyconfig', 'game_gamepadconfig',
        'game_volume', 'game_vs_settings', 'game_vs_settings_zone', 'game_puyo_single_settings', 'game_zone_settings',
        'game_zone_view_scale', 'tetlabo.cpuLevel', 'tetlabo.assist', 'tetlaboPreferredRule', 'tetlaboServerUrl',
        'tetlaboUserName', 'tetlaboOnlineSelfSide', 'replay_mark_thresholds', 'replayUiHidden',
    ];
    const RECORDS_KEY = 'tetlabo_records';
    const STATS_KEY = 'tetlabo_stats';
    const HISTORY_KEY = 'tetlabo_stats_history';
    // 取り込み済みの旧URLの端末（Stats の deviceId）。同じ端末の成績をもう一度足さないため
    const DONE_KEY = 'tetlabo_legacy_import';
    const MAX_VALUE_LEN = 2 * 1024 * 1024;

    const from = legacyOrigin();
    const opener = window.opener;
    if (!from || !opener) return;

    let handled = false;

    function reply(type, extra) {
        try { opener.postMessage(Object.assign({ type, v: 1 }, extra || {}), from); } catch (e) { /* 旧URLのタブが閉じられた */ }
    }

    function loadDone() {
        try {
            const d = JSON.parse(localStorage.getItem(DONE_KEY) || 'null');
            return (d && Array.isArray(d.devices)) ? d : { devices: [] };
        } catch (e) { return { devices: [] }; }
    }

    function parseRecords(raw) {
        try {
            const d = JSON.parse(raw || 'null');
            return (d && typeof d === 'object' && d.records && typeof d.records === 'object') ? d.records : {};
        } catch (e) { return {}; }
    }

    function sanitize(items) {
        const out = {};
        if (!items || typeof items !== 'object') return out;
        for (const key of SETTING_KEYS.concat([RECORDS_KEY, STATS_KEY, HISTORY_KEY])) {
            const v = items[key];
            if (typeof v === 'string' && v.length <= MAX_VALUE_LEN) out[key] = v;
        }
        return out;
    }

    async function handle(items) {
        const Dialog = window.TetDialog;
        const settingKeys = SETTING_KEYS.filter((k) => k in items);
        const oldRecords = parseRecords(items[RECORDS_KEY]);
        const recordKeys = ((window.Records && window.Records.ALL_KEYS) || []).filter((k) => oldRecords[k]);
        const stats = (items[STATS_KEY] && window.Stats?.legacySize) ? window.Stats.legacySize(items[STATS_KEY]) : null;
        const done = loadDone();
        const statsAlready = !!(stats && stats.deviceId && done.devices.includes(stats.deviceId));
        const hasStats = !!(stats && (stats.plays > 0 || stats.solved > 0));

        if (settingKeys.length === 0 && recordKeys.length === 0 && !hasStats) {
            await Dialog.choose({
                title: 'IMPORT DATA',
                message: '旧アドレスには引き継ぐデータがありませんでした。',
                buttons: [{ label: 'OK', value: true, kind: 'primary', cancel: true }],
            });
            reply('tetlabo-legacy-done', { imported: false });
            return;
        }

        const parts = [];
        if (settingKeys.length > 0) parts.push('設定');
        if (recordKeys.length > 0) parts.push(`自己ベスト ${recordKeys.length} 件`);
        if (hasStats && !statsAlready) {
            const sub = [];
            if (stats.plays > 0) sub.push(`${stats.plays} 回・${Math.max(1, Math.round(stats.ms / 60000))} 分`);
            if (stats.solved > 0) sub.push(`解いたクイズ ${stats.solved} 問`);
            parts.push(`成績（${sub.join('・')}）`);
        }
        let message = `旧アドレス（citgame.pptlabo.workers.dev）の ${parts.join('・')} を引き継ぎますか？`
            + '\n設定は旧アドレスの内容に置き換わります。自己ベストは良い方を残し、成績は足し合わせます。';
        if (hasStats && statsAlready) message += '\n成績はこの旧アドレスから引き継ぎ済みなので、もう一度は足しません。';

        const ok = await Dialog.choose({
            title: 'IMPORT DATA',
            message,
            buttons: [
                { label: 'NO', value: false, kind: 'secondary', cancel: true },
                { label: 'YES', value: true, kind: 'primary' },
            ],
            initial: true,
        });
        if (!ok) {
            reply('tetlabo-legacy-cancel');
            return;
        }

        try {
            for (const key of settingKeys) localStorage.setItem(key, items[key]);
            let adopted = 0;
            for (const key of recordKeys) {
                const rec = oldRecords[key];
                if (rec && typeof rec === 'object' && window.Records.adopt(key, rec, rec.syncedTo)) adopted++;
            }
            if (hasStats && !statsAlready) {
                window.Stats.importLegacy(items[STATS_KEY], items[HISTORY_KEY]);
                if (stats.deviceId) {
                    done.devices.push(stats.deviceId);
                    done.at = new Date().toISOString();
                    localStorage.setItem(DONE_KEY, JSON.stringify(done));
                }
            }
            reply('tetlabo-legacy-done', { imported: true, settings: settingKeys.length, records: adopted });
        } catch (e) {
            console.error('[legacy-import]', e);
            reply('tetlabo-legacy-error', { message: '保存できませんでした（ブラウザの容量が足りない可能性があります）。' });
            await Dialog.choose({
                title: 'IMPORT DATA',
                message: '引き継ぎの途中で保存できませんでした。ブラウザの容量が足りない可能性があります。',
                buttons: [{ label: 'OK', value: true, kind: 'primary', cancel: true }],
            });
            return;
        }

        await Dialog.choose({
            title: 'IMPORT DATA',
            message: '引き継ぎました。設定を反映するため、画面を読み込み直します。',
            buttons: [{ label: 'OK', value: true, kind: 'primary', cancel: true }],
        });
        location.reload();
    }

    window.addEventListener('message', (e) => {
        if (handled || e.origin !== from || e.source !== opener) return;
        const d = e.data;
        if (!d || typeof d !== 'object' || d.type !== 'tetlabo-legacy-data' || d.v !== 1) return;
        handled = true;
        handle(sanitize(d.items)).catch((err) => {
            console.error('[legacy-import]', err);
            reply('tetlabo-legacy-error', { message: '' });
        });
    });

    // 画面（TetDialog・Records・Stats）が揃ってから「準備できた」を返す
    function ready() { reply('tetlabo-legacy-ready'); }
    if (document.readyState === 'complete') setTimeout(ready, 0);
    else window.addEventListener('load', ready, { once: true });
})();
