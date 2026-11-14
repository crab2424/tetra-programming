// ─────────────────────────────────────────────
// cloud_sync.js — 設定と自己ベストを Discord アカウントで端末間共有する
//
// サーバー側: worker/sync.ts（GET/PUT /api/sync）
//
// 共有するもの
//   設定 … SETTINGS のうち端末差の小さいもの
//     tuning  = game_tuning（DAS/ARR/DCD・IRS/IHS など）
//     display = game_display（APM 表示・ゴーストの描き方など）
//     binds   = game_binds（キー・パッド割当）
//     gamepad = game_gamepad_options（デッドゾーン）
//   記録 … 全モードの自己ベスト（tetlabo_records のうち、このアカウントのものと決まった記録）
// 共有しないもの … 音量（game_volume）・Backend URL。端末ごとの都合で変えるものなので各端末に残す。
//
// 決め方
//   設定は区分ごとに「新しい方が勝つ」。端末は区分ごとに「最後にサーバーと揃えたときの中身と rev」を
//   覚えておき、今の中身がそれと違えば「この端末で変えた」とみなして送る。サーバーの rev が進んで
//   いて端末で変えていなければ取り込む。両方変わっていたら変更時刻の新しい方（判定はサーバー）。
//   この端末でこのアカウントと初めて揃えるときに中身が食い違っていたら、1 回だけどちらを使うか聞く。
//   記録はモードごとに良い方を残す（どちらかを捨てない）。
// ─────────────────────────────────────────────

