// ─────────────────────────────────────────────
// account.js — Discordアカウント連携（ログイン状態の管理・メニューUI）
//
// サーバー側: worker/auth.ts（/api/me, /auth/discord/login, /auth/logout, DELETE /api/me）
// 設計: source_assets/memory/v2.2.2/tetlabo-discord-integration-design.md §6
//
// records.jsとの同期（syncLocalBests・初回取込ダイアログ）はここで実装。
// onlineチケット発行は別フェーズ（P7）で追加する。
// ─────────────────────────────────────────────

(function () {
    // ランキング対象キーは records.js の Records.RANKED_KEYS に集約（worker/records.tsのRANKED_MODESと一致）。
    // records.js は account.js より先に読み込まれるが、参照は呼び出し時に行う。
    function _rankedKeys() {
        return (window.Records && window.Records.RANKED_KEYS) || [];
    }

    // v2.2.3で後からランキング対象に加わったキー。ログイン済みのまま起動した利用者の過去ベストは
    // 自動送信せず、1回だけ取込ダイアログで確認する（ログイン前に出た記録＝共用PCで他人の記録かもしれないため）。
    const LATE_RANKED_KEYS = ['marathon:endless', 'puyo'];
    const LATE_IMPORT_FLAG = 'tetlabo_late_rank_import_v223';

    function _lateImportDone() {
        try { return localStorage.getItem(LATE_IMPORT_FLAG) === '1'; } catch (e) { return true; }
    }

    function _markLateImportDone() {
        try { localStorage.setItem(LATE_IMPORT_FLAG, '1'); } catch (e) { /* 次回また確認されるだけ */ }
    }

    let me = null; // null | { id, name, avatarUrl, isAdmin }
    const listeners = [];
    const recordListeners = []; // pushRecord成功時のイベント購読(結果画面のRANK表示等)
    let prevPageId = null; // アカウント画面を開く直前にアクティブだったFocusNavページ

    function notify() {
        listeners.forEach((cb) => {
            try { cb(me); } catch (e) { console.error(e); }
        });
        _renderChip();
    }

    function onChange(cb) {
        listeners.push(cb);
    }

    // 戻り値: 呼ぶと購読解除する関数
    function onRecordSynced(cb) {
        recordListeners.push(cb);
        return () => {
            const idx = recordListeners.indexOf(cb);
            if (idx !== -1) recordListeners.splice(idx, 1);
        };
    }

    // 結果画面のRANK表示: ランキング対象モードでログイン中のとき、自己ベストの同期結果（順位）が
    // 届いたら rankEl に表示する。結果画面を離れた後に届いても、非表示のまま値をセットするだけで実害はない。
    function watchResultRank(key, rankEl) {
        if (!rankEl || !me || !window.Records || !window.Records.isRanked(key)) return;
        const unsubscribe = onRecordSynced((syncedKey, result) => {
            if (syncedKey !== key) return;
            unsubscribe();
            if (!result || !result.accepted || typeof result.rank !== 'number') return;
            rankEl.textContent = `RANK #${result.rank}`;
            rankEl.style.display = '';
        });
    }

    function _notifyRecordSynced(key, result) {
        recordListeners.forEach((cb) => {
            try { cb(key, result); } catch (e) { console.error(e); }
        });
    }

    async function init() {
        await _refresh();
        await _handleLoginResult();
    }

    async function _refresh() {
        try {
            const res = await fetch('/api/me', { credentials: 'same-origin' });
            const data = await res.json();
            me = (data && data.loggedIn && data.user)
                ? Object.assign({}, data.user, { isAdmin: !!data.isAdmin })
                : null;
        } catch (e) {
            me = null;
        }
        notify();
    }

    // /auth/discord/callback からの戻り(?login=ok|error|banned&return=...)を処理してURLから消す
    async function _handleLoginResult() {
        const url = new URL(location.href);
        const login = url.searchParams.get('login');
        if (!login) {
            // 通常起動時: 後から対象になったモードの過去ベストを1回だけ確認 →
            // 前回の通信失敗で同期し切れなかった記録があれば再送する
            (async () => {
                if (me && !_lateImportDone()) {
                    await _maybeImportLocal(LATE_RANKED_KEYS);
                    _markLateImportDone();
                }
                await syncLocalBests();
            })().catch((e) => console.error(e));
            return;
        }
        // reason: worker/auth.tsがデバッグ用に付ける非機微な短い識別子（トークン等は含まれない）。
        // wrangler tailに頼らずブラウザのコンソールだけで失敗箇所を特定できるようにしている。
        const reason = url.searchParams.get('reason');
        url.searchParams.delete('login');
        url.searchParams.delete('return');
        url.searchParams.delete('reason');
        const qs = url.searchParams.toString();
        history.replaceState(null, '', url.pathname + (qs ? '?' + qs : '') + url.hash);

        if (reason) console.warn('[Account] login failed:', reason);

        if (login === 'banned') {
            window.TetDialog?.choose({
                title: 'LOGIN',
                message: 'このDiscordアカウントはログインできません。',
                buttons: [{ label: 'OK', value: true, kind: 'primary', cancel: true }],
            });
        } else if (login === 'error') {
            window.TetDialog?.choose({
                title: 'LOGIN',
                message: 'ログインに失敗しました。もう一度お試しください。',
                buttons: [{ label: 'OK', value: true, kind: 'primary', cancel: true }],
            });
        } else if (login === 'ok') {
            // 初回取込ダイアログ(★B) → その他の未同期分の通常同期（別アカウント切替時の記録など）
            await _maybeImportLocal(_rankedKeys());
            if (me) _markLateImportDone(); // 全キーを確認済みなので、起動時の追加確認は不要
            await syncLocalBests();
        }
    }

    function login(returnTo) {
        location.href = '/auth/discord/login?return=' + encodeURIComponent(returnTo || 'menu');
    }

    async function logout() {
        try {
            await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
        } catch (e) { /* 通信できなくてもローカルの状態は消す */ }
        me = null;
        notify();
    }

    async function deleteAccount() {
        try {
            const res = await fetch('/api/me', { method: 'DELETE', credentials: 'same-origin' });
            if (!res.ok) return false;
        } catch (e) {
            return false;
        }
        me = null;
        notify();
        return true;
    }

    // ─── online アカウント化: チケット発行（P7b） ─────────────
    // tetra-server(WebRTC signaling)へ渡す短寿命チケットをWorkerに発行してもらう。
    // aud には接続先ホスト名を渡す（設計 v2.2.2 §7.1: なりすまし対策のため）。
    // 未ログイン・通信失敗時はnullを返し、呼び出し側(connection.ts)はゲストとして続行する。
    async function getOnlineTicket(aud) {
        if (!me) return null;
        try {
            const res = await fetch('/api/online-ticket', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ aud }),
            });
            if (!res.ok) return null;
            const data = await res.json();
            return data.ticket || null;
        } catch (e) {
            return null;
        }
    }

    // ─── 記録同期（P4） ─────────────────────────────────────
    // ローカル記録から送信用ペイロードを組み立てる（id/at/schemaVersion/meta/syncedToは内部管理用なので除く）
    function _recordPayload(record) {
        const { id, at, schemaVersion, meta, syncedTo, ...rest } = record;
        return rest;
    }

    function _labelFor(key) {
        return window.Records ? window.Records.labelFor(key) : key.toUpperCase();
    }

    async function pushRecord(key, record, source, playedAt) {
        if (!me) return null;
        try {
            const res = await fetch('/api/records', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    modeKey: key,
                    record,
                    source,
                    playedAt: playedAt || new Date().toISOString(),
                }),
            });
            if (!res.ok) return null;
            const data = await res.json();
            _notifyRecordSynced(key, data);
            return data;
        } catch (e) {
            return null;
        }
    }

    // ランキング対象キーのうち、まだこのアカウントへ送っていないローカル自己ベストを送信する。
    // 通信失敗時はsyncedToが更新されないため、次回のsubmit()/起動時に自然に再送される。
    async function syncLocalBests() {
        if (!me || !window.Records) return;
        const lateDone = _lateImportDone();
        for (const key of _rankedKeys()) {
            const record = window.Records.get(key);
            if (!record) continue;
            if (record.syncedTo === me.id || record.syncedTo === `skip:${me.id}`) continue;
            // 起動時の取込確認がまだ（ダイアログ表示中など）なら、後から対象になったモードの未確認記録は送らない
            if (!lateDone && record.syncedTo === undefined && LATE_RANKED_KEYS.includes(key)) continue;
            const result = await pushRecord(key, _recordPayload(record), 'play', record.at);
            if (result && result.accepted) window.Records.markSynced(key, me.id);
        }
    }

    // 初回取込（★B）: ログイン直後、まだ一度もsyncedToが付いていないローカル自己ベストについて
    // アカウントへの登録可否を1回だけ確認する。NOの場合は'skip:<id>'を付けて以後聞かない
    // （そのベスト自体は再度聞かないが、次にそのモードの自己ベストが更新されたときは
    //   新しいレコードとしてsyncLocalBests()から自動送信される）。
    // keys: 確認対象のランキングキー（ログイン直後は全キー、起動時は LATE_RANKED_KEYS のみ）
    async function _maybeImportLocal(keys) {
        if (!me || !window.Records || !window.TetDialog) return;
        const pending = keys
            .map((key) => ({ key, record: window.Records.get(key) }))
            .filter(({ record }) => record && record.syncedTo === undefined);
        if (pending.length === 0) return;

        const lines = pending
            .map(({ key, record }) => `${_labelFor(key)} ${window.Records.format(key, record)}`)
            .join(' / ');
        const ok = await window.TetDialog.choose({
            title: 'IMPORT RECORDS',
            message: `このブラウザの記録（${lines}）をアカウントに登録しますか？`,
            buttons: [
                { label: 'NO', value: false, kind: 'secondary', cancel: true },
                { label: 'YES', value: true, kind: 'primary' },
            ],
            initial: true,
        });

        if (ok) {
            for (const { key, record } of pending) {
                const result = await pushRecord(key, _recordPayload(record), 'local_import', record.at);
                if (result && result.accepted) window.Records.markSynced(key, me.id);
            }
        } else {
            for (const { key } of pending) window.Records.markSynced(key, `skip:${me.id}`);
        }
    }

    // ─── メニューUI（アカウントチップ・アカウント画面） ─────────────
    function _renderChip() {
        const chip = document.getElementById('account-chip');
        if (!chip) return;
        // /api/me の応答が来るまで隠していたのを解除する（初回_refresh完了後に必ず1回notify()される）。
        chip.classList.remove('is-loading');
        const avatar = document.getElementById('account-chip-avatar');
        const label = document.getElementById('account-chip-label');
        if (me) {
            if (avatar) { avatar.src = me.avatarUrl; avatar.style.display = ''; }
            if (label) label.textContent = me.name;
        } else {
            if (avatar) { avatar.style.display = 'none'; avatar.removeAttribute('src'); }
            if (label) label.textContent = 'LOGIN WITH DISCORD';
        }
    }

    function onChipClick() {
        if (me) openModal(); else login('menu');
    }

    function _renderModal() {
        if (!me) return;
        const avatar = document.getElementById('account-modal-avatar');
        const name = document.getElementById('account-modal-name');
        if (avatar) avatar.src = me.avatarUrl;
        if (name) name.textContent = me.name;
    }

    function openModal() {
        if (!me) return;
        const modal = document.getElementById('account-modal');
        if (!modal) return;
        _renderModal();

        prevPageId = window.FocusNav ? window.FocusNav.getActivePageId() : null;
        modal.classList.add('active');
        if (window.FocusNav) {
            window.FocusNav.register('account-modal', {
                root: modal,
                rootActiveClass: 'active',
                getItems: () => Array.from(modal.querySelectorAll('button')),
                escapeAction: () => document.getElementById('account-modal-close-btn'),
            });
            window.FocusNav.activate('account-modal');
        }
    }

    function closeModal() {
        const modal = document.getElementById('account-modal');
        if (modal) modal.classList.remove('active');
        if (window.FocusNav) {
            window.FocusNav.deactivate();
            if (prevPageId) window.FocusNav.activate(prevPageId);
        }
        prevPageId = null;
    }

    async function logoutFromModal() {
        closeModal();
        await logout();
    }

    // ─── 表示名編集（TETLABO専用。Discordの表示名とは別に上書きできる） ───
    // サーバー側: worker/auth.ts の PUT /api/me/name。空文字を送るとDiscordの表示名に戻る。
    // 名前の重複は許可する（アイコンはDiscordのまま固定なので見分けは付く。設計 §3）。
    async function _updateName(name) {
        try {
            const res = await fetch('/api/me/name', {
                method: 'PUT',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) return { ok: false, reason: data && data.error };
            return { ok: true, name: data && data.name };
        } catch (e) {
            return { ok: false, reason: 'network' };
        }
    }

    async function editName() {
        if (!me || !window.TetDialog) return;
        // 入力はキーボードのみを想定（半角/全角どちらもそのまま通る。専用の仮想キーボードは無し）。
        const result = await window.TetDialog.choose({
            title: 'EDIT NAME',
            message: 'TETLABO内で使う表示名を設定します（空欄で保存するとDiscordの表示名に戻ります）。',
            input: { value: me.name, maxLength: 32, placeholder: 'DISCORDの表示名に戻す' },
            buttons: [
                { label: 'CANCEL', value: false, kind: 'secondary', cancel: true },
                { label: 'SAVE', value: true, kind: 'primary' },
            ],
            initial: true,
        });
        if (!result || !result.value) return;

        const newName = (result.text || '').trim();
        const res = await _updateName(newName);
        if (!res.ok) {
            const message = res.reason === 'invalid_name'
                ? '名前は1〜16文字で入力してください（制御文字は使えません）。'
                : res.reason === 'too_many_requests'
                    ? '変更の間隔が短すぎます。1分ほど空けてもう一度お試しください。'
                    : '変更に失敗しました。通信環境を確認してもう一度お試しください。';
            await window.TetDialog.choose({
                title: 'EDIT NAME',
                message,
                buttons: [{ label: 'OK', value: true, kind: 'primary', cancel: true }],
            });
            return;
        }

        me = Object.assign({}, me, { name: res.name });
        notify();
        _renderModal();
    }

    async function confirmDeleteAccount() {
        if (!window.TetDialog) return;
        const ok = await window.TetDialog.choose({
            title: 'DELETE ACCOUNT',
            message: '退会すると、ランキングの記録もすべて削除されます。元に戻せません。よろしいですか？',
            buttons: [
                { label: 'CANCEL', value: false, kind: 'secondary', cancel: true },
                { label: 'DELETE', value: true, kind: 'danger' },
            ],
            initial: false,
        });
        if (!ok) return;
        closeModal();
        const success = await deleteAccount();
        if (!success) {
            window.TetDialog.choose({
                title: 'DELETE ACCOUNT',
                message: '削除に失敗しました。通信環境を確認してもう一度お試しください。',
                buttons: [{ label: 'OK', value: true, kind: 'primary', cancel: true }],
            });
        }
    }

    window.Account = {
        get me() { return me; },
        init,
        login,
        logout,
        deleteAccount,
        onChange,
        onChipClick,
        closeModal,
        logoutFromModal,
        confirmDeleteAccount,
        editName,
        pushRecord,
        syncLocalBests,
        onRecordSynced,
        watchResultRank,
        getOnlineTicket,
    };

    document.addEventListener('DOMContentLoaded', () => { window.Account.init(); });
})();
