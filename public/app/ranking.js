// ─────────────────────────────────────────────
// ranking.js — RANKINGページ（#ranking-page）の描画
//
// サーバー側: worker/records.ts の GET /api/ranking(+/me)
// 設計: source_assets/memory/v2.2.2/tetlabo-discord-integration-design.md §6.3
//
// 表示は上位100位 + 自分（100位圏外なら最下部に固定表示）。未ログインでも閲覧可。
// Discordの表示名はユーザー入力相当のため、必ずtextContentで描画する（innerHTML禁止）。
// ─────────────────────────────────────────────

(function () {
  const TABS = [
    { key: 'ultra', label: 'ULTRA' },
    { key: 'sprint:40', label: 'SPRINT' },
  ];

  let currentMode = 'ultra';
  let loadToken = 0; // タブ切替中に古い非同期結果が後から描画されるのを防ぐ

  function _labelFor(key) {
    const tab = TABS.find((t) => t.key === key);
    return tab ? tab.label : key.toUpperCase();
  }

  function _formatValue(key, detail) {
    if (!window.Records || !detail) return '—';
    return window.Records.format(key, detail);
  }

  function _formatDate(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  }

  function _renderTabs() {
    document.querySelectorAll('#ranking-mode-toggle .opt-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === currentMode);
    });
  }

  // adminActions: {recordId, userId, userName} を渡すと管理者用のDELETE/BANボタンを追加する（★6.4・最小限UI）
  function _row(rank, user, valueText, dateText, isMine, adminActions) {
    const row = document.createElement('div');
    row.className = 'ranking-row' + (isMine ? ' ranking-row-mine' : '');

    const rankEl = document.createElement('span');
    rankEl.className = 'ranking-rank';
    rankEl.textContent = `#${rank}`;

    const avatarEl = document.createElement('img');
    avatarEl.className = 'ranking-avatar';
    avatarEl.alt = '';
    avatarEl.src = user.avatarUrl;

    const nameEl = document.createElement('span');
    nameEl.className = 'ranking-name';
    nameEl.textContent = user.name;

    const valueEl = document.createElement('span');
    valueEl.className = 'ranking-value';
    valueEl.textContent = valueText;

    const dateEl = document.createElement('span');
    dateEl.className = 'ranking-date';
    dateEl.textContent = dateText;

    row.append(rankEl, avatarEl, nameEl, valueEl, dateEl);

    if (adminActions) {
      const actions = document.createElement('span');
      actions.className = 'ranking-admin-actions';

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'ranking-admin-btn ranking-admin-delete';
      delBtn.textContent = 'DELETE';
      delBtn.onclick = () => _adminDeleteRecord(adminActions.recordId);

      const banBtn = document.createElement('button');
      banBtn.type = 'button';
      banBtn.className = 'ranking-admin-btn ranking-admin-ban';
      banBtn.textContent = 'BAN';
      banBtn.onclick = () => _adminBanUser(adminActions.userId, adminActions.userName);

      actions.append(delBtn, banBtn);
      row.appendChild(actions);
    }

    return row;
  }

  // ── 管理者操作（★6.4: RANKING行の小ボタンから直接操作。詳細調査UIは作らない） ──
  async function _adminDeleteRecord(recordId) {
    if (!window.TetDialog || !recordId) return;
    const ok = await window.TetDialog.choose({
      title: 'DELETE RECORD',
      message: 'この記録を削除しますか？（不正な記録の対処）',
      buttons: [
        { label: 'CANCEL', value: false, kind: 'secondary', cancel: true },
        { label: 'DELETE', value: true, kind: 'danger' },
      ],
      initial: false,
    });
    if (!ok) return;
    try {
      await fetch(`/api/admin/records/${encodeURIComponent(recordId)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
    } catch (e) { /* 失敗しても再描画で現状を反映する */ }
    render(currentMode);
  }

  async function _adminBanUser(userId, userName) {
    if (!window.TetDialog || !userId) return;
    const ok = await window.TetDialog.choose({
      title: 'BAN USER',
      message: `${userName} をBANしますか？ 今後ログイン・記録の提出ができなくなります。`,
      buttons: [
        { label: 'CANCEL', value: false, kind: 'secondary', cancel: true },
        { label: 'BAN', value: true, kind: 'danger' },
      ],
      initial: false,
    });
    if (!ok) return;
    try {
      await fetch(`/api/admin/users/${encodeURIComponent(userId)}/ban`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ banned: true }),
      });
    } catch (e) { /* 失敗しても再描画で現状を反映する */ }
    render(currentMode);
  }

  function _updateLoginHint() {
    const hint = document.getElementById('ranking-login-hint');
    if (hint) hint.style.display = (window.Account && window.Account.me) ? 'none' : '';
    if (window.FocusNav) window.FocusNav.refresh();
  }

  async function render(mode) {
    currentMode = mode;
    _renderTabs();
    _updateLoginHint();

    const listEl = document.getElementById('ranking-list');
    const statusEl = document.getElementById('ranking-status');
    if (!listEl) return;

    const token = ++loadToken;
    listEl.innerHTML = ''; // 一覧全体の再構築（DOM生成中なので安全）
    if (statusEl) { statusEl.textContent = '読み込み中…'; statusEl.style.display = ''; }

    let data = null;
    try {
      const res = await fetch(`/api/ranking?mode=${encodeURIComponent(mode)}`, { credentials: 'same-origin' });
      if (res.ok) data = await res.json();
    } catch (e) { /* below: dataがnullのまま失敗表示 */ }
    if (token !== loadToken) return; // タブが切り替わっていたら古い結果は捨てる

    if (!data || !Array.isArray(data.entries)) {
      if (statusEl) { statusEl.textContent = 'ランキングの取得に失敗しました。'; statusEl.style.display = ''; }
      return;
    }
    if (statusEl) statusEl.style.display = 'none';

    const myId = window.Account && window.Account.me ? window.Account.me.id : null;
    const isAdmin = !!(window.Account && window.Account.me && window.Account.me.isAdmin);
    let myEntryInTop = false;
    data.entries.forEach((entry) => {
      const isMine = !!myId && entry.user.id === myId;
      if (isMine) myEntryInTop = true;
      const adminActions = isAdmin
        ? { recordId: entry.recordId, userId: entry.user.id, userName: entry.user.name }
        : null;
      listEl.appendChild(_row(entry.rank, entry.user, _formatValue(mode, entry.detail), _formatDate(entry.playedAt), isMine, adminActions));
    });

    if (data.entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'ranking-empty';
      empty.textContent = 'まだ記録がありません。';
      listEl.appendChild(empty);
    }

    // 自分が100位圏外なら、自分の行だけ追加取得して最下部に固定表示（★C）
    if (myId && !myEntryInTop) {
      try {
        const meRes = await fetch(`/api/ranking/me?mode=${encodeURIComponent(mode)}`, { credentials: 'same-origin' });
        const meData = meRes.ok ? await meRes.json() : null;
        if (token !== loadToken) return;
        if (meData && meData.hasRecord) {
          const sep = document.createElement('div');
          sep.className = 'ranking-row-sep';
          listEl.appendChild(sep);
          const myAdminActions = isAdmin
            ? { recordId: meData.recordId, userId: myId, userName: window.Account.me.name }
            : null;
          listEl.appendChild(_row(
            meData.rank,
            { id: myId, name: window.Account.me.name, avatarUrl: window.Account.me.avatarUrl },
            _formatValue(mode, meData.detail),
            _formatDate(meData.playedAt),
            true,
            myAdminActions,
          ));
        }
      } catch (e) { /* 失敗しても上位表示は壊さない */ }
    }

    if (window.FocusNav) window.FocusNav.refresh();
  }

  function setRankingMode(mode) {
    if (mode === currentMode) return;
    render(mode);
  }

  function renderRankingPage() {
    render(currentMode);
  }

  // ログイン状態が変わったら（RANKINGページを開いたまま）再描画してハイライト・ヒントを更新
  if (window.Account && window.Account.onChange) {
    window.Account.onChange(() => {
      if (window.FocusNav && window.FocusNav.getActivePageId() === 'ranking') render(currentMode);
      else _updateLoginHint();
    });
  }

  window.setRankingMode = setRankingMode;
  window.renderRankingPage = renderRankingPage;
})();
