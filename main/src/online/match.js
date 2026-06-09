// ─────────────────────────────────────────────────────────────
// online/match.js — オンライン対戦の対戦中ゲーム同期（step5後半）
//
// B方式（ライブ状態ストリーミング）の本体側クライアント実装。
//   ・自分のゲーム = 通常の権威エンジン（window._game）をローカル完結で実行。
//   ・相手のゲーム = 「パペット」(重力/入力ループ無効・受信データを描画するだけ)を
//     window._cpuGame 枠に置く（VERSUS の CPU 枠を差し替える形）。
//
// 送信: PieceState を 30Hz で送出（loop）＋ 離散イベント(Spawn/Lock/Hold/GarbageSend/
//       GameOver)をエンジンのフック点から送出（window.OnlineHooks 経由）。
// 受信: net.on('gameEvent'/'pieceState') を Subprotocol で復号し、
//       表示同期(Spawn/Lock/PieceState/Hold)=パペットへ描画 /
//       ゲーム影響(GarbageSend)=自分の garbageQueue へ / GameOver=自分の勝ちで終了。
//
// 依存（実行時参照）: OnlineNet, Subprotocol, switchPage, stopAllGames,
//   _switchToVersusMixedLayout, applyVsSettings, runCountdown, versusGameOver,
//   Game / PuyoGame / Mino / Block / Field（グローバル）。
//
// ※ タイムスタンプ補間（[[project-online-design]] §6）は v1 では未実装（即時適用）。
//   滑らかさ向上は後続。Lock 盤面スナップショットが定期補正を兼ねる。
// ─────────────────────────────────────────────────────────────
(function (root) {
  "use strict";

  const PIECE_STATE_HZ = 30;

  class OnlineMatch {
    constructor(net, myRule, oppRule, myName, oppName, seed) {
      this.net = net;
      this.myRule = myRule;       // 'tet' | 'puyo'（自分）
      this.oppRule = oppRule;     // 'tet' | 'puyo'（相手＝パペット）
      this.myName = myName || 'YOU';
      this.oppName = oppName || 'OPPONENT';
      this.seed = (seed >>> 0) || 0; // 共有シード（両者同ツモ用。0 のときは同ツモ無効）
      this.active = false;
      this.startedAt = 0;         // GameStart 相対 t の基準（performance.now）
      this._psTimer = null;       // PieceState 送出インターバル
      this._netHandlers = null;   // net.on で登録したコールバック（teardown で off するため保持）
      this._endedSent = false;
      // 予告ゲージ送信の重複抑止（直近に送った ready/unready）
      this._lastGaugeReady = -1;
      this._lastGaugeUnready = -1;
    }

    // ── GameStart 相対ミリ秒 ──
    _t() { return Math.max(0, Math.round(performance.now() - this.startedAt)); }

    // ════════════════════════════════════════════
    // 開始
    // ════════════════════════════════════════════
    async begin() {
      if (typeof stopAllGames === 'function') stopAllGames();

      // VERSUS の各種ロジック（相殺・火力変換）が参照するルール globals を
      // オンライン用に合わせる（player=自分 / cpu=相手パペット）。
      try { if (typeof versusPlayerRule !== 'undefined') versusPlayerRule = this.myRule; } catch (_) {}
      try { if (typeof versusCpuRule !== 'undefined') versusCpuRule = this.oppRule; } catch (_) {}

      // 既存の VERSUS ポーズ/リスタートハンドラがオンラインで誤発火しないよう外す
      if (root._versusPauseHandler) {
        document.removeEventListener('keydown', root._versusPauseHandler);
        root._versusPauseHandler = null;
      }

      switchPage('versus');
      root._versusFinishing = false;
      this._endedSent = false;

      const isMyPuyo = this.myRule === 'puyo';
      const isOppPuyo = this.oppRule === 'puyo';

      // レイアウト（player=自分 / cpu=相手）
      if (typeof _switchToVersusMixedLayout === 'function') {
        _switchToVersusMixedLayout(this.myRule, this.oppRule);
      }

      // 見出しラベル（自分=player-label / 相手=cpu-side-label）にプレイヤー名を反映
      const myLabel = document.querySelector('#versus-player-side .player-label');
      if (myLabel) myLabel.textContent = this.myName;
      const sideLabel = document.getElementById('versus-cpu-side-label');
      if (sideLabel) sideLabel.textContent = this.oppName;
      const lvDisp = document.getElementById('versus-cpu-level-display');
      if (lvDisp) lvDisp.textContent = '';

      // ─── 自分（権威エンジン） ───
      if (isMyPuyo) {
        if (!root._puyoGamePlayer) root._puyoGamePlayer = new PuyoGame('player');
        root._game = root._puyoGamePlayer;
      } else {
        if (!root._tetGamePlayer) root._tetGamePlayer = new Game('player');
        root._game = root._tetGamePlayer;
      }
      // ─── 相手（パペット） ───
      if (isOppPuyo) {
        if (!root._puyoGameCpu) root._puyoGameCpu = new PuyoGame('cpu');
        root._cpuGame = root._puyoGameCpu;
      } else {
        if (!root._tetGameCpu) root._tetGameCpu = new Game('cpu');
        root._cpuGame = root._tetGameCpu;
      }

      const me = root._game;
      const opp = root._cpuGame;
      this.me = me;
      this.opp = opp;

      // 共通設定
      me.currentMode = 'versus';
      me.marathonGoal = Infinity;
      me.isVersusMode = true;
      me.canvasPrefix = 'player';
      me.statsPrefix = 'player';
      me._labelsInitialized = false;
      me.isCpuControlled = false;

      // パペットは「描画専用」: VERSUS の自動進行や火力タイマーを動かさない
      opp.currentMode = 'versus';
      opp.marathonGoal = Infinity;
      opp.isVersusMode = false;   // ★ パペットは inert（マージン/ゲージのタイマーを起動させない）
      opp.canvasPrefix = 'cpu';
      opp.statsPrefix = 'cpu';
      opp.isCpuControlled = true;
      opp._labelsInitialized = false;
      opp.isPuppet = true;

      // VS 設定（マージン/補正/HOLD/おじゃまレート）を自分側へ注入
      if (typeof applyVsSettings === 'function') {
        applyVsSettings(me, opp, this.myRule, this.oppRule);
      }

      // ─── 同ツモ用シード ───
      // 自分の権威エンジンに共有シードを注入し、両者が同じツモ列で対戦できるようにする。
      //   ・テト getNextType / ぷよ _initActiveColors・_makePair が tumoRng を参照する。
      //   ・初期 nextQueue は下の初期化（_initGameState / initGame）で生成されるため、
      //     必ずその前に設定する。
      //   ・相手パペットは受信データで盤面を描くだけなので tumoRng 不要（明示的に解除）。
      me.tumoRng = (this.seed && typeof createSeededRandom === 'function')
        ? createSeededRandom(this.seed) : null;
      opp.tumoRng = null;

      // ─── 自分の初期化 ───
      if (isMyPuyo) {
        await new Promise((res) => me.initGame(res));
      } else {
        me.initMainCanvas();
        me.initNextCanvas();
        me.initHoldCanvas();
        me._initGameState();
        me.setKeyEvent();
        me.level = 2;
        me.updateStatsDisplay();
      }

      // ─── パペットの初期化（描画のみ・ループ起動なし） ───
      await this._initPuppet();

      // ─── ネット受信ハンドラ ───
      this._wireNet();

      // ─── カウントダウン → 開始 ───
      // ※ 双方同時開始の厳密同期は step6（GameStart/サーバー駆動）。
      //   v1 は各クライアントが独立にカウントダウンして開始する。
      this.active = true;
      root._onlineMatch = this;
      root.OnlineHooks = this._buildHooks();

      if (isMyPuyo) me.state = 'starting';

      runCountdown('player-countdown-overlay', 'player-countdown-text', () => {
        if (!this.active) return;
        if (root.BgmManager) root.BgmManager.play('versus_bgm');
        this.startedAt = performance.now();
        me._startGameplay();
        this._startPieceStateLoop();
      }, null);

      // 相手側カウントダウンは演出のみ（パペットは _startGameplay しない）
      runCountdown('cpu-countdown-overlay', 'cpu-countdown-text', () => {}, null);
    }

    // ── パペットを描画可能な空状態へ初期化 ──
    async _initPuppet() {
      const opp = this.opp;
      if (this.oppRule === 'puyo') {
        await new Promise((res) => opp.initGame(res));
        // パペットは入力で動かさない（initGame が付けたキーハンドラを外す）
        if (typeof opp._removeKeyHandlers === 'function') opp._removeKeyHandlers();
        opp.state = 'idle';
        opp._gs = 'idle';        // _render で操作ぷよ/ゴーストを描かない
        opp._initField();        // 空フィールド
        opp.nextQueue = [];
        this._renderPuppet();
      } else {
        opp.initMainCanvas();
        opp.initNextCanvas();
        opp.initHoldCanvas();
        opp.field = new Field();
        opp.nextQueue = [];
        opp.holdMino = null;
        opp.mino = null;
        opp.canHold = true;
        this._renderPuppet();
      }
    }

    // ════════════════════════════════════════════
    // 送信フック群（エンジンから window.OnlineHooks.* で呼ばれる）
    //   いずれも「自分(window._game)が発火元のときだけ」送る。
    // ════════════════════════════════════════════
    _buildHooks() {
      const self = this;
      const fromMe = (g) => self.active && g === root._game;
      return {
        get active() { return self.active; },

        // ─ テト ─
        tetSpawn(g) {
          if (!fromMe(g) || !g.mino) return;
          const next = (g.nextQueue || []).slice(0, 5).map((m) => m.type);
          self.net.sendGameEvent(Subprotocol.encodeSpawnTet({ t: self._t(), type: g.mino.type, next }));
        },
        tetLock(g) {
          if (!fromMe(g)) return;
          const board = Subprotocol.buildTetBoard(g.field.blocks);
          self.net.sendGameEvent(Subprotocol.encodeLockTet({ t: self._t(), board }));
        },
        tetHold(g) {
          if (!fromMe(g) || !g.holdMino) return;
          self.net.sendGameEvent(Subprotocol.encodeHold({ t: self._t(), heldType: g.holdMino.type }));
        },

        // ─ ぷよ ─
        puyoSpawn(g) {
          if (!fromMe(g)) return;
          const next = (g.nextQueue || []).slice(0, 3).map((p) => [p[0], p[1]]);
          self.net.sendGameEvent(Subprotocol.encodeSpawnPuyo({
            t: self._t(), pivotColor: g.pivotColor, childColor: g.childColor, next,
          }));
        },
        puyoLock(g) {
          if (!fromMe(g)) return;
          const board = Subprotocol.buildPuyoBoard(g.field);
          self.net.sendGameEvent(Subprotocol.encodeLockPuyo({ t: self._t(), board }));
        },

        // ─ 共通: 予告ゲージ（自分に降ってくる予定の量をフェーズ別に相手へ通知）─
        //   相手側パペットのゲージ＝「相手に届いている火力」を可視化（①③）。
        gaugeUpdate(g) {
          if (!fromMe(g)) return;
          let ready = 0, unready = 0;
          for (const q of (g.garbageQueue || [])) {
            if (q.internal) continue;        // stage1(非表示)は送らない
            if (q.ready) ready += q.amount; else unready += q.amount;
          }
          if (ready === self._lastGaugeReady && unready === self._lastGaugeUnready) return;
          self._lastGaugeReady = ready;
          self._lastGaugeUnready = unready;
          self.net.sendGameEvent(Subprotocol.encodePending({ t: self._t(), ready, unready }));
        },

        // ─ 共通: GarbageSend（★ゲーム影響）───
        //   amount/holes は送信側エンジンが受信側ルール向けに算出済み。
        //   senderIsPuyo は受信側の着弾猶予の決定に使う。
        sendGarbage(amount, holes, senderIsPuyo) {
          if (!self.active) return;
          self.net.sendGameEvent(Subprotocol.encodeGarbage({ t: self._t(), amount, holes }));
        },

        // ─ 共通: GameOver ─
        //   自分の topout。相手へ通知し、送出ループ等を止める（リザルトは versusGameOver）。
        gameOver(g) {
          if (!fromMe(g)) return;
          self._sendGameOver();
          self._teardown();
        },
      };
    }

    _sendGameOver() {
      if (this._endedSent) return;
      this._endedSent = true;
      try {
        // result は相手視点（=相手の勝ち=1）。自分が topout したことを伝える。
        this.net.sendGameEvent(Subprotocol.encodeGameOver({ t: this._t(), result: 1 }));
      } catch (_) {}
    }

    // ════════════════════════════════════════════
    // PieceState 30Hz 送出ループ
    // ════════════════════════════════════════════
    _startPieceStateLoop() {
      if (this._psTimer) clearInterval(this._psTimer);
      const interval = Math.round(1000 / PIECE_STATE_HZ);
      this._psTimer = setInterval(() => {
        if (!this.active) return;
        const g = root._game;
        if (!g) return;
        try {
          if (this.myRule === 'puyo') {
            if (g._gs === 'falling') {
              this.net.sendPieceState(Subprotocol.encodePieceStatePuyo({
                t: this._t(), pivotX: g.pivotX, pivotY: g.pivotY, orient: g.targetRot,
              }));
            }
          } else {
            if (g.mino && !g.isCountingDown) {
              this.net.sendPieceState(Subprotocol.encodePieceStateTet({
                t: this._t(), type: g.mino.type, x: g.mino.x, y: g.mino.y, rot: g.mino.rotation,
              }));
            }
          }
        } catch (_) {}
      }, interval);
    }

    // ════════════════════════════════════════════
    // 受信
    // ════════════════════════════════════════════
    _wireNet() {
      const onGameEvent = (data) => { if (this.active) this._onGameEvent(data); };
      const onPieceState = (data) => { if (this.active) this._onPieceState(data); };
      const onChannelClose = (name) => { if (this.active) this._onDisconnect(name); };
      this._netHandlers = { gameEvent: onGameEvent, pieceState: onPieceState, channelclose: onChannelClose };
      this.net.on('gameEvent', onGameEvent);
      this.net.on('pieceState', onPieceState);
      this.net.on('channelclose', onChannelClose);
    }

    // インゲームで相手の DataChannel が切断 → 相手盤面は更新停止。
    // MVP では「相手が落ちた＝自分の勝ち」として対戦を畳む（[[project-online-design]] step6）。
    // ※ WS のアイドルクローズ(wsclose)は DataChannel 生存中なら無害なのでここでは扱わない。
    _onDisconnect() {
      if (!this.active) return;
      this._teardown();
      if (typeof versusGameOver === 'function') versusGameOver('cpu');
    }

    _onPieceState(data) {
      let msg;
      try { msg = Subprotocol.decodePieceState(data, this.oppRule); } catch (_) { return; }
      const opp = this.opp;
      if (msg.rule === 'puyo') {
        opp._gs = 'falling';
        opp.pivotX = msg.pivotX;
        opp.pivotY = msg.pivotY;
        opp.targetRot = msg.orient;
        opp.targetAnimRot = msg.orient;
        opp.animRot = msg.orient;
      } else {
        opp.mino = this._buildTetMino(msg.type, msg.x, msg.y, msg.rot);
      }
      this._renderPuppet();
    }

    _onGameEvent(data) {
      let ev;
      try { ev = Subprotocol.decodeGameEvent(data, this.oppRule); } catch (_) { return; }
      const opp = this.opp;
      switch (ev.kind) {
        case 'spawn':
          if (ev.rule === 'puyo') {
            opp.pivotColor = ev.pivotColor;
            opp.childColor = ev.childColor;
            opp.nextQueue = (ev.next || []).map((p) => [p[0], p[1]]);
            opp._gs = 'falling';
          } else {
            opp.mino = this._buildTetMino(ev.type, COLS_COUNT / 2 - 2, (ev.type === 0 ? -1 : -2), 0);
            opp.nextQueue = (ev.next || []).map((t) => new Mino(t));
          }
          this._renderPuppet();
          break;

        case 'lock':
          if (ev.rule === 'puyo') {
            opp.field = Subprotocol.puyoBoardToField(ev.board);
          } else {
            opp.field = opp.field || new Field();
            opp.field.blocks = Subprotocol.tetBoardToBlocks(ev.board)
              .map((b) => new Block(b.x, b.y, b.type));
          }
          this._renderPuppet();
          break;

        case 'hold':
          if (this.oppRule !== 'puyo') {
            opp.holdMino = this._buildTetMino(ev.heldType, 0, 0, 0);
            this._renderPuppet();
          }
          break;

        case 'garbage':
          this._receiveGarbage(ev.amount, ev.holes || [], this.oppRule === 'puyo');
          break;

        case 'gameover':
          this._onOpponentGameOver();
          break;

        case 'pending':
          // 相手の予告ゲージ（相手に降る火力）をパペット側ゲージへ描画
          this._renderPuppetGauge(ev.ready || 0, ev.unready || 0);
          break;

        case 'clear':
        default:
          // v1 では Clear 演出は未使用（盤面は Lock が権威。puyo 連鎖演出は後続）
          break;
      }
    }

    // 受信ピース → 形状を rot まで回して再現したテト Mino
    _buildTetMino(type, x, y, rot) {
      const m = new Mino(type);
      for (let i = 0; i < (rot & 3); i++) m.rotate();
      m.rotation = rot & 3;
      m.x = x;
      m.y = y;
      return m;
    }

    // ── パペットの描画 ──
    _renderPuppet() {
      const opp = this.opp;
      try {
        if (this.oppRule === 'puyo') {
          if (typeof opp._render === 'function') opp._render();
        } else {
          if (typeof opp.drawAll === 'function') opp.drawAll();
        }
      } catch (_) {}
    }

    // ── 相手パペットの予告ゲージを描画（受信した ready/unready から） ──
    _renderPuppetGauge(ready, unready) {
      if (this.oppRule === 'puyo') {
        // ぷよ: yokoku は合計のみ表示。合成キューを入れて既存の更新を呼ぶ。
        const opp = this.opp;
        const total = ready + unready;
        opp.garbageQueue = total > 0 ? [{ amount: total, ready: true, internal: false, holes: [] }] : [];
        opp._lastYokokuAmount = -1; // 差分キャッシュを無効化して必ず再描画
        if (typeof opp.updateGarbageGauge === 'function') opp.updateGarbageGauge();
      } else {
        // テト: 確定(赤)＋猶予(青) を cpu-garbage-gauge に積む（updateGarbageGauge と同形）
        const el = document.getElementById('cpu-garbage-gauge');
        if (!el) return;
        el.innerHTML = '';
        for (let i = 0; i < ready; i++) {
          const b = document.createElement('div'); b.className = 'gauge-block ready'; el.appendChild(b);
        }
        for (let i = 0; i < unready; i++) {
          const b = document.createElement('div'); b.className = 'gauge-block unready'; el.appendChild(b);
        }
      }
    }

    // ════════════════════════════════════════════
    // GarbageSend 受信 → 自分(window._game)の予告キューへ積む（着弾は既存ロジック）
    //   送信側が受信側ルール向けに amount/holes を算出済みなので変換はしない。
    // ════════════════════════════════════════════
    _receiveGarbage(amount, holes, senderIsPuyo) {
      const g = root._game;
      if (!g || amount <= 0) return;

      if (this.myRule === 'puyo') {
        // ぷよ受け手: internal(非表示)500ms → 青/点滅(ready)。降下は ready && !internal を満たす。
        const obj = { amount, holes: holes.slice(), ready: true, internal: true, internalTimer: 500 };
        g.garbageQueue.push(obj);
        if (typeof g.updateGarbageGauge === 'function') g.updateGarbageGauge();
      } else {
        // テト受け手: ready:false → 猶予タイマーで ready 化（既存 applyGarbage が降らせる）。
        const obj = { amount, holes: holes.slice(), ready: false };
        g.garbageQueue.push(obj);
        if (!g._garbageTimers) g._garbageTimers = [];
        const delay = senderIsPuyo ? 1000 : 1500;
        const entry = { obj, duration: delay, remaining: null, id: null };
        entry.cb = () => {
          entry.id = null;
          if (g.garbageQueue.includes(obj) && obj.amount > 0) {
            obj.ready = true;
            if (typeof g.updateGarbageGauge === 'function') g.updateGarbageGauge();
          }
          const i = g._garbageTimers.indexOf(entry);
          if (i !== -1) g._garbageTimers.splice(i, 1);
        };
        g._garbageTimers.push(entry);
        if (g.isPaused) {
          entry.remaining = delay;
        } else {
          entry.start = performance.now();
          entry.id = setTimeout(entry.cb, delay);
        }
        if (typeof g.updateGarbageGauge === 'function') g.updateGarbageGauge();
      }
    }

    // ════════════════════════════════════════════
    // 終了
    // ════════════════════════════════════════════
    _onOpponentGameOver() {
      if (!this.active) return;
      // 相手が topout → 自分の勝ち。VERSUS のリザルト演出を流用（loser='cpu'）。
      if (typeof versusGameOver === 'function') versusGameOver('cpu');
      this._teardown();
    }

    // 自分が負けたとき（gameOver フック経由で送信済み）の後始末は versusGameOver が行う。
    // ループ等の停止だけ確実に行う。
    _teardown() {
      this.active = false;
      if (this._psTimer) { clearInterval(this._psTimer); this._psTimer = null; }
      // net リスナを解除（再戦で OnlineMatch を作り直してもリスナが累積しないように）
      if (this._netHandlers && this.net) {
        this.net.off('gameEvent', this._netHandlers.gameEvent);
        this.net.off('pieceState', this._netHandlers.pieceState);
        this.net.off('channelclose', this._netHandlers.channelclose);
        this._netHandlers = null;
      }
      if (root.OnlineHooks) root.OnlineHooks = null;
    }

    // 外部（退出・切断）からの強制終了
    abort() {
      this._teardown();
      root._onlineMatch = null;
    }
  }

  root.OnlineMatch = OnlineMatch;
})(typeof window !== "undefined" ? window : globalThis);
