// ─────────────────────────────────────────────
// stats.js — プレイ記録（成績・STATS）の集計と保存（window.Stats）
//
// 設計: source_assets/memory/mode/record/stats/tetlabo-stats-design.md
// 自己ベスト（config/records.js）とは別物。こちらは「何回遊んだか・平均はどうか」の積み上げ。
//
// 保存先（localStorage）
//   tetlabo_stats         … 累計。{ v, deviceId, owners: { guest|<discordId>: { epoch, buckets, quiz } } }
//   tetlabo_stats_history … 直近の履歴（新しい順・最大 HISTORY_MAX 件・この端末だけ）
//
// 枠（bucket）のキーは records.js と同じ（marathon:150 / marathon:endless / sprint:40 / ultra / zone:150 …）。
// 値は「足す値」と「最大を残す値（MAX_FIELDS）」の 2 種類だけ。平均・率は保存せず、表示のときに割り算で出す
// （あとで端末ごとの値を足し合わせても狂わないように）。
//
//   n / q / ms       … 決着まで遊んだ回数 / 途中でやめた回数 / 遊んだ時間
//   cn / cq / cms    … 同じものの「準備画面の設定を変えた試合」ぶん（中身のカウンタには入れない。設計 §5）
//   sc               … スコアの合計（決着した試合だけ）
//   ok / okMs        … 完走した回数と、その合計時間
//   pc / ln          … 置いたミノの数 / 消したライン数
//   t4 / ts1〜ts3 / tsm / pcl … 4 ライン / T-Spin Single〜Triple / T-Spin Mini / パーフェクトクリア
//   zn / znLn        … ZONE の発動回数 / ZONE 中に消したライン
//   renMax / b2bMax / znMax（最大） … 最大 REN / 最大 Back-to-Back / ZONE 1 回の最大
//
// 入口（今はテトのシングルだけ。VERSUS・ONLINE・QUIZ・PUYO は後の段階で足す）
//   onTetInit(game) … game/tet/lifecycle.js の _initGameState の頭。前の試合が締まっていなければ
//                     「途中でやめた」で締め、数える対象ならこの試合を数え始める
//   end(game, r)    … 決着（r = 'ok' 完走 / 'ng' ゲームオーバー）
//   abort()         … 途中でやめた（app/navigation.js の stopAllGames）
// ─────────────────────────────────────────────

