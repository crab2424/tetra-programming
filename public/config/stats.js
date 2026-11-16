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
    function getQuizCleared() {
        const o = _load().owners[ownerId()];
        return (o && o.quiz && o.quiz.cleared) || {};
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
        onTetInit, onPuyoInit, end, abort, beginVersus, endVersus, beginOnline, endOnline, discardOnline, abortOnline,
        beginQuiz, endQuiz,
        getQuizCleared,
        getBuckets, getHistory, ownerId,
        SINGLE_KEYS, MAX_FIELDS, HISTORY_MAX,
    };
})();