(function () {
    const META_KEY = 'tetlabo_sync_meta';
    const SETTING_SECTIONS = {
        tuning: 'game_tuning',
        display: 'game_display',
        binds: 'game_binds',
        gamepad: 'game_gamepad_options',
    };
    const TOUCH_DELAY_MS = 1500;

    let running = null;      // 実行中の sync() の Promise
    let again = false;       // 実行中に touch() が来た → 終わったらもう 1 回
    let touchTimer = null;
    let askedThisSession = false; // 初回の確認ダイアログを閉じて保留にした → この起動中はもう聞かない
    let interactive = false; // 確認ダイアログを出してよい回か（起動時・ログイン直後だけ。プレイ中の保存では出さない）

    function _me() {
        return (window.Account && window.Account.me) || null;
    }

    // ─── 端末側の覚え書き ─────────────────────────────────
    // { uid, sections: { <name>: { rev, synced: <揃えたときの JSON 文字列>,
    //                             pending?: <送る前の変更後の JSON 文字列>, changedAt?: <それを変えた時刻> } } }
    function _loadMeta(uid) {
        try {
            const meta = JSON.parse(localStorage.getItem(META_KEY) || 'null');
            if (meta && meta.uid === uid && meta.sections && typeof meta.sections === 'object') return meta;
        } catch (e) { /* 壊れていたら作り直す */ }
        return { uid, sections: {} };
    }

    function _saveMeta(meta) {
        try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) { /* 次回また揃え直すだけ */ }
    }

    // localStorage の値を比較用にそろえた JSON 文字列で返す（無い・壊れている・オブジェクトでない → null）
    function _localString(storageKey) {
        try {
            const raw = localStorage.getItem(storageKey);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
            return JSON.stringify(parsed);
        } catch (e) {
            return null;
        }
    }

    // ─── 通信 ─────────────────────────────────────────────
    async function _get() {
        const res = await fetch('/api/sync', { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error('sync_get_' + res.status);
        const data = await res.json();
        return (data && data.sections) || {};
    }

    async function _put(sections) {
        const res = await fetch('/api/sync', {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sections }),
        });
        if (!res.ok) throw new Error('sync_put_' + res.status);
        const data = await res.json();
        return (data && data.sections) || {};
    }

    // ─── 設定 ─────────────────────────────────────────────
    // SETTINGS で保存していない変更があるあいだは取り込まない（取り込むと編集中の値が消える）
    // 画面を開いていないときは編集中の値が無いので、いつでも取り込んでよい（古い形式の保存値は
    // 画面を開いていなくても「未保存」に見えることがあるので、開いているかどうかも見る）。
    function _settingsBusy() {
        try {
            const page = document.getElementById('settings-page');
            if (!page || !page.classList.contains('active')) return false;
            return typeof isSettingsDirty === 'function' && isSettingsDirty();
        } catch (e) { return false; }
    }

    async function _syncSettings(meta, server) {
        const push = {};      // name -> { data, baseRev, changedAt }
        const pull = [];      // name
        const firstDiff = []; // 初めて揃える区分のうち、端末とアカウントで中身が違うもの

        for (const [name, storageKey] of Object.entries(SETTING_SECTIONS)) {
            const local = _localString(storageKey);
            const m = meta.sections[name];
            const sv = server[name] && server[name].data ? server[name] : null;
            const serverStr = sv ? JSON.stringify(sv.data) : null;

            if (!m) {
                // この端末でこのアカウントと初めて揃える
                if (!sv) {
                    if (local !== null) push[name] = { data: JSON.parse(local), baseRev: 0, changedAt: Date.now() };
                } else if (local === null) {
                    pull.push(name);
                } else if (local === serverStr) {
                    meta.sections[name] = { rev: sv.rev, synced: local };
                } else {
                    firstDiff.push(name);
                }
                continue;
            }

            const dirty = local !== null && local !== m.synced;
            if (dirty) {
                const changedAt = m.pending === local && m.changedAt ? m.changedAt : Date.now();
                push[name] = { data: JSON.parse(local), baseRev: m.rev, changedAt };
            } else if (sv && sv.rev !== m.rev) {
                if (serverStr === local) meta.sections[name] = { rev: sv.rev, synced: local };
                else pull.push(name);
            }
        }

        if (firstDiff.length > 0) {
            const choice = await _askFirst();
            if (choice === 'account') {
                pull.push(...firstDiff);
            } else if (choice === 'device') {
                for (const name of firstDiff) {
                    push[name] = {
                        data: JSON.parse(_localString(SETTING_SECTIONS[name])),
                        baseRev: server[name].rev,
                        changedAt: Date.now(),
                    };
                }
            }
            // 閉じただけ → 何もしない（次の起動でもう一度聞く）
        }

        if (Object.keys(push).length > 0) {
            const result = await _put(push);
            for (const name of Object.keys(push)) {
                const r = result[name];
                if (!r) continue;
                if (r.accepted) {
                    meta.sections[name] = { rev: r.rev, synced: JSON.stringify(push[name].data) };
                } else if (r.data) {
                    // アカウント側の方が新しかった → そちらを取り込む
                    server[name] = r;
                    pull.push(name);
                }
            }
        }

        let applied = false;
        if (pull.length > 0 && !_settingsBusy()) {
            for (const name of pull) {
                const sv = server[name];
                if (!sv || !sv.data) continue;
                const text = JSON.stringify(sv.data);
                try { localStorage.setItem(SETTING_SECTIONS[name], text); } catch (e) { continue; }
                meta.sections[name] = { rev: sv.rev, synced: text };
                applied = true;
            }
        }
        _saveMeta(meta);
        // 保存値を画面とゲームへ反映する（config/settings.js）
        if (applied && typeof applySyncedSettings === 'function') applySyncedSettings();
        return applied;
    }

    async function _askFirst() {
        if (!interactive || askedThisSession || !window.TetDialog) return null;
        const choice = await window.TetDialog.choose({
            title: 'SETTINGS SYNC',
            message: 'アカウントに保存されている設定が、この端末の設定と違います。どちらを使いますか？\n（音量と Backend URL は端末ごとのままです）',
            buttons: [
                { label: 'THIS DEVICE', value: 'device', kind: 'secondary' },
                { label: 'ACCOUNT', value: 'account', kind: 'primary' },
            ],
            initial: 'account',
        });
        if (choice !== 'device' && choice !== 'account') { askedThisSession = true; return null; }
        return choice;
    }

    // ─── 記録 ─────────────────────────────────────────────
    function _stripRecord(record) {
        const { meta, syncedTo, ...rest } = record;
        return rest;
    }

    async function _syncRecords(meta, server, uid) {
        const Records = window.Records;
        if (!Records) return false;
        let sv = server.records && server.records.data ? server.records : null;
        let adopted = false;

        for (let attempt = 0; attempt < 3; attempt++) {
            const remote = (sv && sv.data) || {};

            // アカウント → 端末: 端末の記録より良いものだけ取り込む
            for (const key of Records.ALL_KEYS) {
                if (remote[key] && Records.adopt(key, remote[key], uid)) adopted = true;
            }

            // 端末 → アカウント: このアカウントのものと決まった記録で、アカウント側より良いもの
            const merged = Object.assign({}, remote);
            let changed = false;
            for (const key of Records.ALL_KEYS) {
                const local = Records.get(key);
                if (!local || local.syncedTo !== uid) continue;
                if (remote[key] && remote[key].id === local.id) continue;
                if (!Records.isBetter(key, local, remote[key] || null)) continue;
                merged[key] = _stripRecord(local);
                changed = true;
            }
            if (!changed) {
                meta.sections.records = { rev: sv ? sv.rev : 0 };
                break;
            }

            const result = await _put({ records: { data: merged, baseRev: sv ? sv.rev : 0, changedAt: Date.now() } });
            const r = result.records;
            if (!r) break;
            if (r.accepted) {
                meta.sections.records = { rev: r.rev };
                break;
            }
            // 別の端末が先に書いていた → その中身と合成し直す
            sv = r.data ? r : null;
        }
        _saveMeta(meta);
        return adopted;
    }

    // ─── 入口 ─────────────────────────────────────────────
    async function _syncOnce() {
        const me = _me();
        if (!me) return;
        const meta = _loadMeta(me.id);
        const server = await _get();
        if (!_me() || _me().id !== me.id) return; // 待っている間にログアウト・切替された
        const settingsApplied = await _syncSettings(meta, server);
        const recordsAdopted = await _syncRecords(meta, server, me.id);
        if (settingsApplied) window.showSyncToast?.('アカウントの設定を読み込みました');
        if (settingsApplied || recordsAdopted) {
            try { window.dispatchEvent(new CustomEvent('tetlabo:cloudsync', { detail: { settingsApplied, recordsAdopted } })); }
            catch (e) { /* 通知できなくても同期自体は済んでいる */ }
        }
    }

    // 今すぐ揃える。実行中なら、その回が終わってからもう 1 回だけ走らせる。
    // opts.interactive: 初めて揃える端末で中身が食い違っていたら、どちらを使うか聞いてよい
    function sync(opts) {
        if (opts && opts.interactive) interactive = true;
        if (running) { again = true; return running; }
        running = (async () => {
            try {
                do {
                    again = false;
                    await _syncOnce();
                } while (again);
            } catch (e) {
                // 通信失敗など。端末の値はそのままなので、次の touch()/起動でやり直される
                console.warn('[CloudSync]', e && e.message ? e.message : e);
            } finally {
                running = null;
                interactive = false;
            }
        })();
        return running;
    }

    // 設定・記録を保存した所から呼ぶ。変えた時刻を控え、少し待ってからまとめて送る。
    function touch() {
        const me = _me();
        if (!me) return;
        const meta = _loadMeta(me.id);
        let stamped = false;
        for (const [name, storageKey] of Object.entries(SETTING_SECTIONS)) {
            const m = meta.sections[name];
            if (!m) continue;
            const local = _localString(storageKey);
            // 前回控えたときから中身が動いた区分だけ時刻を更新する（他の区分の保存で時刻が進まないように）
            if (local !== m.synced && local !== m.pending) { m.pending = local; m.changedAt = Date.now(); stamped = true; }
        }
        if (stamped) _saveMeta(meta);
        clearTimeout(touchTimer);
        touchTimer = setTimeout(() => { sync(); }, TOUCH_DELAY_MS);
    }

    window.CloudSync = { sync, touch };
})();