(function () {
    const STORE_KEY = 'tetlabo_stats';
    const HISTORY_KEY = 'tetlabo_stats_history';
    const VERSION = 1;
    const HISTORY_MAX = 100;

    const TET_SINGLE_MODES = ['marathon', 'sprint', 'ultra', 'zone'];
    // 表示の並び（STATS の SINGLE タブ）
    const SINGLE_KEYS = ['marathon:150', 'marathon:endless', 'sprint:40', 'ultra', 'zone:150'];
    // 合算のとき足さずに最大を取る値（今は端末内だけだが、同期の段階で使う）
    const MAX_FIELDS = ['renMax', 'b2bMax', 'znMax'];

    let current = null; // 数えている途中の試合 { game, rule }

    // ─── 保存 ─────────────────────────────────────────────
    function _newId() {
        const rnd = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
            ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
            : Math.random().toString(16).slice(2) + Date.now().toString(16);
        return 'd-' + rnd;
    }

    function _load() {
        let data = null;
        try { data = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { /* 壊れていたら作り直す */ }
        if (!data || typeof data !== 'object' || !data.owners || typeof data.owners !== 'object') {
            data = { v: VERSION, deviceId: _newId(), owners: {} };
        }
        if (!data.deviceId) data.deviceId = _newId();
        return data;
    }

    function _save(data) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) { /* 容量超過などは諦める（次の試合でまた書く） */ }
    }

    // 今の持ち主。ログイン中はそのアカウント、未ログインは端末の「ゲスト」（設計 §6.4）
    function ownerId() {
        const me = window.Account && window.Account.me;
        return (me && me.id) ? String(me.id) : 'guest';
    }

    function _ownerOf(data, id) {
        let o = data.owners[id];
        if (!o || typeof o !== 'object') o = data.owners[id] = { epoch: 0, buckets: {}, quiz: { cleared: {} } };
        if (!o.buckets || typeof o.buckets !== 'object') o.buckets = {};
        return o;
    }

    function _loadHistory() {
        try {
            const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
            return Array.isArray(list) ? list : [];
        } catch (e) { return []; }
    }

    function _pushHistory(entry) {
        const list = _loadHistory();
        list.unshift(entry);
        if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch (e) { /* 履歴は無くても累計は残る */ }
    }

    function _add(bucket, field, value) {
        if (!(value > 0)) return;
        bucket[field] = (bucket[field] || 0) + value;
    }

    function _max(bucket, field, value) {
        if (!(value > 0)) return;
        if (!(bucket[field] >= value)) bucket[field] = value;
    }

    // ─── テトのシングル ───────────────────────────────────
    function _tetSingleKey(game) {
        const mode = game.mode || game.currentMode;
        if (mode === 'marathon') return (game.goalLines === Infinity) ? 'marathon:endless' : 'marathon:150';
        if (mode === 'zone') return 'zone:150';
        if (mode === 'sprint') return 'sprint:40';
        if (mode === 'ultra') return 'ultra';
        return null;
    }

    // r: 'ok' 完走 / 'ng' ゲームオーバー / 'q' 途中でやめた
    function _closeTetSingle(game, r) {
        const ps = game.playStats;
        const key = _tetSingleKey(game);
        if (!ps || !key) return;
        // 1 手も置いていないやり直し・退出は何も数えない（SPRINT の開幕やり直しなど）
        if (r === 'q' && !(ps.pc > 0)) return;

        const ms = Math.max(0, Math.round((typeof game.getActiveMs === 'function') ? game.getActiveMs() : (game.elapsedTime || 0)));
        const custom = (game.mode === 'zone' && game.zoneRecordEligible === false);
        const score = Math.max(0, Math.floor(game.score || 0));
        const lines = Math.max(0, game.lines || 0);

        const data = _load();
        const bucket = (_ownerOf(data, ownerId()).buckets[key] ||= {});

        if (custom) {
            // 設定を変えた試合は回数と時間だけ（平均や完走率が混ざらないように）
            _add(bucket, r === 'q' ? 'cq' : 'cn', 1);
            _add(bucket, 'cms', ms);
        } else {
            _add(bucket, r === 'q' ? 'q' : 'n', 1);
            _add(bucket, 'ms', ms);
            _add(bucket, 'pc', ps.pc);
            _add(bucket, 'ln', lines);
            for (const f of ['t4', 'ts1', 'ts2', 'ts3', 'tsm', 'pcl']) _add(bucket, f, ps[f]);
            _max(bucket, 'renMax', ps.renMax);
            _max(bucket, 'b2bMax', ps.b2bMax);
            if (game.zoneEnabled) {
                _add(bucket, 'zn', game.zoneCount);
                _add(bucket, 'znLn', game.zoneLinesTotal);
                _max(bucket, 'znMax', game.zoneBest);
            }
            if (r !== 'q') _add(bucket, 'sc', score);
            if (r === 'ok') { _add(bucket, 'ok', 1); _add(bucket, 'okMs', ms); }
        }
        _save(data);

        const entry = { at: new Date().toISOString(), k: key, r, ms, sc: score, pc: ps.pc, ln: lines };
        if (custom) entry.c = 1;
        if (r !== 'q') {
            // 決着した試合のリプレイ（残っていれば STATS の履歴から辿れるようにする）
            const meta = window.ReplayManager?.metaForRecord?.(key);
            if (meta && meta.replayId) entry.rp = meta.replayId;
        }
        _pushHistory(entry);
    }

    // ─── 入口 ─────────────────────────────────────────────
    function _close(r) {
        const cur = current;
        current = null;
        if (!cur || !cur.game) return;
        if (cur.game._replay) return; // 念のため: 再生に使われている盤面は数えない
        try {
            if (cur.rule === 'tet') _closeTetSingle(cur.game, r);
        } catch (e) {
            console.error('[Stats]', e); // 成績が残らないだけで、試合の進行は止めない
        }
    }

    function onTetInit(game) {
        _close('q'); // 前の試合が締まっていなければ途中でやめた扱い（リスタートなど）
        if (!game || game._replay || game.isVersusMode || game.isCpuControlled) return;
        if (!TET_SINGLE_MODES.includes(game.currentMode)) return; // PRACTICE・QUIZ・CPU TEST は対象外
        current = { game, rule: 'tet' };
    }

    function end(game, r) {
        if (!current || current.game !== game) return;
        _close(r === 'ok' ? 'ok' : 'ng');
    }

    function abort() {
        _close('q');
    }

    // ─── 読み出し（app/stats_page.js） ────────────────────
    function getBuckets() {
        const data = _load();
        const o = data.owners[ownerId()];
        return (o && o.buckets) || {};
    }

    function getHistory() {
        return _loadHistory();
    }

    window.Stats = {
        onTetInit, end, abort,
        getBuckets, getHistory, ownerId,
        SINGLE_KEYS, MAX_FIELDS, HISTORY_MAX,
    };
})();
