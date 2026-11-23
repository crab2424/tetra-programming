// ─────────────────────────────────────────────
// cloud_sync.js — 設定と自己ベストを Discord アカウントで端末間共有する
//
// サーバー側: worker/sync.ts（GET/PUT /api/sync）
//
// 共有するもの
//   設定 … SETTINGS のうち端末差の小さいもの
//     presets = tetlabo_presets（設定のプリセット 3 つ分の名前と中身。config/settings.js）
//               中身は操作系（DAS/ARR/DCD・IRS/IHS・キー/パッド割当・デッドゾーン）と DISPLAY。
//               どのプリセットを使っているか（tetlabo_preset_active）は端末ごとで送らない。
//     vs_presets = tetlabo_vs_presets（VS 設定のプリセット。通常 VERSUS・ZONE BATTLE 3 つずつ。config/vs_settings.js）
//               どれを使っているか（tetlabo_vs_preset_active）は端末ごと。v2.6.2 で追加（worker/sync.ts と同時デプロイ）
//     以前の区分（プリセット導入前。アカウントにまだ presets が無いときだけ、取り込みのために見る）
//       tuning  = game_tuning / display = game_display / binds = game_binds / gamepad = game_gamepad_options
//   記録 … 全モードの自己ベスト（tetlabo_records のうち、このアカウントのものと決まった記録）
//   成績 … プレイ記録（STATS。config/stats.js）。端末ごとの欄を持ち寄って足す（履歴は送らない）
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
        presets: 'tetlabo_presets',
        vs_presets: 'tetlabo_vs_presets',
        tuning: 'game_tuning',
        display: 'game_display',
        binds: 'game_binds',
        gamepad: 'game_gamepad_options',
    };
    // プリセット導入前の区分。アカウントに presets がまだ無いときだけ揃える（取り込んだ値はプリセットへ写る）
    const LEGACY_SECTIONS = ['tuning', 'display', 'binds', 'gamepad'];
    const TOUCH_DELAY_MS = 1500;

    let running = null;      // 実行中の sync() の Promise
    let again = false;       // 実行中に touch() が来た → 終わったらもう 1 回
    let touchTimer = null;
    let askedThisSession = false; // 初回の確認ダイアログを閉じて保留にした → この起動中はもう聞かない
    let interactive = false; // 確認ダイアログを出してよい回か（起動時・ログイン直後だけ。プレイ中の保存では出さない）
    let firstChoice = null;  // この回の「どちらを使うか」の答え（presets と vs_presets で 2 回聞かない）
    let lastStatsSyncAt = 0; // 成績を最後にサーバーと揃えた時刻（STATS を開いたときの取り直しの間引き）
    const STATS_REFRESH_MS = 30000;

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
    // vs_presets は VS SETTINGS の未保存の変更を見る
    function _settingsBusy(names) {
        try {
            const vs = Array.isArray(names) && names.includes('vs_presets');
            const page = document.getElementById(vs ? 'vs-settings-page' : 'settings-page');
            if (!page || !page.classList.contains('active')) return false;
            if (vs) return typeof isVsSettingsDirty === 'function' && isVsSettingsDirty();
            return typeof isSettingsDirty === 'function' && isSettingsDirty();
        } catch (e) { return false; }
    }

    // 設定: アカウントにプリセットがまだ無ければ、先に以前の区分を揃えて（取り込んだ値は今のプリセットへ写る）から
    // プリセットを送る。プリセットがあればプリセットだけ。
    async function _syncSettings(meta, server) {
        let applied = false;
        if (!(server.presets && server.presets.data)) {
            const legacy = await _syncSettingSections(meta, server, LEGACY_SECTIONS);
            applied = legacy.applied;
            // どちらを使うか聞いて閉じられた → プリセットも送らない（次の起動でもう一度聞く）
            if (legacy.undecided) return applied;
        }
        const r = await _syncSettingSections(meta, server, ['presets']);
        applied = applied || r.applied;
        // VS 設定のプリセット（v2.6.2）。サーバーがまだ vs_presets を知らない（worker/sync.ts が古い）と
        // PUT が invalid_section で断られるので、ほかの区分（記録・成績）を止めないよう別に受ける
        try {
            const v = await _syncSettingSections(meta, server, ['vs_presets']);
            applied = applied || v.applied;
        } catch (e) {
            console.warn('[CloudSync] vs_presets', e && e.message ? e.message : e);
        }
        return applied;
    }

    async function _syncSettingSections(meta, server, names) {
        const push = {};      // name -> { data, baseRev, changedAt }
        const pull = [];      // name
        const firstDiff = []; // 初めて揃える区分のうち、端末とアカウントで中身が違うもの
        let undecided = false;

        for (const name of names) {
            const storageKey = SETTING_SECTIONS[name];
            const local = _localString(storageKey);
            let m = meta.sections[name];
            const sv = server[name] && server[name].data ? server[name] : null;
            const serverStr = sv ? JSON.stringify(sv.data) : null;

            // 覚え書きが今のサーバーと合わない（サーバーに無い・rev が戻った・同じ rev なのに中身が違う）
            // → 別の DB（つなぎ先を変えた localhost など）や消したアカウントと揃えたときのもの。
            // そのままだと「揃っている」と見なして取り込みも送信もしないので、初めて揃える扱いに戻す
            if (m && (!sv || sv.rev < m.rev || (sv.rev === m.rev && serverStr !== m.synced))) {
                delete meta.sections[name];
                m = undefined;
            }

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
            else undecided = true;
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

        const pulled = [];
        if (pull.length > 0 && !_settingsBusy(names)) {
            for (const name of pull) {
                const sv = server[name];
                if (!sv || !sv.data) continue;
                const text = JSON.stringify(sv.data);
                try { localStorage.setItem(SETTING_SECTIONS[name], text); } catch (e) { continue; }
                meta.sections[name] = { rev: sv.rev, synced: text };
                pulled.push(name);
            }
        }
        _saveMeta(meta);
        // 保存値を画面とゲームへ反映する（config/settings.js。presets なら使っているプリセットを今の設定へ）
        // vs_presets は config/vs_settings.js へ
        const rest = pulled.filter((n) => n !== 'vs_presets');
        if (rest.length > 0 && typeof applySyncedSettings === 'function') applySyncedSettings(rest);
        if (pulled.includes('vs_presets') && typeof applySyncedVsPresets === 'function') applySyncedVsPresets();
        return { applied: pulled.length > 0, undecided };
    }

    async function _askFirst() {
        if (firstChoice) return firstChoice;
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
        firstChoice = choice;
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

    // ─── 成績（STATS） ─────────────────────────────────────
    // 端末は自分の欄だけを書く（中身の組み立ては Stats.prepareSync）。rev が違えば断られるので、
    // 返ってきた今の中身で作り直して送り直す（records と同じ 3 回まで）。
    // @returns {boolean} 表示する数字（他の端末の分）が変わったか
    async function _syncStats(meta, server, uid) {
        const Stats = window.Stats;
        if (!Stats || typeof Stats.prepareSync !== 'function') return false;
        let sv = server.stats && server.stats.data ? server.stats : null;
        const before = JSON.stringify(Stats.getBuckets());

        for (let attempt = 0; attempt < 3; attempt++) {
            const plan = Stats.prepareSync(uid, sv ? sv.data : null);
            if (!plan.changed) {
                Stats.commitSync(uid, plan.doc, null, plan.dev);
                meta.sections.stats = { rev: sv ? sv.rev : 0 };
                break;
            }
            const result = await _put({ stats: { data: plan.doc, baseRev: sv ? sv.rev : 0, changedAt: Date.now() } });
            const r = result.stats;
            if (!r) break;
            if (r.accepted) {
                Stats.commitSync(uid, plan.doc, plan.sent, plan.dev);
                meta.sections.stats = { rev: r.rev };
                break;
            }
            // 別の端末が先に書いていた → その中身で作り直す
            sv = r.data ? r : null;
        }
        _saveMeta(meta);
        lastStatsSyncAt = Date.now();
        return JSON.stringify(Stats.getBuckets()) !== before;
    }

    // ─── 入口 ─────────────────────────────────────────────
    async function _syncOnce() {
        const me = _me();
        if (!me) return;
        const meta = _loadMeta(me.id);
        const server = await _get();
        if (!_me() || _me().id !== me.id) return; // 待っている間にログアウト・切替された
        firstChoice = null;
        const settingsApplied = await _syncSettings(meta, server);
        const recordsAdopted = await _syncRecords(meta, server, me.id);
        const statsChanged = await _syncStats(meta, server, me.id);
        if (settingsApplied) window.showSyncToast?.('アカウントの設定を読み込みました');
        if (settingsApplied || recordsAdopted || statsChanged) {
            try { window.dispatchEvent(new CustomEvent('tetlabo:cloudsync', { detail: { settingsApplied, recordsAdopted, statsChanged } })); }
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

    // 成績（STATS）を送る機会（メインメニューに戻ったとき・タブを隠したとき）。送っていない変化があるときだけ揃える
    // （1 試合ごとには送らない。設計 §6.7）
    function flushStats() {
        const me = _me();
        if (!me || !window.Stats || !window.Stats.hasUnpushed(me.id)) return null;
        return sync();
    }

    // STATS を開いたとき: 他の端末の分を取り直す（少し前に揃えたばかりなら何もしない）
    function refreshStats() {
        const me = _me();
        if (!me) return null;
        if (Date.now() - lastStatsSyncAt < STATS_REFRESH_MS && !(window.Stats && window.Stats.hasUnpushed(me.id))) return null;
        return sync();
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushStats();
    });

    window.CloudSync = { sync, touch, flushStats, refreshStats };
})();
