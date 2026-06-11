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
      // 相手 SE 用: 直近に受信した PieceState（x/rot の差分から move/rotate を鳴らす）
      this._lastOppPs = null;
      // ぷよ連鎖演出の自前再生用（駆動 rAF と、再生中に届いた Lock 補正盤面の保留）
      this._puppetChainRAF = null;
      this._pendingPuyoLockField = null;
    }

    // ── 相手（パペット）側 SE を鳴らす ──
    //   パペットは実エンジンインスタンス（playSe = SeManager.play）。受信イベント反映時に
    //   明示的に呼ぶことで「相手の操作音」を再生する（VS では両盤面が同時に鳴り得る＝仕様）。
    _oppSe(key) {
      try {
        if (this.opp && typeof this.opp.playSe === 'function') this.opp.playSe(key);
        else if (root.SeManager) root.SeManager.play(key);
      } catch (_) {}
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
        // テト操作SE: 自分の playSe を相手パペットへ離散SEとして転送（move/rotate/drop/harddrop/
        //   lock/lock_hard/hold/ライン消去/tspin）。盤面 Lock スナップショットでは表現できない発音を
        //   即時同期する。未登録キー（gameover/pause/resume 等）は seId 無し＝送らない。
        tetSe(g, key) {
          if (!fromMe(g)) return;
          const seId = Subprotocol.SE_KEY_TO_ID[key];
          if (!seId) return;
          self.net.sendGameEvent(Subprotocol.encodeSe({ t: self._t(), seId }));
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
        // 連鎖直前のペア確定盤面を送る → 受信側パペットが連鎖演出を自前で再生する
        puyoLockChain(g) {
          if (!fromMe(g)) return;
          const board = Subprotocol.buildPuyoBoard(g.field);
          self.net.sendGameEvent(Subprotocol.encodeLockChainPuyo({ t: self._t(), board }));
        },
        // ぷよ設置音: 実際の着地（_fixPuyo / split 着地）の瞬間に相手へ送る（盤面イベントとは独立）。
        //   盤面 Lock/LockChain は固定アニメ後の遅れたタイミングのため、発音だけ別経路で即時同期する。
        puyoFixSe(g) {
          if (!fromMe(g)) return;
          self.net.sendGameEvent(Subprotocol.encodeSe({ t: self._t(), seId: Subprotocol.SE_ID.PUYO_FIX }));
        },
        // クイックドロップの設置音（puyo_drop）。viaQuickDrop では puyo_fix を鳴らさないため、
        //   こちらを独立イベントで相手へ届ける（鳴らさないと相手側で設置音が欠落する）。
        puyoDropSe(g) {
          if (!fromMe(g)) return;
          self.net.sendGameEvent(Subprotocol.encodeSe({ t: self._t(), seId: Subprotocol.SE_ID.PUYO_DROP }));
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
                t: this._t(), pivotX: g.pivotX, pivotY: g.pivotY, orient: g.targetRot, score: g.score || 0,
              }));
            }
          } else {
            if (g.mino && !g.isCountingDown) {
              this.net.sendPieceState(Subprotocol.encodePieceStateTet({
                t: this._t(), type: g.mino.type, x: g.mino.x, y: g.mino.y, rot: g.mino.rotation, score: g.score || 0,
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
      const prev = this._lastOppPs;
      if (msg.rule === 'puyo') {
        opp._gs = 'falling';
        opp.pivotX = msg.pivotX;
        opp.pivotY = msg.pivotY;
        opp.targetRot = msg.orient;
        opp.targetAnimRot = msg.orient;
        opp.animRot = msg.orient;
        // 直前サンプルとの差分で相手の操作音（横移動 / 回転）を鳴らす
        if (prev) {
          if (msg.pivotX !== prev.pivotX) this._oppSe('puyo_move');
          if (msg.orient !== prev.orient) this._oppSe('puyo_rotate');
        }
      } else {
        opp.mino = this._buildTetMino(msg.type, msg.x, msg.y, msg.rot);
        // ※ tet の操作SE（move/rotate 含む）は離散SE(0x0a)で同期するためここでは鳴らさない。
      }
      // 相手スコア表示の同期（落下中も流れる PieceState に載るのでソフトドロップ加点も追従する）。
      if (typeof msg.score === 'number') this._applyOppScore(msg.score);
      this._lastOppPs = msg;
      this._renderPuppet();
    }

    // ── パペットのスコアを反映し、ルールに応じた表示更新を呼ぶ ──
    //   ※ tet の updateStatsDisplay は level/lines（テトでは未同期）も書き換えるため使わず、
    //     score 要素のみを直接更新する。puyo の _updateScoreDisplay は scoreEl だけ触るのでそのまま使う。
    _applyOppScore(score) {
      const opp = this.opp;
      if (!opp) return;
      opp.score = score;
      try {
        if (this.oppRule === 'puyo') {
          if (typeof opp._updateScoreDisplay === 'function') opp._updateScoreDisplay();
        } else {
          const el = document.getElementById(`${opp.statsPrefix || 'cpu'}-score-value`);
          if (el) el.textContent = score;
        }
      } catch (_) {}
    }

    _onGameEvent(data) {
      let ev;
      try { ev = Subprotocol.decodeGameEvent(data, this.oppRule); } catch (_) { return; }
      const opp = this.opp;
      switch (ev.kind) {
        case 'spawn':
          if (ev.rule === 'puyo') {
            // 次ツモ＝前ツモの連鎖が終わった合図。まだ再生中なら確定させてから差し替える。
            if (this._puppetChainRAF) this._finishPuppetChain();
            opp.pivotColor = ev.pivotColor;
            opp.childColor = ev.childColor;
            opp.nextQueue = (ev.next || []).map((p) => [p[0], p[1]]);
            opp._gs = 'falling';
            // 新しいツモ＝連鎖カウント表示をリセット（連鎖数の最大値は維持）
            opp.chainCount = 0;
            if (typeof opp._updateChainDisplay === 'function') opp._updateChainDisplay(0);
          } else {
            opp.mino = this._buildTetMino(ev.type, COLS_COUNT / 2 - 2, (ev.type === 0 ? -1 : -2), 0);
            opp.nextQueue = (ev.next || []).map((t) => new Mino(t));
          }
          // 新しいミノ/ぷよ＝座標がリセットされるので PieceState 差分の誤発火を防ぐ
          this._lastOppPs = null;
          this._renderPuppet();
          break;

        case 'lock':
          if (ev.rule === 'puyo') {
            // 連鎖後＋おじゃま込みの確定盤面（補正）。puyo_fix は lockchain 側で鳴らすのでここでは鳴らさない。
            //   連鎖演出を再生中なら、終わるまで適用を保留して演出を中断しない。
            const field = Subprotocol.puyoBoardToField(ev.board);
            if (this._puppetChainRAF) {
              this._pendingPuyoLockField = field;
            } else {
              opp.field = field;
              this._renderPuppet();
            }
          } else {
            opp.field = opp.field || new Field();
            opp.field.blocks = Subprotocol.tetBoardToBlocks(ev.board)
              .map((b) => new Block(b.x, b.y, b.type));
            // 設置音（lock / lock_hard / harddrop）は離散SE(0x0a)で着地と同時に鳴らすためここでは鳴らさない。
            this._renderPuppet();
          }
          this._lastOppPs = null;
          break;

        case 'hold':
          if (this.oppRule !== 'puyo') {
            opp.holdMino = this._buildTetMino(ev.heldType, 0, 0, 0);
            // hold 音は離散SE(0x0a)で同期するためここでは鳴らさない。
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

        case 'lockchain':
          // ぷよ: 連鎖前の確定盤面。パペットに連鎖演出を自前再生させる。
          //   ※ puyo_fix の発音は SE(0x0a) イベントが着地の瞬間に別途鳴らす（ここでは鳴らさない）。
          if (this.oppRule === 'puyo') {
            const newField = Subprotocol.puyoBoardToField(ev.board);
            // 旧盤面との差分＝今置かれたぷよ。設置の固定振動をパペットでも再現するため拾う。
            const placed = this._diffPlacedCells(opp.field, newField);
            opp.field = newField;
            this._lastOppPs = null;
            this._startPuppetChain(placed);
          }
          break;

        case 'se':
          // 離散SE（発音タイミング同期）。ぷよ=puyo_fix/puyo_drop、テト=操作SE全般（move/rotate/
          //   drop/harddrop/lock/lock_hard/hold/ライン消去/tspin）をこの経路で鳴らす。
          if (ev.seKey) this._oppSe(ev.seKey);
          break;

        case 'clear':
        default:
          // v1 では Clear 演出は未使用（盤面は Lock が権威）
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

    // ── 連鎖演出の自前再生（受信した「連鎖前盤面」から実エンジンのチェーンを駆動） ──
    //   パペットは実 PuyoGame なので、その連鎖状態機械（checkErase→erasing→eraseWait→dropping）
    //   を回せば点滅/連鎖文字/落下/連鎖SEが完全再現される。攻撃送信系は isVersusMode=false で
    //   全て無効化されるため副作用なし。連鎖の終了（消せる組が無い checkErase）を検出して停止し、
    //   その先の「おじゃま降下/次ツモ生成」（盤面外ロジック）には踏み込まない。
    _startPuppetChain(placedCells) {
      const opp = this.opp;
      if (!opp || this.oppRule !== 'puyo') return;
      if (this._puppetChainRAF) { cancelAnimationFrame(this._puppetChainRAF); this._puppetChainRAF = null; }

      // 連鎖再生用にチェーン関連状態を初期化（盤面 opp.field は受信済み・chainMax は累積維持）
      opp._gs = 'checkErase';
      opp.chainCount = 0;
      opp._erasingCells = null;
      opp._dropAnim = null;
      opp.pendingChainGroups = null;
      opp._eraseTimer = 0;
      opp.eraseWaitTimer = 0;
      opp.chainScoreAdd = 0;
      opp.attackScore = 0;
      opp.generatedOjamaTotal = 0;
      opp.isAllClear = false;
      opp.activeAnims = [];
      opp.splitPuyo = null;

      // ── 設置の固定振動演出 ──
      //   今置かれたぷよ（差分）に振動アニメを付け、固定アニメ待ち(fixAnim)を1回挟んでから
      //   連鎖判定(checkErase)に入る＝ローカルと同じ「固定→振動→消去」順を再現する。
      //   盤面がずれて差分が過大なときは振動を諦めて従来どおり checkErase から始める（安全側）。
      if (placedCells && placedCells.length >= 1 && placedCells.length <= 4) {
        for (const cell of placedCells) {
          try { opp._addPuyoAnim(cell.fr, cell.c, 2); } catch (_) {}
        }
        try { opp._beginFixAnimWait(); } catch (_) { opp._gs = 'checkErase'; }
      }

      let last = performance.now();
      const step = () => {
        if (!this.active || this.oppRule !== 'puyo') { this._puppetChainRAF = null; return; }
        // _update を呼ぶ前に「連鎖終了」を検出（checkErase で消せる組が無い）→ ここで停止する。
        if (opp._gs === 'checkErase') {
          let done = true;
          try { const r = opp._findErasable(); done = !r || !r.groups || r.groups.length === 0; } catch (_) { done = true; }
          if (done) { this._finishPuppetChain(); return; }
        }
        const now = performance.now();
        let dt = now - last; last = now;
        if (dt > 100) dt = 100;
        try { opp._update(dt); } catch (_) {}
        this._renderPuppet();
        this._puppetChainRAF = requestAnimationFrame(step);
      };
      this._puppetChainRAF = requestAnimationFrame(step);
    }

    _finishPuppetChain() {
      this._puppetChainRAF = null;
      const opp = this.opp;
      if (opp) {
        opp._gs = 'idle';
        try { if (typeof opp._clearChainTextDOM === 'function') opp._clearChainTextDOM(); } catch (_) {}
        // 連鎖中に届いた Lock(0x02) 補正盤面（おじゃま込み）があれば、ここで反映する。
        if (this._pendingPuyoLockField) {
          opp.field = this._pendingPuyoLockField;
          this._pendingPuyoLockField = null;
        }
      }
      this._renderPuppet();
    }

    _stopPuppetChain() {
      if (this._puppetChainRAF) { cancelAnimationFrame(this._puppetChainRAF); this._puppetChainRAF = null; }
      this._pendingPuyoLockField = null;
      const opp = this.opp;
      if (opp && typeof opp._clearChainTextDOM === 'function') {
        try { opp._clearChainTextDOM(); } catch (_) {}
      }
    }

    // ── 旧盤面 → 新盤面で「新規に出現した通常色ぷよ」のセルを返す（＝今置かれたペア） ──
    //   fr = field 配列の行 index（隠し行を含む）。おじゃま(6)・既存セルは除外。
    //   差分が過大（盤面が大きくずれている）な場合の判定は呼び出し側で行う。
    _diffPlacedCells(oldField, newField) {
      const placed = [];
      if (!newField) return placed;
      for (let r = 0; r < newField.length; r++) {
        const nrow = newField[r];
        const orow = oldField && oldField[r];
        if (!nrow) continue;
        for (let c = 0; c < nrow.length; c++) {
          const nv = nrow[c];
          const ov = (orow && orow[c]) || 0;
          if (nv >= 1 && nv <= 5 && ov === 0) placed.push({ fr: r, c });
        }
      }
      return placed;
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
      this._oppSe('gameover');
      if (typeof versusGameOver === 'function') versusGameOver('cpu');
      this._teardown();
    }

    // 自分が負けたとき（gameOver フック経由で送信済み）の後始末は versusGameOver が行う。
    // ループ等の停止だけ確実に行う。
    _teardown() {
      this.active = false;
      if (this._psTimer) { clearInterval(this._psTimer); this._psTimer = null; }
      this._stopPuppetChain();
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
