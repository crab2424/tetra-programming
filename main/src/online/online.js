// ─────────────────────────────────────────────────────────────
// online/online.js — オンライン対戦のロビー/マッチング制御
//
// ONLINE ページの UI を駆動する（versus.js のオンライン版に相当）。
//   接続 → ルーム作成 / コード参加 / ランダムマッチ → 2 人が揃ってロビー成立、まで。
// 対戦中のゲーム同期（相手パペット描画・送信フック・GarbageSend 反映）は次フェーズ。
//
// 依存: OnlineNet（net.js）・switchPage（navigation.js）。実行時参照。
// ─────────────────────────────────────────────────────────────

// ── 状態 ──
let onlineNet = null;
let onlineMyRule = 'tet'; // 対戦時の自分のルール（次フェーズの GameStart 交渉用に保持）
const onlineSession = {
  roomId: null,
  roomName: null,
  code: null,
  players: [],   // [[id, username, rule], ...]
  maxPlayers: 2,
  queued: false, // ランダムマッチ待機中
};

// 開始/再戦の準備状態（クライアント間の READY ハンドシェイク）。
//   両者が READY を出したら、それぞれが送り合った seed を XOR した共有シードで対戦開始。
//   これで「先に押した側が待つ／後押し側の到着で同時開始」が成立する（ずれ≒片道遅延）。
const onlineReady = { mine: false, opp: false, mySeed: 0, oppSeed: 0 };

const $online = (id) => document.getElementById(id);
function _onlineUsername() {
  const v = ($online('online-username')?.value || '').trim();
  return v || 'player';
}

// ── 画面遷移 ──
function goToOnline() {
  switchPage('online');
  _resetOnlineSession();
  _ensureOnlineNet();
  _connectOnline();
  _renderOnline();
}

function leaveOnlineAndBack() {
  try { if (window._onlineMatch) window._onlineMatch.abort(); } catch (_) {}
  try {
    if (onlineNet && onlineSession.roomId && onlineNet.isReady) {
      onlineNet.sendJson({ type: 'JSONLeaveRoomRequest', roomId: onlineSession.roomId });
    }
  } catch (_) {}
  _teardownOnlineNet();
  _resetOnlineSession();
  switchPage('main-menu');
}

// ── 対戦開始 / 再戦（step6: クライアント間 READY ハンドシェイクで同時開始） ──
function _onlineOpponentRule() {
  const ps = onlineSession.players || [];
  const other = ps.find((p) => (p[2] === 'tet' || p[2] === 'puyo') && p[2] !== onlineMyRule);
  if (other) return other[2];
  return onlineMyRule; // 同ルール同士、または rule 情報なし
}

function _onlineOpponentName() {
  const myName = _onlineUsername();
  const ps = onlineSession.players || [];
  // 相手＝自分と名前が異なるプレイヤー（無ければ rule が異なるプレイヤー）
  const oppEntry = ps.find((p) => p[1] !== myName) || ps.find((p) => p[2] !== onlineMyRule);
  return (oppEntry && oppEntry[1]) || 'OPPONENT';
}

function _resetOnlineReady() {
  onlineReady.mine = false;
  onlineReady.opp = false;
  onlineReady.mySeed = 0;
  onlineReady.oppSeed = 0;
}

// 「対戦開始 / REMATCH」押下。準備完了を相手へ通知し、両者そろうまで待つ。
function onlineReadyUp() {
  if (!onlineNet || !onlineNet.isReady) return;
  if (!onlineSession.players || onlineSession.players.length < 2) return;
  if (window._onlineMatch && window._onlineMatch.active) return;
  if (typeof OnlineMatch === 'undefined' || typeof Subprotocol === 'undefined') return;
  if (onlineReady.mine) return; // 二度押し防止
  onlineReady.mine = true;
  onlineReady.mySeed = (Math.floor(Math.random() * 0x100000000)) >>> 0;
  onlineNet.sendGameEvent(Subprotocol.encodeControl({
    action: Subprotocol.CTRL.READY, seed: onlineReady.mySeed,
  }));
  _setOnlineStatus('準備完了。相手の準備を待っています…', 'info');
  _maybeStartOnlineMatch();
  _renderOnline();
}

