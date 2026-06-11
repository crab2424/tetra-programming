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
  players: [],   // [[id, username], ...]
  maxPlayers: 2,
  queued: false, // ランダムマッチ待機中
};

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
  try {
    if (onlineNet && onlineSession.roomId && onlineNet.isReady) {
      onlineNet.sendJson({ type: 'JSONLeaveRoomRequest', roomId: onlineSession.roomId });
    }
  } catch (_) {}
  _teardownOnlineNet();
  _resetOnlineSession();
  switchPage('main-menu');
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
        _setOnlineStatus('対戦相手が揃いました！（対戦開始は次フェーズで実装予定）', 'ok');
      } else {
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
      infoEl.style.display = '';
      infoEl.innerHTML =
        `<div class="online-room-title">ROOM ${onlineSession.code ? '(' + _escapeHtml(onlineSession.code) + ')' : ''}</div>` +
        `<div class="online-room-players">${names}</div>` +
        `<div class="online-room-count">${count} / ${onlineSession.maxPlayers}</div>`;
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
