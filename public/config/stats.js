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
//   ぷよ: pc=置いた組数 / er=消したぷよ / ac=全消し / chMax（最大）=最大連鎖 /
//         ch=連鎖の長さごとの回数（長さ 20 の配列。ch[k-1]=k 連鎖、20 以上は末尾。合算は要素ごとに足す）
//
// 入口
//   beginVersus(ctx) / endVersus(r) … VERSUS（対 CPU）。app/versus.js から
//   beginOnline(ctx) / endOnline(r, info) / discardOnline() / abortOnline() … ONLINE。src/online/online_game.ts から
//   beginQuiz(ctx) / endQuiz(r)     … QUIZ。quiz/quiz.js から
//   onPuyoInit(game) … game/puyo/lifecycle.js の start の頭（テトの onTetInit と同じ役目）
//   onTetInit(game) … game/tet/lifecycle.js の _initGameState の頭。前の試合が締まっていなければ
//                     「途中でやめた」で締め、数える対象ならこの試合を数え始める
//   end(game, r)    … 決着（r = 'ok' 完走 / 'ng' ゲームオーバー）
//   abort()         … 途中でやめた（app/navigation.js の stopAllGames）
//   guestImportPending(uid) / importGuest(uid) / declineGuest(uid) … ログイン時のゲスト分の取り込み（config/account.js）
//   reset()         … RESET（今の持ち主の累計とこの端末の履歴を消す）
// ─────────────────────────────────────────────