// 相手から届いた CONTROL（ロビー段の永続リスナ経由）。
function _onLobbyGameEvent(data) {
  if (!data || data.length === 0) return;
  if (data[0] !== Subprotocol.EV.CONTROL) return; // ゲーム中のイベントは OnlineMatch が処理
  let ev;
  try { ev = Subprotocol.decodeGameEvent(data, onlineMyRule); } catch (_) { return; }
  if (ev.kind !== 'control') return;
  if (ev.action === Subprotocol.CTRL.READY) {
    onlineReady.opp = true;
    onlineReady.oppSeed = ev.seed >>> 0;
    _maybeStartOnlineMatch();
    _renderOnline();
  } else if (ev.action === Subprotocol.CTRL.UNREADY) {
    onlineReady.opp = false;
    _renderOnline();
  }
}

// 両者 READY がそろったら共有シードを確定して対戦開始。
function _maybeStartOnlineMatch() {
  if (!(onlineReady.mine && onlineReady.opp)) return;
  if (window._onlineMatch && window._onlineMatch.active) return;
  if (typeof OnlineMatch === 'undefined') return;
  const seed = ((onlineReady.mySeed ^ onlineReady.oppSeed) >>> 0) || 1;
  const myRule = onlineMyRule;
  const oppRule = _onlineOpponentRule();
  const myName = _onlineUsername();
  const oppName = _onlineOpponentName();
  _resetOnlineReady(); // 次ラウンド（再戦）のために戻す
  window._onlineMatch = new OnlineMatch(onlineNet, myRule, oppRule, myName, oppName, seed);
  window._onlineMatch.begin();
}

// ── リザルト画面からの導線（CPU versus へ抜けないようにオンライン用に分岐） ──
// REMATCH: ロビーへ戻り、そのまま再戦の準備完了を送る（相手も REMATCH すれば同時開始）。
function onlineRematchFromResult() {
  switchPage('online');
  _renderOnline();
  onlineReadyUp();
}
// ロビーへ戻る（在室のまま）。
function onlineBackToLobbyFromResult() {
  _resetOnlineReady();
  switchPage('online');
  _renderOnline();
}

function setOnlineRule(rule) {
  onlineMyRule = rule;
  $online('online-rule-tet')?.classList.toggle('active', rule === 'tet');
  $online('online-rule-puyo')?.classList.toggle('active', rule === 'puyo');
}

// ── 接続 ──
function _ensureOnlineNet() {
  if (onlineNet) return;
  onlineNet = new OnlineNet();
  onlineNet.on('state', () => _renderOnline());
  onlineNet.on('ready', () => { _setOnlineStatus('接続完了。ルームを作成 / 参加できます。', 'ok'); _renderOnline(); });
  onlineNet.on('json', (msg) => _onOnlineJson(msg));
  // ロビー段の CONTROL（READY/UNREADY）を常時受ける永続リスナ。
  //   対戦中は OnlineMatch も gameEvent を購読するが、互いにサブタグで棲み分ける。
  onlineNet.on('gameEvent', (data) => _onLobbyGameEvent(data));
  onlineNet.on('wserror', () => _setOnlineStatus('サーバーに接続できません（起動中か確認してください）。', 'err'));
  onlineNet.on('wsclose', () => { _renderOnline(); });
  onlineNet.on('error', (e) => console.warn('[online] net error', e));
}

function _connectOnline() {
  if (!onlineNet) return;
  if (onlineNet.isReady) return;
  _setOnlineStatus('サーバーに接続中…', 'info');
  onlineNet.connect();
}

function onlineReconnect() {
  _teardownOnlineNet();
  _resetOnlineSession();
  _ensureOnlineNet();
  _connectOnline();
  _renderOnline();
}

function _teardownOnlineNet() {
  if (onlineNet) { try { onlineNet.close(); } catch (_) {} }
  onlineNet = null;
}

function _resetOnlineSession() {
  onlineSession.roomId = null;
  onlineSession.roomName = null;
  onlineSession.code = null;
  onlineSession.players = [];
  onlineSession.maxPlayers = 2;
  onlineSession.queued = false;
  _resetOnlineReady();
  const codeEl = $online('online-mycode');
  if (codeEl) codeEl.textContent = '';
}

// ── マッチング操作 ──
function onlineCreateRoom() {
  if (!onlineNet || !onlineNet.isReady) return;
  const name = _onlineUsername();
  onlineNet.sendJson({
    type: 'JSONCreateRoomRequest',
    roomName: name + "'s room",
    maxPlayers: 2,
    password: null,
    tags: [],
    username: name,
    rule: onlineMyRule,
  });
  _setOnlineStatus('ルーム作成中…', 'info');
}

