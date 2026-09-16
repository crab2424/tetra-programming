// ─────────────────────────────────────────────
// account.js — Discordアカウント連携（ログイン状態の管理・メニューUI）
//
// サーバー側: worker/auth.ts（/api/me, /auth/discord/login, /auth/logout, DELETE /api/me）
// 設計: source_assets/memory/v2.2.2/tetlabo-discord-integration-design.md §6
//
// records.jsとの同期（syncLocalBests・初回取込ダイアログ）とonlineチケット発行は
// 別フェーズ（P4/P7）で追加する。ここではログイン状態の保持とメニューUIのみ。
// ─────────────────────────────────────────────

(function () {
    let me = null; // null | { id, name, avatarUrl, isAdmin }
    const listeners = [];
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

    async function init() {
        await _refresh();
        _handleLoginResult();
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
    function _handleLoginResult() {
        const url = new URL(location.href);
        const login = url.searchParams.get('login');
        if (!login) return;
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

    // ─── メニューUI（アカウントチップ・アカウント画面） ─────────────
    function _renderChip() {
        const chip = document.getElementById('account-chip');
        if (!chip) return;
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

    function openModal() {
        if (!me) return;
        const modal = document.getElementById('account-modal');
        if (!modal) return;
        const avatar = document.getElementById('account-modal-avatar');
        const name = document.getElementById('account-modal-name');
        if (avatar) avatar.src = me.avatarUrl;
        if (name) name.textContent = me.name;

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
    };

    document.addEventListener('DOMContentLoaded', () => { window.Account.init(); });
})();