(function () {
    const STORE_KEY = 'tetlabo_stats';
    const HISTORY_KEY = 'tetlabo_stats_history';
    const VERSION = 1;
    const HISTORY_MAX = 100;

    const TET_SINGLE_MODES = ['marathon', 'sprint', 'ultra', 'zone'];
    // 表示の並び（STATS の SINGLE タブ）
    const SINGLE_KEYS = ['marathon:150', 'marathon:endless', 'sprint:40', 'ultra', 'zone:150', 'puyo'];
    // 合算のとき足さずに最大を取る値（今は端末内だけだが、同期の段階で使う）
    const MAX_FIELDS = ['renMax', 'b2bMax', 'znMax', 'chMax', 'wsMax'];

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

    // ZONE（ZONE モードと、VERSUS の ZONE ON）。znMs / znAtk / znAtkRaw は「ZONE に限った APM」を出すための値:
    //   znMs=発動していた時間 / znAtk=ZONE で出した火力 / znAtkRaw=その火力補正を外したもの
    function _addZone(bucket, game) {
        _add(bucket, 'zn', game.zoneCount);
        _add(bucket, 'znLn', game.zoneLinesTotal);
        _max(bucket, 'znMax', game.zoneBest);
        _add(bucket, 'znMs', Math.round(game.zoneMsTotal || 0));
        _add(bucket, 'znAtk', game.zoneAtkTotal);
        _add(bucket, 'znAtkRaw', game.zoneAtkRawTotal);
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
            _add(bucket, 'atk', game.attackSent); // シングルでも「対戦なら出ていた火力」を数えている（HUD の APM と同じ）
            for (const f of ['t4', 'ts1', 'ts2', 'ts3', 'tsm', 'pcl']) _add(bucket, f, ps[f]);
            _max(bucket, 'renMax', ps.renMax);
            _max(bucket, 'b2bMax', ps.b2bMax);
            if (game.zoneEnabled) _addZone(bucket, game);
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

    // ─── ぷよのシングル ───────────────────────────────────
    function _closePuyoSingle(game, r) {
        const ps = game.playStats;
        if (!ps) return;
        // 出した組のうち、ゲームオーバーなら全部・途中でやめたなら操作中の 1 組を除いたものが置いた数
        const placed = Math.max(0, (ps.sp || 0) - (r === 'q' ? 1 : 0));
        if (r === 'q' && placed === 0) return;

        const key = 'puyo';
        const ms = Math.max(0, Math.round((typeof game.getActiveMs === 'function') ? game.getActiveMs() : (game.elapsed || 0)));
        const custom = (game.recordEligible === false); // 準備画面で連結数・色数を変えた
        const score = Math.max(0, Math.floor(game.score || 0));
        const chainMax = Math.max(0, game.chainMax || 0);

        const data = _load();
        const bucket = (_ownerOf(data, ownerId()).buckets[key] ||= {});
        if (custom) {
            _add(bucket, r === 'q' ? 'cq' : 'cn', 1);
            _add(bucket, 'cms', ms);
        } else {
            _add(bucket, r === 'q' ? 'q' : 'n', 1);
            _add(bucket, 'ms', ms);
            _add(bucket, 'pc', placed);
            _add(bucket, 'er', game.clearedPuyos);
            _add(bucket, 'ac', ps.ac);
            _max(bucket, 'chMax', chainMax);
            if (!Array.isArray(bucket.ch) || bucket.ch.length !== 20) bucket.ch = new Array(20).fill(0);
            for (let i = 0; i < 20; i++) bucket.ch[i] += (ps.ch[i] || 0);
            if (r !== 'q') _add(bucket, 'sc', score);
        }
        _save(data);

        const entry = { at: new Date().toISOString(), k: key, r, ms, sc: score, pc: placed, cm: chainMax };
        if (custom) entry.c = 1;
        if (r !== 'q') {
            const meta = window.ReplayManager?.metaForRecord?.(key);
            if (meta && meta.replayId) entry.rp = meta.replayId;
        }
        _pushHistory(entry);
    }

    // 対戦（VERSUS・ONLINE）で共通の中身: 時間・火力・受けたおじゃま・置いた数と、ルールごとのカウンタ
    function _addMatchPlay(bucket, game, isPuyo, placed, ms, atk) {
        const ps = game.playStats;
        _add(bucket, 'ms', ms);
        _add(bucket, 'atk', atk);
        _add(bucket, 'rcv', game.garbageTaken);
        _add(bucket, 'pc', placed);
        if (isPuyo) {
            _add(bucket, 'er', game.clearedPuyos);
            _add(bucket, 'ac', ps.ac);
            _max(bucket, 'chMax', game.chainMax);
            if (!Array.isArray(bucket.ch) || bucket.ch.length !== 20) bucket.ch = new Array(20).fill(0);
            for (let i = 0; i < 20; i++) bucket.ch[i] += (ps.ch[i] || 0);
        } else {
            _add(bucket, 'ln', game.lines);
            for (const f of ['t4', 'ts1', 'ts2', 'ts3', 'tsm', 'pcl']) _add(bucket, f, ps[f]);
            _max(bucket, 'renMax', ps.renMax);
            _max(bucket, 'b2bMax', ps.b2bMax);
            if (game.zoneEnabled) _addZone(bucket, game);
        }
    }

    // 連勝（途中でやめた試合では呼ばない）。今の連勝は端末ごとの owners[..].streak、最大は枠の wsMax
    function _addStreak(owner, bucket, key, r) {
        if (!owner.streak || typeof owner.streak !== 'object') owner.streak = {};
        owner.streak[key] = (r === 'w') ? (owner.streak[key] || 0) + 1 : 0;
        _max(bucket, 'wsMax', owner.streak[key]);
    }

    // ─── VERSUS（対 CPU） ─────────────────────────────────
    // 枠は vs:<自分のルール>:<相手のルール>:<CPU レベル>。設定を変えた試合も全部数える（設計 §1）。
    //   w / l     … 勝ち・負け（n = w + l）
    //   atk       … 出した火力（HUD の APM と同じ attackSent。補正・マージン込み）
    //   atkRaw    … 火力補正（ATTACK BIAS）を外した火力（マージンは込みのまま。設計 §4）
    //   rcv       … 実際に受けたおじゃま（テト=せり上がった段数 / ぷよ=降ったおじゃまぷよ）
    //   bias      … どちらかに火力補正が付いていた試合の数（決着した試合だけ）
    //   wsMax（最大）… 最大連勝。今の連勝は端末ごとの owners[..].streak に持つ（合算しない）
    // r: 'w' / 'l' / 'q'
    function _closeVersus(cur, r) {
        const game = cur.game;
        const ps = game.playStats;
        if (!ps) return;
        const isPuyo = cur.myRule === 'puyo';
        const placed = isPuyo ? Math.max(0, (ps.sp || 0) - (r === 'l' ? 0 : 1)) : (ps.pc || 0);
        if (r === 'q' && placed === 0) return;

        const key = `vs:${cur.myRule}:${cur.oppRule}:${cur.level}`;
        const ms = Math.max(0, Math.round((typeof game.getActiveMs === 'function') ? game.getActiveMs() : 0));
        const score = Math.max(0, Math.floor(game.score || 0));
        const atk = Math.max(0, Math.round(game.attackSent || 0));
        const atkRaw = Math.max(0, Math.round(game.attackRaw || 0));
        const biased = !!(cur.bias && (cur.bias[0] || cur.bias[1]));

        const data = _load();
        const owner = _ownerOf(data, ownerId());
        const bucket = (owner.buckets[key] ||= {});
        _addMatchPlay(bucket, game, isPuyo, placed, ms, atk);
        _add(bucket, 'atkRaw', atkRaw);
        if (r === 'q') {
            _add(bucket, 'q', 1);
        } else {
            _add(bucket, 'n', 1);
            _add(bucket, r, 1);
            if (biased) _add(bucket, 'bias', 1);
            _addStreak(owner, bucket, key, r);
        }
        _save(data);

        const entry = {
            at: new Date().toISOString(), k: key, r, ms, sc: score, atk, atkRaw, pc: placed,
            vs: { bias: cur.bias || [0, 0], margin: cur.margin, zone: cur.zone ? 1 : 0 },
        };
        if (isPuyo) entry.cm = Math.max(0, game.chainMax || 0); else entry.ln = Math.max(0, game.lines || 0);
        if (!isPuyo && game.zoneMsTotal > 0) { entry.zms = Math.round(game.zoneMsTotal); entry.zatk = game.zoneAtkTotal || 0; }
        if (r !== 'q') {
            const rep = window.ReplayManager && window.ReplayManager.resultReplay;
            if (rep && rep.mode === 'versus' && rep.id) entry.rp = rep.id;
        }
        _pushHistory(entry);
    }

    // ─── ONLINE ───────────────────────────────────────────
    // 枠は ol:<自分のルール>:<相手のルール>（3 人以上の部屋は相手を multi）。1 ラウンド＝1 試合として数える。
    //   w / l / d … ラウンドの勝ち・負け・引き分け（n = w + l + d）
    //   sw / sl   … セット（先取。2 本先取以上の部屋だけ）の勝ち・負け。セットが決まったラウンドで足す
    //   dcW       … 相手の切断で勝ちになったラウンド（w にも数える）
    //   atk / rcv … VERSUS と同じ。ONLINE には火力補正が無いので atkRaw は持たない（= atk。設計 §4）
    //   wsMax（最大）… ラウンドの最大連勝（引き分けでは動かさない）
    // 自分が切断したラウンドは数えない（discardOnline。サーバーの勝敗が来ないため。設計 §5）
    // r: 'w' / 'l' / 'd' / 'q'。info = { died: 自分の盤面が倒れたか, set: 'w'|'l'|null, dc: 切断勝ちか, round, target }
    function _closeOnline(cur, r, info) {
        const game = cur.game;
        const ps = game.playStats;
        if (!ps) return;
        info = info || {};
        const isPuyo = cur.myRule === 'puyo';
        // ぷよは出した組のうち、倒れていなければ操作中の 1 組を除く（倒れたときは出せなかった組は sp に入っていない）
        const placed = isPuyo ? Math.max(0, (ps.sp || 0) - (info.died ? 0 : 1)) : (ps.pc || 0);
        if (r === 'q' && placed === 0) return;

        const key = `ol:${cur.myRule}:${cur.oppRule}`;
        const ms = Math.max(0, Math.round((typeof game.getActiveMs === 'function') ? game.getActiveMs() : 0));
        const score = Math.max(0, Math.floor(game.score || 0));
        const atk = Math.max(0, Math.round(game.attackSent || 0));

        const data = _load();
        const owner = _ownerOf(data, ownerId());
        const bucket = (owner.buckets[key] ||= {});
        _addMatchPlay(bucket, game, isPuyo, placed, ms, atk);
        if (r === 'q') {
            _add(bucket, 'q', 1);
        } else {
            _add(bucket, 'n', 1);
            _add(bucket, r, 1);
            if (r === 'w' && info.dc) _add(bucket, 'dcW', 1);
            if (info.set === 'w') _add(bucket, 'sw', 1);
            else if (info.set === 'l') _add(bucket, 'sl', 1);
            if (r !== 'd') _addStreak(owner, bucket, key, r);
        }
        _save(data);

        const entry = { at: new Date().toISOString(), k: key, r, ms, sc: score, atk, pc: placed };
        if (isPuyo) entry.cm = Math.max(0, game.chainMax || 0); else entry.ln = Math.max(0, game.lines || 0);
        if (r !== 'q') {
            const ol = {};
            if (info.target > 1) { ol.round = info.round || 0; ol.target = info.target; }
            if (info.set) ol.set = info.set;
            if (r === 'w' && info.dc) ol.dc = 1;
            if (Object.keys(ol).length) entry.ol = ol;
        }
        _pushHistory(entry);
    }

    // ─── QUIZ ─────────────────────────────────────────────
    // 枠は quiz:<ルール>。n=決着した挑戦（正解＋失敗）/ ok=正解 / q=途中でやめた / ms=遊んだ時間。
    // 解いた問題は owners[..].quiz.cleared[<問題 id>] = 最初に解いた日時（合算は和・日時は古い方）
    // r: 'ok' / 'ng' / 'q'
    function _closeQuiz(cur, r) {
        const game = cur.game;
        const ps = game.playStats || {};
        const isPuyo = cur.quizRule === 'puyo';
        // 1 手も置かずにやめた挑戦は数えない（ぷよは出した組から操作中の 1 組を除く）
        const placed = isPuyo ? Math.max(0, (ps.sp || 0) - 1) : (ps.pc || 0);
        if (r === 'q' && placed === 0) return;

        const key = 'quiz:' + cur.quizRule;
        const ms = Math.max(0, Math.round((typeof game.getActiveMs === 'function') ? game.getActiveMs() : 0));
        const data = _load();
        const owner = _ownerOf(data, ownerId());
        const bucket = (owner.buckets[key] ||= {});
        _add(bucket, r === 'q' ? 'q' : 'n', 1);
        _add(bucket, 'ms', ms);
        if (r === 'ok') {
            _add(bucket, 'ok', 1);
            if (!owner.quiz || typeof owner.quiz !== 'object') owner.quiz = { cleared: {} };
            if (!owner.quiz.cleared || typeof owner.quiz.cleared !== 'object') owner.quiz.cleared = {};
            if (cur.quizId && !owner.quiz.cleared[cur.quizId]) owner.quiz.cleared[cur.quizId] = new Date().toISOString();
        }
        _save(data);
        _pushHistory({ at: new Date().toISOString(), k: key, r, ms, id: cur.quizId, no: cur.quizNo });
    }

    // ─── 入口 ─────────────────────────────────────────────
    function _close(r, info) {
        const cur = current;
        current = null;
        if (!cur || !cur.game) return;
        if (cur.game._replay) return; // 念のため: 再生に使われている盤面は数えない
        try {
            if (cur.rule === 'vs') _closeVersus(cur, r);
            else if (cur.rule === 'ol') _closeOnline(cur, r, info);
            else if (cur.rule === 'quiz') _closeQuiz(cur, r);
            else if (cur.rule === 'tet') _closeTetSingle(cur.game, r);
            else if (cur.rule === 'puyo') _closePuyoSingle(cur.game, r);
        } catch (e) {
            console.error('[Stats]', e); // 成績が残らないだけで、試合の進行は止めない
        }
    }

    function onTetInit(game) {
        if (game && game.isVersusMode) return; // VERSUS の盤面は beginVersus / endVersus が受け持つ
        _close('q'); // 前の試合が締まっていなければ途中でやめた扱い（リスタートなど）
        if (!game || game._replay || game.isVersusMode || game.isCpuControlled) return;
        if (!TET_SINGLE_MODES.includes(game.currentMode)) return; // PRACTICE・QUIZ・CPU TEST は対象外
        current = { game, rule: 'tet' };
    }

    function onPuyoInit(game) {
        if (game && game.isVersusMode) return;
        _close('q');
        if (!game || game._replay || game.isVersusMode || game.isCpuControlled) return;
        if (game.currentMode !== 'puyo') return; // PRACTICE・QUIZ・CPU TEST は対象外
        current = { game, rule: 'puyo' };
    }

    function end(game, r) {
        if (!current || current.game !== game || current.rule === 'vs' || current.rule === 'ol' || current.rule === 'quiz') return;
        _close(r === 'ok' ? 'ok' : 'ng');
    }

    function abort() {
        _close('q');
    }

    // VERSUS（app/versus.js の startVersusGame。両盤面の初期化の後・人が 1P を操作するときだけ呼ばれる）
    // ctx = { game, myRule, oppRule, level, bias: [自分, 相手], margin: 秒|null, zone }
    function beginVersus(ctx) {
        _close('q');
        if (!ctx || !ctx.game || ctx.game._replay || ctx.game.isCpuControlled) return;
        current = Object.assign({}, ctx, { rule: 'vs' });
    }

    // r: 'w' 勝ち / 'l' 負け（versusGameOver）
    function endVersus(r) {
        if (!current || current.rule !== 'vs') return;
        _close(r === 'w' ? 'w' : 'l');
    }

    // ONLINE（src/online/online_game.ts。カウントダウン明けにラウンドの本編が始まった所）
    // ctx = { game, myRule: 'tet'|'puyo', oppRule: 'tet'|'puyo'|'multi' }
    function beginOnline(ctx) {
        _close('q');
        if (!ctx || !ctx.game || ctx.game._replay) return;
        if (ctx.myRule !== 'tet' && ctx.myRule !== 'puyo') return;
        const oppRule = (ctx.oppRule === 'tet' || ctx.oppRule === 'puyo') ? ctx.oppRule : 'multi';
        current = { game: ctx.game, rule: 'ol', myRule: ctx.myRule, oppRule };
    }

    // r: 'w' 勝ち / 'l' 負け / 'd' 引き分け（WinnerNotification・ローカル判定の決着）。info は _closeOnline を参照
    function endOnline(r, info) {
        if (!current || current.rule !== 'ol') return;
        _close(r === 'w' || r === 'd' ? r : 'l', info);
    }

    // 自分の切断で終わったラウンド・決着が分からないまま終わったラウンドは何も数えない
    function discardOnline() {
        if (current && current.rule === 'ol') current = null;
    }

    // ONLINE の部屋を出た（cleanup）。本編の途中なら「途中でやめた」
    function abortOnline() {
        if (current && current.rule === 'ol') _close('q');
    }

    // QUIZ（quiz/quiz.js の QuizManager.start）。ctx = { game, level: 問題のデータ, no: 何問目か }
    // クイズエディタの試遊（level._editorTest）は数えない
    function beginQuiz(ctx) {
        _close('q');
        const level = ctx && ctx.level;
        if (!ctx || !ctx.game || !level || level._editorTest) return;
        if (level.rule !== 'tet' && level.rule !== 'puyo') return;
        current = { game: ctx.game, rule: 'quiz', quizRule: level.rule, quizId: String(level.id), quizNo: ctx.no || 0 };
    }

    // r: 'ok' 正解 / 'ng' 失敗（QuizManager の _onClear / _onFailed）
    function endQuiz(r) {
        if (!current || current.rule !== 'quiz') return;
        _close(r === 'ok' ? 'ok' : 'ng');
    }

    // 解いた問題の一覧 { <問題 id>: 最初に解いた日時 }
    // ログイン中で同期済みなら、他の端末の分（others）と合わせたもの
    function getQuizCleared() {
        const o = _load().owners[ownerId()];
        if (!o) return {};
        if (ownerId() !== 'guest' && o.others) return _mergeOwner(_clone(o.others), _minePart(o)).quiz.cleared;
        return (o.quiz && o.quiz.cleared) || {};
    }

    // ─── 合算・ゲスト分の取り込み・RESET（設計 §6.3〜§6.5） ─────
    // 枠を足し合わせる: 足す値は足し算、MAX_FIELDS は最大、ch（連鎖の長さごと）は要素ごとに足す。
    // 同期（S7）で端末ごとの欄を合計するときにも使う。
    function _mergeBucket(dst, src) {
        for (const [f, v] of Object.entries(src || {})) {
            if (f === 'ch') {
                if (!Array.isArray(v)) continue;
                if (!Array.isArray(dst.ch) || dst.ch.length !== 20) dst.ch = new Array(20).fill(0);
                for (let i = 0; i < 20; i++) dst.ch[i] += (v[i] || 0);
            } else if (typeof v === 'number' && isFinite(v)) {
                if (MAX_FIELDS.includes(f)) _max(dst, f, v);
                else _add(dst, f, v);
            }
        }
        return dst;
    }

    // 持ち主の中身（枠と解いた問題）を dst に足す。解いた問題は和（日時は古い方）
    function _mergeOwner(dst, src) {
        for (const [key, b] of Object.entries((src && src.buckets) || {})) {
            _mergeBucket((dst.buckets[key] ||= {}), b);
        }
        const from = (src && src.quiz && src.quiz.cleared) || {};
        if (!dst.quiz || typeof dst.quiz !== 'object') dst.quiz = { cleared: {} };
        if (!dst.quiz.cleared || typeof dst.quiz.cleared !== 'object') dst.quiz.cleared = {};
        for (const [id, at] of Object.entries(from)) {
            const cur = dst.quiz.cleared[id];
            if (!cur || String(at) < String(cur)) dst.quiz.cleared[id] = at;
        }
        return dst;
    }

    // ゲスト分の大きさ（回数は設定を変えた試合・途中でやめた試合も含む）
    function _ownerSize(o) {
        let plays = 0, ms = 0;
        for (const b of Object.values((o && o.buckets) || {})) {
            plays += (b.n || 0) + (b.q || 0) + (b.cn || 0) + (b.cq || 0);
            ms += (b.ms || 0) + (b.cms || 0);
        }
        const solved = Object.keys((o && o.quiz && o.quiz.cleared) || {}).length;
        return { plays, ms, solved };
    }

    // 「聞いたときのゲスト分」の指紋。ゲスト分が増えたら変わる → もう一度聞く
    const _fingerprint = (size) => `${size.plays}:${Math.round(size.ms)}:${size.solved}`;

    // ログインしたとき、このアカウントへ取り込むか聞くべきゲスト分があれば { plays, ms, solved }、無ければ null
    function guestImportPending(uid) {
        if (!uid || uid === 'guest') return null;
        const data = _load();
        const size = _ownerSize(data.owners.guest);
        if (size.plays === 0 && size.solved === 0) return null;
        const asked = data.importAsked && data.importAsked[uid];
        if (asked === _fingerprint(size)) return null;
        return size;
    }

    // YES: ゲスト分をアカウントの枠へ足して、ゲスト分を空にする（履歴は端末のものなのでそのまま）
    function importGuest(uid) {
        if (!uid || uid === 'guest') return false;
        const data = _load();
        const guest = data.owners.guest;
        if (!guest) return false;
        _mergeOwner(_ownerOf(data, String(uid)), guest);
        delete data.owners.guest;
        if (data.importAsked) delete data.importAsked[uid];
        _save(data);
        return true;
    }

    // NO: ゲスト分はそのまま残し、増えるまでこのアカウントでは聞かない
    function declineGuest(uid) {
        if (!uid || uid === 'guest') return;
        const data = _load();
        if (!data.importAsked || typeof data.importAsked !== 'object') data.importAsked = {};
        data.importAsked[uid] = _fingerprint(_ownerSize(data.owners.guest));
        _save(data);
    }

    // ─── 端末間の同期（設計 §6.2〜§6.6。通信は config/cloud_sync.js の _syncStats） ─────
    // サーバーの中身（user_data の区分 stats）:
    //   { epoch, devices: { <端末の欄 id>: { at, buckets, quiz } }, retired: [id…], merged: { buckets, quiz } }
    // 端末は自分の欄だけを書く。自分の欄の中身は、この端末のそのアカウントの累計（owners[uid].buckets / quiz）そのもの。
    // 端末側にアカウントごとに持つもの:
    //   dev    … このアカウントで使う欄の id（既定は deviceId。まとめられたら作り直す）
    //   pushed … 最後にサーバーへ受け付けられた自分の欄（まとめられたとき「今 − pushed」を新しい欄にするため）
    //   others … 自分以外の欄と merged の合計（表示用。同期のたびに作り直す）
    //   seen   … 1 回でもサーバーの中身を見たか。まだなら、サーバーの epoch が大きくても数字は捨てない
    const DEVICES_MAX = 8;
    const RETIRED_MAX = 64;

    const _emptyPart = () => ({ buckets: {}, quiz: { cleared: {} } });
    const _clone = (v) => JSON.parse(JSON.stringify(v));

    function _normDoc(raw) {
        const d = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
        const part = (p) => ({
            buckets: (p && p.buckets && typeof p.buckets === 'object') ? p.buckets : {},
            quiz: { cleared: (p && p.quiz && p.quiz.cleared && typeof p.quiz.cleared === 'object') ? p.quiz.cleared : {} },
        });
        const devices = {};
        if (d.devices && typeof d.devices === 'object') {
            for (const [id, dv] of Object.entries(d.devices)) {
                if (dv && typeof dv === 'object') devices[id] = Object.assign(part(dv), { at: Number(dv.at) || 0 });
            }
        }
        return {
            epoch: Number.isInteger(d.epoch) && d.epoch > 0 ? d.epoch : 0,
            devices,
            retired: Array.isArray(d.retired) ? d.retired.map(String) : [],
            merged: part(d.merged),
        };
    }

    // 「今 − 最後に送ったもの」。足す値は引き算（0 未満にしない）、最大の値と解いた問題はそのまま（足し直しても変わらない）
    function _subtractBuckets(cur, base) {
        const out = {};
        for (const [key, b] of Object.entries(cur || {})) {
            const p = (base && base[key]) || {};
            const nb = {};
            for (const [f, v] of Object.entries(b)) {
                if (f === 'ch' && Array.isArray(v)) {
                    nb.ch = v.map((x, i) => Math.max(0, (x || 0) - ((Array.isArray(p.ch) && p.ch[i]) || 0)));
                } else if (typeof v === 'number') {
                    nb[f] = MAX_FIELDS.includes(f) ? v : Math.max(0, v - (p[f] || 0));
                }
            }
            out[key] = nb;
        }
        return out;
    }

    const _minePart = (o) => ({ buckets: o.buckets || {}, quiz: { cleared: (o.quiz && o.quiz.cleared) || {} } });
    const _sameStr = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    // サーバーの今の中身から、送る中身を作る。端末側の epoch の追従・まとめられた欄の作り直しはここで保存まで済ませる。
    // @returns { doc: 送る中身, changed: 送る必要があるか, sent: 自分の欄（受け付けられたら commitSync に渡す） }
    function prepareSync(uid, rawDoc) {
        uid = String(uid);
        const data = _load();
        const o = _ownerOf(data, uid);
        let doc = _normDoc(rawDoc);
        let changed = false;

        const localEpoch = Number.isInteger(o.epoch) ? o.epoch : 0;
        if (doc.epoch > localEpoch && !o.seen) {
            // この端末でこのアカウントとまだ一度も揃えていない（新しい端末・ゲスト分を取り込んだばかり）
            // → 数字は RESET の後に数えたものなので、捨てずに今の epoch に乗せる
            o.epoch = doc.epoch;
        } else if (doc.epoch > localEpoch) {
            // 他の端末で RESET された → この端末のこのアカウントの数字も捨てて揃える（古い数字が戻ってこないように）
            o.buckets = {}; o.quiz = { cleared: {} }; o.streak = {};
            delete o.pushed; delete o.others;
            o.epoch = doc.epoch;
            if (current && ownerId() === uid) current = null;
        } else if (localEpoch > doc.epoch) {
            // この端末で RESET した → サーバーを空にして epoch を進める
            doc = { epoch: localEpoch, devices: {}, retired: [], merged: _emptyPart() };
            changed = true;
        }

        let dev = o.dev || data.deviceId;
        if (doc.retired.includes(dev)) {
            // この欄は merged にまとめられている → まだ送っていない差分だけを新しい欄として持ち直す（二重に数えない）
            o.buckets = _subtractBuckets(o.buckets, o.pushed && o.pushed.buckets);
            delete o.pushed;
            dev = _newId();
        }
        o.dev = dev;
        o.seen = true; // 以後はサーバーの epoch が進んでいたら数字を捨てる
        _save(data);

        const mine = _clone(_minePart(o));
        const onServer = doc.devices[dev];
        const mineEmpty = Object.keys(mine.buckets).length === 0 && Object.keys(mine.quiz.cleared).length === 0;
        // まだ一度も遊んでいないアカウントで、空の欄を作りに行かない
        if (onServer ? !_sameStr({ buckets: onServer.buckets, quiz: onServer.quiz }, mine) : !mineEmpty) changed = true;
        if (changed) {
            doc.devices[dev] = Object.assign({ at: Date.now() }, mine);
            // 欄が多すぎたら、一番古い欄（自分以外）を merged にまとめる
            while (Object.keys(doc.devices).length > DEVICES_MAX) {
                let oldest = null;
                for (const [id, dv] of Object.entries(doc.devices)) {
                    if (id === dev) continue;
                    if (!oldest || dv.at < doc.devices[oldest].at) oldest = id;
                }
                if (!oldest) break;
                _mergeOwner(doc.merged, doc.devices[oldest]);
                delete doc.devices[oldest];
                doc.retired.push(oldest);
            }
            if (doc.retired.length > RETIRED_MAX) doc.retired = doc.retired.slice(-RETIRED_MAX);
        }
        return { doc, changed, sent: changed ? mine : null, dev };
    }

    // サーバーと揃った後に呼ぶ。sent（受け付けられた自分の欄）を pushed に、他の欄の合計を others に控える
    function commitSync(uid, doc, sent, dev) {
        uid = String(uid);
        const d = _normDoc(doc);
        const data = _load();
        const o = _ownerOf(data, uid);
        if (d.epoch !== (o.epoch || 0)) return; // 待っている間に RESET された → 次の同期で揃え直す
        if (sent) o.pushed = sent;
        const others = _mergeOwner(_emptyPart(), d.merged);
        for (const [id, dv] of Object.entries(d.devices)) {
            if (id !== dev) _mergeOwner(others, dv);
        }
        o.others = others;
        o.othersAt = Date.now();
        _save(data);
    }

    // 送っていない変化があるか（メニューに戻ったとき・タブを隠したときに、送るかどうかの判定に使う）
    function hasUnpushed(uid) {
        if (!uid || uid === 'guest') return false;
        const o = _load().owners[String(uid)];
        if (!o) return false;
        if (!o.pushed) return Object.keys(o.buckets || {}).length > 0 || Object.keys((o.quiz && o.quiz.cleared) || {}).length > 0 || (o.epoch || 0) > 0;
        return !_sameStr(_minePart(o), o.pushed);
    }

    // 表示している数字が全端末の合算か（ログイン中で、1 回でもサーバーと揃えたことがある）
    function isMerged() {
        const id = ownerId();
        if (id === 'guest') return false;
        const o = _load().owners[id];
        return !!(o && o.others);
    }

    // RESET（STATS 画面）。今の持ち主の累計と、この端末の履歴を消す。
    // ログイン中は epoch を +1 する（同期の段階 S7 で、他の端末の古い数字が戻ってこないようにするため。設計 §6.5）
    function reset() {
        current = null; // 念のため（STATS 画面から呼ぶので普通は数えている試合は無い）
        const data = _load();
        const id = ownerId();
        if (id === 'guest') {
            delete data.owners.guest;
        } else {
            const prev = data.owners[id];
            // epoch はサーバーの値（他の端末の RESET を取り込んだもの）より必ず大きくする。
            // 欄の id は残す（RESET でサーバーの devices / retired も空になるので、そのまま使ってよい）
            data.owners[id] = { epoch: ((prev && prev.epoch) || 0) + 1, buckets: {}, quiz: { cleared: {} } };
            if (prev && prev.dev) data.owners[id].dev = prev.dev;
            if (prev && prev.seen) data.owners[id].seen = true;
        }
        _save(data);
        try { localStorage.removeItem(HISTORY_KEY); } catch (e) { /* 消せなくても累計は消えている */ }
    }

    // ─── 読み出し（app/stats_page.js） ────────────────────
    // 表示用の累計。ログイン中で同期済みなら全端末の合算（others ＋ この端末の分）
    function getBuckets() {
        const data = _load();
        const o = data.owners[ownerId()];
        if (!o) return {};
        if (ownerId() !== 'guest' && o.others) return _mergeOwner(_clone(o.others), _minePart(o)).buckets;
        return o.buckets || {};
    }

    function getHistory() {
        return _loadHistory();
    }

    window.Stats = {
        onTetInit, onPuyoInit, end, abort, beginVersus, endVersus, beginOnline, endOnline, discardOnline, abortOnline,
        beginQuiz, endQuiz,
        getQuizCleared, guestImportPending, importGuest, declineGuest, reset,
        prepareSync, commitSync, hasUnpushed, isMerged,
        mergeBucket: _mergeBucket,
        getBuckets, getHistory, ownerId,
        SINGLE_KEYS, MAX_FIELDS, HISTORY_MAX,
    };
})();