function onlineJoinByCode() {
  if (!onlineNet || !onlineNet.isReady) return;
  // コードは数字6桁（サーバーが数字のみ生成）。数字以外は除去する。
  const code = ($online('online-code-input')?.value || '').replace(/\D/g, '').slice(0, 6);
  if (code.length !== 6) { _setOnlineStatus('6桁の数字コードを入力してください。', 'err'); return; }
  onlineNet.sendJson({
    type: 'JSONJoinByCodeRequest',
    code,
    password: null,
    username: _onlineUsername(),
    rule: onlineMyRule,
  });
  _setOnlineStatus('コードで参加中…', 'info');
}

function onlineRandomMatch() {
  if (!onlineNet || !onlineNet.isReady) return;
  onlineSession.queued = true;
  onlineNet.sendJson({ type: 'JSONJoinRandomMatchRequest', username: _onlineUsername(), rule: onlineMyRule });
  _setOnlineStatus('ランダムマッチ待機中…（相手を探しています）', 'info');
  _renderOnline();
}

function onlineCancelRandom() {
  if (!onlineNet || !onlineNet.isReady) return;
  onlineNet.sendJson({ type: 'JSONCancelRandomMatchRequest' });
}

function onlineLeaveRoom() {
  if (!onlineNet || !onlineNet.isReady || !onlineSession.roomId) return;
  onlineNet.sendJson({ type: 'JSONLeaveRoomRequest', roomId: onlineSession.roomId });
}

// ── サーバー応答ハンドリング ──
function _onOnlineJson(msg) {
  switch (msg.type) {
    case 'JSONCreateRoomResponse':
      onlineSession.roomId = msg.roomId;
      onlineSession.code = msg.code;
      onlineSession.queued = false;
      _setOnlineStatus('ルーム作成完了。相手のコード参加を待っています。', 'ok');
      break;

    case 'JSONJoinByCodeResponse':
      if (msg.success) {
        onlineSession.roomId = msg.roomId;
        onlineSession.queued = false;
        _setOnlineStatus('ルームに参加しました。', 'ok');
      } else {
        _setOnlineStatus('コード参加に失敗: ' + (msg.message || '不明なエラー'), 'err');
      }
      break;

    case 'JSONJoinRandomMatchResponse':
      if (msg.matched) {
        onlineSession.roomId = msg.roomId;
        onlineSession.queued = false;
        _setOnlineStatus('ランダムマッチ成立！', 'ok');
      } else {
        onlineSession.queued = true;
        _setOnlineStatus('ランダムマッチ待機中…（相手を探しています）', 'info');
      }
      break;

    case 'JSONCancelRandomMatchResponse':
      onlineSession.queued = false;
      _setOnlineStatus(msg.success ? 'ランダムマッチをキャンセルしました。' : '待機列にいませんでした。', 'info');
      break;

    case 'JSONRoomInfoNotification':
      onlineSession.roomId = msg.roomId;
      onlineSession.roomName = msg.roomName;
      onlineSession.players = Array.isArray(msg.players) ? msg.players : [];
      onlineSession.maxPlayers = msg.maxPlayers || 2;
      onlineSession.queued = false;
      if (onlineSession.players.length >= 2) {
        _setOnlineStatus('対戦相手が揃いました！「対戦開始」で準備完了を送れます。', 'ok');
      } else {
        // 相手不在になったら準備状態はリセット
        _resetOnlineReady();
        _setOnlineStatus('ルームで相手を待っています…', 'info');
      }
      break;

    case 'JSONLeaveRoomResponse':
      _resetOnlineSession();
      _setOnlineStatus('ルームを退出しました。', 'info');
      break;

    case 'JSONRoomLeaveNotification':
      // 相手が退出した
      onlineSession.players = Array.isArray(msg.players) ? msg.players : onlineSession.players.slice(0, 1);
      _resetOnlineReady();
      // 対戦中に相手が退出した場合は対戦を畳む（自分の勝ち扱い）
      if (window._onlineMatch && window._onlineMatch.active) {
        try { window._onlineMatch._onDisconnect(); } catch (_) {}
      }
      _setOnlineStatus('相手が退出しました。', 'info');
      break;

    default:
      // GetRooms など未使用メッセージは無視
      break;
  }
  _renderOnline();
}

// ── 描画 ──
function _setOnlineStatus(text, cls) {
  const el = $online('online-status');
  if (!el) return;
  el.textContent = text;
  el.style.color = cls === 'err' ? 'var(--danger)'
    : cls === 'ok' ? 'var(--success)'
    : 'var(--text-dim)';
}

function _renderOnline() {
  const ready = !!(onlineNet && onlineNet.isReady);
  const inRoom = !!onlineSession.roomId;
  const queued = !!onlineSession.queued;

  // 接続状態の表示（status は応答ハンドラ側でも更新する）
  if (onlineNet) {
    if (onlineNet.state === 'error' || onlineNet.state === 'closed') {
      _setOnlineStatus('未接続。RECONNECT を押してください。', 'err');
    } else if (!ready && onlineNet.state !== 'idle') {
      _setOnlineStatus('サーバーに接続中…', 'info');
    }
  }

  const set = (id, disabled) => { const el = $online(id); if (el) el.disabled = disabled; };
  // 作成/参加/ランダムは「接続済み・未入室・未待機」のときのみ
  const canMatch = ready && !inRoom && !queued;
  set('online-create-btn', !canMatch);
  set('online-joincode-btn', !canMatch);
  set('online-code-input', !canMatch);
  set('online-random-btn', !canMatch);
  set('online-cancel-btn', !(ready && queued));
  set('online-leave-btn', !(ready && inRoom));

  // RECONNECT は未接続時のみ表示
  const reconnectBtn = $online('online-reconnect-btn');
  if (reconnectBtn) {
    const showReconnect = !!onlineNet && (onlineNet.state === 'error' || onlineNet.state === 'closed');
    reconnectBtn.style.display = showReconnect ? '' : 'none';
  }

  // 作成コードの表示
  const codeEl = $online('online-mycode');
  if (codeEl) codeEl.textContent = onlineSession.code ? ('CODE: ' + onlineSession.code) : '';

  // ルーム情報
  const infoEl = $online('online-room-info');
  if (infoEl) {
    if (inRoom) {
      // 各プレイヤーを「名前 + ルールバッジ(TET/PUYO)」で表示し、対戦前に相手のルールを知れるようにする
      const names = onlineSession.players.length
        ? onlineSession.players.map((p) => _playerBadge(p[1], p[2])).join('<span class="online-vs">vs</span>')
        : '(自分のみ)';
      // 在室中は最低でも自分が居るため 0 ではなく 1 から数える
      const count = Math.max(onlineSession.players.length, 1);
      // 2 人揃ったら対戦開始ボタンを出す（READY ハンドシェイクで両者そろい次第 同時開始）
      const canStart = onlineSession.players.length >= 2;
      let readyLine = '';
      let startBtn = '';
      if (canStart) {
        const myTxt = onlineReady.mine ? 'あなた: 準備OK' : 'あなた: 未準備';
        const oppTxt = onlineReady.opp ? '相手: 準備OK' : '相手: 準備中…';
        readyLine = `<div class="online-ready-status">${_escapeHtml(myTxt)} ／ ${_escapeHtml(oppTxt)}</div>`;
        if (onlineReady.mine) {
          startBtn = `<button class="menu-btn btn-primary online-start-btn" style="margin-top:10px;" disabled><span class="menu-btn-icon">⏳</span><span>相手を待っています…</span></button>`;
        } else {
          const label = onlineReady.opp ? '対戦開始（相手は準備OK）' : '対戦開始';
          startBtn = `<button class="menu-btn btn-primary online-start-btn" style="margin-top:10px;" onclick="onlineReadyUp()"><span class="menu-btn-icon">⚔</span><span>${_escapeHtml(label)}</span></button>`;
        }
      }
      infoEl.style.display = '';
      infoEl.innerHTML =
        `<div class="online-room-title">ROOM ${onlineSession.code ? '(' + _escapeHtml(onlineSession.code) + ')' : ''}</div>` +
        `<div class="online-room-players">${names}</div>` +
        `<div class="online-room-count">${count} / ${onlineSession.maxPlayers}</div>` +
        readyLine +
        startBtn;
    } else {
      infoEl.style.display = 'none';
      infoEl.innerHTML = '';
    }
  }
}

// 名前＋ルールバッジ（rule は 'tet' | 'puyo'。不明時は省略）
function _playerBadge(name, rule) {
  const r = (rule === 'tet' || rule === 'puyo') ? rule : '';
  const badge = r
    ? `<span class="online-rule-badge online-rule-${r}">${r.toUpperCase()}</span>`
    : '';
  return `<span class="online-player">${_escapeHtml(name)}${badge}</span>`;
}

function _escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
