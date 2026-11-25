// ─────────────────────────────────────────────
// replays.js — リプレイの保存・REPLAYS 画面・エクスポート/インポート（録画 M6）
//
// 設計: source_assets/memory/record/tetlabo-record-design.md §6・§9
//   ・保存: 最後まで遊んだ試合は IndexedDB（tetlabo-replays）に自動保存（core/replay.js の ReplayManager.onRecorded）。
//     設定の DISPLAY › REPLAY AUTO SAVE が OFF なら自動では残さず、リザルトの SAVE で残す
//     （最高記録を更新したリプレイと CLIP は OFF でも残す。UI 設計書 tetlabo-record-ui-design.md §6）。
//     直近 30 本を残して古いものから消す（並びは保存した時刻。インポートしたものも同じ）。
//     ★を付けたもの・最高記録に結び付いたもの（keepFor）・クリップは消さない。
//   ・最高記録: records.js の記録の meta.replayId にリプレイを結び付け、準備画面の BEST の下から見られる。
//   ・枝（PLAY HERE で遊んだ VERSUS の続き）は 1 本のリプレイにまとめる: 親のリプレイの data.branches に、親と同じ頭を除いた
//     後ろだけ（core/replay.js の replayBranchNode）で入れる。枝の枝も同じ（木）。1 階層 30 本（REPLAY_BRANCH_MAX。設定の
//     REPLAY BRANCH MULTI SAVE が OFF なら 1 本＝最新だけ・★の枝は別に残す）を超えたら
//     ★の無い古い枝から消す。一覧には親の 1 行だけ（BRANCH n の札）。見るのは再生中の印の画面（枝の印・OPEN ▶ / ◀ PARENT）。
//     親が保存されていなければ親ごと保存する。親が見つからない古い形の枝は今までどおり 1 本で保存する。
//   ・ファイル: 1 本 = 1 ファイル（.tlreplay＝JSON を gzip。CompressionStream が無ければ JSON のまま）。
//     インポートは形・版・大きさを確かめ、壊れたファイルでは止まらずにメッセージを出す。
// ─────────────────────────────────────────────

const REPLAY_KEEP_COUNT = 30;
const REPLAY_FILE_MAX = 20 * 1024 * 1024;     // ファイルの大きさの上限
const REPLAY_TEXT_MAX = 64 * 1024 * 1024;     // 解凍後の大きさの上限

const ReplayStore = (() => {
    let dbp = null;
    const open = () => {
        if (dbp) return dbp;
        dbp = new Promise((resolve, reject) => {
            if (!window.indexedDB) { reject(new Error('IndexedDB が使えません')); return; }
            const req = indexedDB.open('tetlabo-replays', 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('replays')) db.createObjectStore('replays', { keyPath: 'id' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        dbp.catch(() => { dbp = null; });
        return dbp;
    };
    const tx = async (mode, fn) => {
        const db = await open();
        return new Promise((resolve, reject) => {
            const t = db.transaction('replays', mode);
            const st = t.objectStore('replays');
            let out;
            const r = fn(st);
            if (r) r.onsuccess = () => { out = r.result; };
            t.oncomplete = () => resolve(out);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error);
        });
    };

    // 1 件 = { id, savedAt, star, keepFor: [記録のキー], imported, data }
    //   枝（data.branch.cut あり）は親の中へ（addBranch）。opts.parentData: 親がまだ保存されていないときに親ごと残す
    async function save(data, opts = {}) {
        if (data && data.branch && data.branch.cut && data.branch.rootId) return addBranch(data, opts);
        return saveRaw(data, opts);
    }

    async function saveRaw(data, opts = {}) {
        const prev = await getRaw(data.id);
        const item = prev || { id: data.id, savedAt: Date.now(), star: false, keepFor: [], imported: !!opts.imported, data };
        item.data = data;
        await tx('readwrite', (st) => st.put(item));
        await prune();
        return item;
    }

    function getRaw(id) {
        if (!id) return Promise.resolve(null);
        return tx('readonly', (st) => st.get(id)).then((x) => x || null);
    }

    // 木の中から id の枝を探す。{ node, list（その枝が入っている配列）, chain（一番上から親までの枝） }
    function findNode(list, id, chain = []) {
        for (const n of (list || [])) {
            if (!n) continue;
            if (n.id === id) return { node: n, list, chain };
            const f = findNode(n.branches, id, chain.concat([n]));
            if (f) return f;
        }
        return null;
    }

    // id が枝なら、入っている一番上のリプレイ（保存した 1 件）と枝を返す
    async function findBranch(id) {
        const all = (await tx('readonly', (st) => st.getAll())) || [];
        for (const it of all) {
            const f = it.data && findNode(it.data.branches, id);
            if (f) return Object.assign({ root: it }, f);
        }
        return null;
    }

    // 枝の 1 本のリプレイ（親の頭とつなぎ直したもの）
    function branchData(root, f) {
        let d = root.data;
        for (const n of f.chain.concat([f.node])) d = replayBranchFull(d, n);
        return d;
    }

    // 1 件。枝の id なら { id, star, keepFor: [], data: つなぎ直した 1 本, branchOf: 一番上の id }
    async function get(id) {
        const it = await getRaw(id);
        if (it || !id) return it;
        const f = await findBranch(id);
        if (!f) return null;
        return { id, savedAt: f.node.savedAt || f.root.savedAt, star: !!f.node.star, keepFor: [], imported: false, data: branchData(f.root, f), branchOf: f.root.id };
    }

    // 枝を親の中へ入れる（1 階層 REPLAY_BRANCH_MAX 本まで。超えたら★の無い古い枝から消す）
    async function addBranch(full, opts = {}) {
        const b = full.branch;
        const parentData = opts.parentData || (window.ReplayManager && ReplayManager._branchParent) || null;
        let root = await getRaw(b.rootId);
        if (!root) {
            // 親（一番上）がまだ無い: 手元の親が一番上なら親ごと保存。それ以外（枝の枝で途中が無い）は 1 本で保存
            if (parentData && parentData.id === b.rootId && !parentData.branch) {
                const rd = Object.assign({}, parentData);
                root = await saveRaw(rd, opts.parentOpts || {});
            } else {
                return saveRaw(full, opts);
            }
        }
        const rd = root.data;
        let list;
        if (b.parentId === rd.id) {
            list = Array.isArray(rd.branches) ? rd.branches : (rd.branches = []);
        } else {
            const f = findNode(rd.branches, b.parentId);
            if (!f) return saveRaw(full, opts);
            list = Array.isArray(f.node.branches) ? f.node.branches : (f.node.branches = []);
        }
        const at = list.findIndex((n) => n && n.id === full.id);
        const node = replayBranchNode(full);
        node.savedAt = Date.now();
        node.star = at >= 0 ? !!list[at].star : false;
        if (at >= 0) {
            node.branches = list[at].branches || [];
            node.savedAt = list[at].savedAt || node.savedAt;
            list[at] = node;
        } else {
            list.push(node);
        }
        const limit = replayBranchLimit();
        while (list.length > limit) {
            let drop = -1;
            list.forEach((n, i) => {
                if (n.id === node.id || n.star || hasStarBranch(n.branches)) return; // ★の枝（子・孫も）は残す
                if (drop < 0 || (n.savedAt || 0) < (list[drop].savedAt || 0)) drop = i;
            });
            if (drop < 0) break;
            list.splice(drop, 1);
        }
        if (limit === REPLAY_BRANCH_MAX && list.length > REPLAY_BRANCH_MAX) {
            // 全部★: 新しい枝は入れない（MULTI SAVE OFF のときは★の枝は数に入れず、新しい 1 本を必ず残す）
            list.splice(list.indexOf(node), 1);
            if (typeof showGlobalToast === 'function') showGlobalToast(`枝が ${REPLAY_BRANCH_MAX} 本（全部★）あるので保存できませんでした`);
            return null;
        }
        root.savedAt = Date.now(); // 枝を足した親は新しく触った物として扱う（30 本の数え方）
        await tx('readwrite', (st) => st.put(root));
        await prune();
        if (window.ReplayManager && ReplayManager.onBranchSaved) ReplayManager.onBranchSaved(b.parentId, node);
        return { id: full.id, savedAt: node.savedAt, star: node.star, keepFor: [], imported: false, data: full, branchOf: root.id };
    }

    // id のリプレイのデータ（枝ならつなぎ直した 1 本）
    async function findData(id) {
        const it = await get(id);
        return it ? it.data : null;
    }

    async function list() {
        const all = (await tx('readonly', (st) => st.getAll())) || [];
        all.sort((a, b) => b.savedAt - a.savedAt);
        return all;
    }

    function remove(id) {
        return tx('readwrite', (st) => st.delete(id));
    }

    async function update(id, fn) {
        const item = await getRaw(id);
        if (!item) {
            // 枝: ★だけを変えられる
            const f = await findBranch(id);
            if (!f) return null;
            const view = { id, star: !!f.node.star, keepFor: [] };
            fn(view);
            f.node.star = !!view.star;
            await tx('readwrite', (st) => st.put(f.root));
            await prune();
            return { id, savedAt: f.node.savedAt, star: f.node.star, keepFor: [], imported: false, data: null, branchOf: f.root.id };
        }
        fn(item);
        await tx('readwrite', (st) => st.put(item));
        await prune();
        return item;
    }

    const hasStarBranch = (list) => (list || []).some((n) => n && (n.star || hasStarBranch(n.branches)));
    const isKept = (it) => it.star || (it.keepFor && it.keepFor.length) || (it.data && it.data.clip) || (it.data && hasStarBranch(it.data.branches));

    // 直近 30 本（守るものを除く）を残す
    async function prune() {
        const all = (await tx('readonly', (st) => st.getAll())) || [];
        const loose = all.filter((it) => !isKept(it)).sort((a, b) => b.savedAt - a.savedAt);
        const drop = loose.slice(REPLAY_KEEP_COUNT);
        if (!drop.length) return;
        await tx('readwrite', (st) => { drop.forEach((it) => st.delete(it.id)); return null; });
    }

    return { save, get, list, remove, update, isKept, addBranch, findData };
})();

// 設定の DISPLAY › REPLAY AUTO SAVE（config/settings.js。既定 ON）
function replayAutoSave() {
    return !(window.currentDisplay && window.currentDisplay.replayAutoSave === false);
}

// 設定の DISPLAY › REPLAY BRANCH MULTI SAVE（既定 ON）。1 階層に残す枝の数: ON = REPLAY_BRANCH_MAX、OFF = 最新の 1 本（★の枝は別に残す）
function replayBranchMulti() {
    return !(window.currentDisplay && window.currentDisplay.replayBranchMulti === false);
}
function replayBranchLimit() {
    return replayBranchMulti() ? REPLAY_BRANCH_MAX : 1;
}

// ─── ファイル ───
async function replayToFileBlob(data) {
    const json = JSON.stringify(data);
    if (window.CompressionStream) {
        const s = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
        return new Response(s).blob();
    }
    return new Blob([json], { type: 'application/json' });
}

async function replayFromFile(file) {
    if (file.size > REPLAY_FILE_MAX) throw new Error('ファイルが大きすぎます');
    const u8 = new Uint8Array(await file.arrayBuffer());
    let text;
    if (u8[0] === 0x1f && u8[1] === 0x8b) {
        if (!window.DecompressionStream) throw new Error('このブラウザでは圧縮されたリプレイを開けません');
        try {
            text = await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
        } catch (e) {
            throw new Error('ファイルが壊れています');
        }
    } else {
        text = new TextDecoder().decode(u8);
    }
    if (text.length > REPLAY_TEXT_MAX) throw new Error('ファイルが大きすぎます');
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        throw new Error('リプレイのファイルではありません');
    }
    new ReplayPlayer(data); // 形・版・モードを確かめる（だめなら理由つきの Error）
    if (!data.id) data.id = String(Date.now()) + Math.random().toString(16).slice(2);
    return data;
}

function replayFileName(data) {
    const d = new Date(data.recordedAt || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    return `tetlabo-${data.mode}${data.modeOption ? '-' + data.modeOption : ''}-${stamp}.tlreplay`;
}

async function replayDownload(data) {
    const blob = await replayToFileBlob(data);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = replayFileName(data);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ─── 一覧の 1 行の中身 ───
const REPLAY_MODE_LABEL = { marathon: 'MARATHON', sprint: 'SPRINT', ultra: 'ULTRA', zone: 'ZONE', puyo: 'PUYO', versus: 'VERSUS', test: 'CPU TEST' };

function replaySummary(data) {
    const r = data.result || {};
    const b0 = (r.boards || [])[0] || {};
    const pl = data.players || [];
    let mode = REPLAY_MODE_LABEL[data.mode] || String(data.mode).toUpperCase();
    if (data.mode === 'marathon' && data.modeOption) mode += data.modeOption === 'endless' ? ' ENDLESS' : ' ' + data.modeOption;
    // ZONE ありの VERSUS（ZONE BATTLE。以前の VERSUS ＋ VS 設定 ZONE: ON の録画も同じ）は印を分ける。絞り込みは VERSUS の中
    if (data.mode === 'versus' && pl.some((p) => p.env && p.env.vsZone === true)) mode = 'ZONE BATTLE';
    let result, stat;
    if (data.mode === 'versus') {
        const loser = r.loser !== undefined ? r.loser : r.endedBy;
        const human = pl.find((p) => p.kind === 'human');
        result = human ? (loser === human.side ? 'LOSE' : 'WIN') : ((loser === 0 ? '2P' : '1P') + ' WIN');
        stat = pl.map((p) => (p.rule === 'tet' ? 'TET' : 'PUYO')).join(' vs ');
    } else {
        result = r.clear ? 'CLEAR' : 'GAME OVER';
        if (data.mode === 'sprint') stat = r.clear ? replayFmtTime(b0.timeMs || 0) : `${b0.lines || 0} LINES`;
        else if (pl[0] && pl[0].rule === 'puyo') stat = `${b0.score || 0} pts · ${b0.chainMax || 0} CHAIN`;
        else stat = `${b0.score || 0} pts · ${b0.lines || 0} LINES`;
    }
    const opponent = data.mode === 'versus' ? (pl[1] ? pl[1].name : '') : (data.mode === 'test' ? (pl[0] ? pl[0].name : '') : '');
    const rule = pl.map((p) => p.rule);
    let duration = data.durationMs || 0;
    // 切り出し（M7b）: 結果の代わりに印の名前、長さは切り出した分
    if (data.clip) {
        result = 'CLIP';
        stat = data.clip.label || stat;
        duration = Math.max(0, duration - (data.clip.fromMs || 0));
    } else if (data.branch && typeof data.branch.atMs === 'number') {
        // 二重リプレイ（v2.6.2 F）: 長さは分かれた所から
        duration = Math.max(0, duration - data.branch.atMs);
    }
    return { mode, result, stat, opponent, rule, duration, marks: (data.events || []).length };
}

function replayDateText(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ─── REPLAYS 画面 ───
const ReplaysPage = {
    filter: 'all',
    _bound: false,
    // キー操作で戻す先（focus_nav.js の register('replays')）。"<id>:<main|star|export|delete>"。
    // リプレイを見て戻ったとき・★/削除で描き直したときに使い、BACK で画面を離れたら忘れる
    focusKey: null,

    open() {
        if (typeof switchPage === 'function') switchPage('replays');
    },

    back() {
        this.focusKey = null;
        if (typeof switchPage === 'function') switchPage('main-menu');
    },

    // switchPage('replays') の後（ReplayManager.onSwitchPage から opts.open）と、絞り込み・★・削除の後。
    //   opts.open: 画面を開いたとき。行を上から順に登場させ、focusKey の行へフォーカスを戻す
    //   opts.focus: 描き直した後にフォーカスする項目のキー
    async render(opts = {}) {
        this._bind();
        const listEl = document.getElementById('replays-list');
        const status = document.getElementById('replays-status');
        if (!listEl) return;
        document.querySelectorAll('#replays-filter .opt-btn').forEach((b) => b.classList.toggle('active', b.dataset.filter === this.filter));
        let items;
        try {
            items = await ReplayStore.list();
        } catch (e) {
            listEl.innerHTML = '';
            this._status('保存先（IndexedDB）が使えません: ' + e.message);
            return;
        }
        const hint = document.getElementById('replays-hint');
        if (hint) {
            hint.textContent = replayAutoSave()
                ? '最後まで遊んだ試合を直近 30 本まで自動で残します（★・最高記録・CLIP は消えません）。CLIP は再生中の印の画面（M）から作れます。PLAY HERE で続けた試合は元のリプレイの中に枝としてまとまり、印の画面から開けます。ファイルをここへドロップしても読み込めます。'
                : '自動保存は OFF です（SETTINGS › DISPLAY）。リザルトの SAVE で残せます（最高記録・CLIP は OFF でも残ります）。ファイルをここへドロップしても読み込めます。';
        }
        const f = this.filter;
        items = items.filter((it) => {
            const d = it.data || {};
            if (f === 'star') return it.star;
            if (f === 'clip') return !!d.clip;
            if (f === 'tet') return d.mode !== 'versus' && (d.players || [])[0] && d.players[0].rule === 'tet';
            if (f === 'puyo') return d.mode !== 'versus' && (d.players || [])[0] && d.players[0].rule === 'puyo';
            if (f === 'versus') return d.mode === 'versus';
            return true;
        });
        listEl.innerHTML = '';
        if (!items.length) this._status(f === 'all' ? 'まだリプレイがありません。最後まで遊んだ試合が自動で残ります。' : '当てはまるリプレイがありません。');
        else if (status) status.style.display = 'none';
        items.forEach((it, idx) => {
            const row = this._row(it);
            // 開いたときだけ上の行から順に登場させる（RANKING と同じ。絞り込み・★で描き直すたびに出すとチカチカする）
            if (opts.open) {
                row.classList.add('ranking-row-enter');
                row.style.animationDelay = `${Math.min(idx, 12) * 0.03}s`;
            }
            listEl.appendChild(row);
        });
        if (opts.focus !== undefined) this.focusKey = opts.focus;
        const nav = window.FocusNav;
        if (!nav || nav.getActivePageId() !== 'replays') return;
        if ((opts.open || opts.focus !== undefined) && this.focusKey) nav.restoreFocus(this.focusKey, { scroll: true });
        else nav.refresh();
    },

    _status(text) {
        const status = document.getElementById('replays-status');
        if (!status) return;
        status.textContent = text;
        status.style.display = text ? '' : 'none';
    },

    _row(it) {
        const d = it.data;
        const s = replaySummary(d);
        const row = document.createElement('div');
        row.className = 'replays-row';
        const main = document.createElement('button');
        main.className = 'replays-main';
        main.title = 'WATCH';
        main.dataset.navKey = it.id + ':main';
        main.onclick = () => {
            this.focusKey = it.id + ':main'; // 見終わって戻ったらこの行へ
            ReplayManager.watch(d, 'replays');
        };
        const tags = [];
        if (d.clip) tags.push('<span class="replays-tag">CLIP</span>');
        // 二重リプレイ（v2.6.2 F）: 元のリプレイの途中（PLAY HERE）から続けた試合。重ねた数と元の日時は title に
        // 枝をまとめた親（data.branches）: 枝の数（子・孫まで）。中身は再生中の印の画面（M）で選ぶ
        const nb = replayBranchCount(d.branches);
        if (nb) {
            const t = `PLAY HERE から続けた試合が ${nb} 本入っています（再生中に M の印の画面で枝を選んで OPEN）`;
            tags.push(`<span class="replays-tag replays-tag-branch" title="${t.replace(/"/g, '&quot;')}">BRANCH ${nb}</span>`);
        }
        if (d.branch) {
            // 1 本で保存した枝（元のリプレイが無いとき・古い形）
            const b = d.branch;
            const depth = b.depth > 1 ? ` ×${b.depth}` : '';
            const from = b.parentRecordedAt ? replayDateText(b.parentRecordedAt) : '';
            const t = `PLAY HERE から続けた試合${from ? '（元: ' + from + ' の ' + replayFmtTime(b.atMs) + '）' : ''}`;
            tags.push(`<span class="replays-tag replays-tag-branch" title="${t.replace(/"/g, '&quot;')}">CONTINUED${depth}</span>`);
        }
        if (it.keepFor && it.keepFor.length) tags.push('<span class="replays-tag">BEST</span>');
        if (it.imported) tags.push('<span class="replays-tag">IMPORT</span>');
        // 隠し機能を使った対戦（MOD。app/versus.js）。中身は title に
        if (Array.isArray(d.mods) && d.mods.length) {
            const t = (typeof versusModTitle === 'function') ? versusModTitle(d.mods) : 'MOD';
            tags.push(`<span class="replays-tag replays-tag-mod" title="${t.replace(/"/g, '&quot;')}">MOD</span>`);
        }
        if (d.engine !== REPLAY_ENGINE_VERSION) tags.push('<span class="replays-tag replays-tag-old">OLD</span>');
        const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        main.innerHTML =
            `<span class="replays-date">${esc(replayDateText(d.recordedAt))}</span>` +
            `<span class="replays-mode">${esc(s.mode)}${tags.join('')}</span>` +
            `<span class="replays-result">${esc(s.result)}</span>` +
            `<span class="replays-stat">${esc(s.stat)}${s.opponent ? ' · ' + esc(s.opponent) : ''}</span>` +
            `<span class="replays-len">${esc(replayFmtTime(s.duration))}${s.marks ? ' · ◆' + s.marks : ''}</span>`;
        const star = document.createElement('button');
        star.className = 'replays-icon' + (it.star ? ' is-on' : '');
        star.textContent = it.star ? '★' : '☆';
        star.title = 'STAR';
        star.dataset.navKey = it.id + ':star';
        star.onclick = async () => {
            await ReplayStore.update(it.id, (x) => { x.star = !x.star; });
            this.render({ focus: it.id + ':star' });
        };
        const exp = document.createElement('button');
        exp.className = 'replays-icon';
        exp.textContent = '⤓';
        exp.title = 'EXPORT';
        exp.dataset.navKey = it.id + ':export';
        exp.onclick = () => replayDownload(d).catch((e) => this._status('書き出せませんでした: ' + e.message));
        const del = document.createElement('button');
        del.className = 'replays-icon replays-del';
        del.textContent = '✕';
        del.title = 'DELETE';
        del.dataset.navKey = it.id + ':delete';
        del.onclick = () => this._delete(it.id, row);
        for (const b of [main, star, exp, del]) b.onmousedown = (e) => e.preventDefault();
        row.append(main, star, exp, del);
        return row;
    },

    // 削除（確認はキーで選べるダイアログ。初期は CANCEL）。消したら下の行（無ければ上の行）の本体へ
    async _delete(id, row) {
        this.focusKey = id + ':delete'; // CANCEL で閉じたらダイアログを開く前の ✕ へ戻る
        if (window.TetDialog) {
            const r = await TetDialog.choose({
                title: 'DELETE REPLAY',
                message: 'このリプレイを削除しますか？',
                buttons: [
                    { label: 'CANCEL', value: 'cancel', kind: 'secondary', cancel: true },
                    { label: 'DELETE', value: 'delete', kind: 'danger' },
                ],
                initial: 'cancel',
            });
            if (r !== 'delete') return;
        } else if (!confirm('このリプレイを削除しますか？')) {
            return;
        }
        const near = (row.nextElementSibling || row.previousElementSibling);
        const nearMain = near && near.querySelector('.replays-main');
        await ReplayStore.remove(id);
        this.render({ focus: nearMain ? nearMain.dataset.navKey : null });
    },

    setFilter(f) {
        this.filter = f;
        this.render();
    },

    async importFiles(files) {
        let ok = 0;
        const errors = [];
        for (const file of Array.from(files || [])) {
            try {
                const data = await replayFromFile(file);
                await ReplayStore.save(data, { imported: true });
                ok++;
            } catch (e) {
                errors.push(`${file.name}: ${e.message}`);
            }
        }
        await this.render();
        if (errors.length) this._status(errors.join(' / '));
        else if (ok && typeof showGlobalToast === 'function') showGlobalToast(`${ok} 本のリプレイを読み込みました`);
    },

    _bind() {
        if (this._bound) return;
        this._bound = true;
        const input = document.getElementById('replays-import-input');
        if (input) input.addEventListener('change', () => { this.importFiles(input.files); input.value = ''; });
        const page = document.getElementById('replays-page');
        if (page) {
            page.addEventListener('dragover', (e) => { e.preventDefault(); page.classList.add('is-drop'); });
            page.addEventListener('dragleave', (e) => { if (e.target === page) page.classList.remove('is-drop'); });
            page.addEventListener('drop', (e) => {
                e.preventDefault();
                page.classList.remove('is-drop');
                this.importFiles(e.dataTransfer && e.dataTransfer.files);
            });
        }
    },
};

// ─── 録画が終わったら保存する・最高記録との結び付け・リザルト画面の SAVE / ★ / EXPORT ───
// 自動保存の書き込み中（onBest がその後に keepFor を付けるので、終わるのを待つ）
let replaySavePending = Promise.resolve();

// CPU TEST の CPU 同士で、MATCH LOG の REPLAY の条件に合わず残さなかったリプレイ（リザルトに SAVE を出すため）
let replaySkippedId = null;

ReplayManager.onRecorded = (data) => {
    replaySkippedId = null;
    // CPU 同士は MATCH LOG の REPLAY（ALL / FILTER / OFF）で決める（app/cpu_match_log.js）。FILTER で条件に合えば自動保存 OFF でも残す
    const decision = window.CpuMatchLog && CpuMatchLog.replayDecision ? CpuMatchLog.replayDecision(data) : null;
    if (decision === 'skip') { replaySkippedId = data.id; return; }
    if (decision !== 'save' && !replayAutoSave()) return; // OFF: リザルトの SAVE か、最高記録の更新（onBest）で残す
    replaySavePending = ReplayStore.save(data).catch((e) => console.warn('[replay] 保存できませんでした', e));
};

// リザルト・PAUSE の SAVE を出すか（自動保存 OFF か、CPU 同士の条件で残さなかったとき）
function replayManualSave(d) {
    return !replayAutoSave() || (!!d && d.id === replaySkippedId);
}

// 今のリザルトのリプレイが保存されていなければ保存する（SAVE・★・最高記録から）
async function replaySaveResultIfNeeded(d) {
    await replaySavePending;
    return (await ReplayStore.get(d.id)) || ReplayStore.save(d);
}

// records.js の submit から: 今の試合のリプレイがあれば結び付ける
ReplayManager.metaForRecord = (key) => {
    const d = ReplayManager.resultReplay;
    if (!d) return null;
    const mode = String(key).split(':')[0];
    return d.mode === mode ? { replayId: d.id } : null;
};

// records.js の submit で最高記録が更新されたとき: 新しい記録のリプレイを残し、前の記録のものは外す
ReplayManager.onBest = (key, record, prev) => {
    const id = record && record.meta && record.meta.replayId;
    const prevId = prev && prev.meta && prev.meta.replayId;
    const set = (rid, on) => ReplayStore.update(rid, (x) => {
        const k = new Set(x.keepFor || []);
        if (on) k.add(key); else k.delete(key);
        x.keepFor = Array.from(k);
    });
    (async () => {
        if (prevId && prevId !== id) await set(prevId, false);
        if (!id) return;
        // 自動保存 OFF でも最高記録のリプレイは残す（準備画面の WATCH BEST から見られるように）
        const d = ReplayManager.resultReplay;
        if (d && d.id === id) await replaySaveResultIfNeeded(d);
        else await replaySavePending;
        await set(id, true);
        if (d && d.id === id) await ReplayManager.updateResultTools();
    })().catch((e) => console.warn('[replay] 記録との結び付けに失敗', e));
};

// 再生中の CLIP（core/replay.js の _clip）: 切り出したリプレイを保存する（クリップは 30 本の数に入れず残す）
ReplayManager.onClip = (data) => {
    ReplayStore.save(data)
        .then(() => { if (typeof showGlobalToast === 'function') showGlobalToast('CLIP を保存しました（REPLAYS）'); })
        .catch((e) => {
            console.warn('[replay] 切り出しを保存できませんでした', e);
            if (typeof showGlobalToast === 'function') showGlobalToast('CLIP を保存できませんでした');
        });
};

// 枝を保存したら、手元の親（◀ REPLAY・RETRY HERE で見直す元・枝の行き来で覚えた親）にも入れる（印の画面にすぐ出るように）
ReplayManager.onBranchSaved = (parentId, node) => {
    const add = (d) => {
        if (!d || d.id !== parentId) return;
        const list = Array.isArray(d.branches) ? d.branches : (d.branches = []);
        const i = list.findIndex((n) => n && n.id === node.id);
        if (i >= 0) list[i] = node; else list.push(node);
        const limit = replayBranchLimit();
        while (list.length > limit) {
            const drop = list.findIndex((n) => n.id !== node.id && !n.star && !ReplayStore.isKept({ data: { branches: n.branches } }));
            if (drop < 0) break;
            list.splice(drop, 1);
        }
    };
    const seen = new Set();
    for (const d of [ReplayManager._branchParent, ReplayManager.backTo && ReplayManager.backTo.data].concat(ReplayManager._branchStack || [])) {
        if (d && !seen.has(d)) { seen.add(d); add(d); }
    }
};

// 枝から元のリプレイへ戻るとき（core/replay.js の openParent）
ReplayManager.findReplayData = (id) => ReplayStore.findData(id);

ReplayManager.watchById = async (id, returnPage) => {
    const it = await ReplayStore.get(id);
    if (!it) { if (typeof showGlobalToast === 'function') showGlobalToast('リプレイが見つかりません'); return; }
    ReplayManager.watch(it.data, returnPage);
};

ReplayManager.starResult = async () => {
    const d = ReplayManager.resultReplay;
    if (!d) return;
    try {
        await replaySaveResultIfNeeded(d); // 保存していなければ、保存してから ★ を付ける
        const it = await ReplayStore.update(d.id, (x) => { x.star = !x.star; });
        ReplayManager.updateResultTools(it);
    } catch (e) {
        console.warn('[replay] ★を付けられませんでした', e);
    }
};

// 自動保存 OFF のときの SAVE（リザルト・再生中の PAUSE 画面）。保存できたら保存した 1 件を返す
ReplayManager.saveReplay = async (d) => {
    try {
        const it = await replaySaveResultIfNeeded(d);
        if (ReplayManager.resultReplay && ReplayManager.resultReplay.id === d.id) ReplayManager.updateResultTools(it);
        if (typeof showGlobalToast === 'function') showGlobalToast('リプレイを保存しました（REPLAYS）');
        return it;
    } catch (e) {
        console.warn('[replay] 保存できませんでした', e);
        if (typeof showGlobalToast === 'function') showGlobalToast('リプレイを保存できませんでした');
        return null;
    }
};

ReplayManager.saveResult = () => {
    const d = ReplayManager.resultReplay;
    if (d) ReplayManager.saveReplay(d);
};

// 再生中の PAUSE 画面に SAVE REPLAY を出すか（自動保存 OFF で、まだ保存していないときだけ）
ReplayManager.needsSave = async (d) => {
    if (!d || !replayManualSave(d)) return false;
    await replaySavePending;
    return !(await ReplayStore.get(d.id).catch(() => null));
};

ReplayManager.exportResult = () => {
    const d = ReplayManager.resultReplay;
    if (d) replayDownload(d).catch((e) => console.warn('[replay] 書き出せませんでした', e));
};

ReplayManager.updateResultTools = async (it) => {
    const d = ReplayManager.resultReplay;
    if (!it && d) it = await ReplayStore.get(d.id).catch(() => null);
    document.querySelectorAll('.result-replay-star').forEach((b) => {
        const on = !!(it && it.star);
        b.querySelector('.result-replay-star-icon').textContent = on ? '★' : '☆';
        b.classList.toggle('is-on', on);
    });
    // SAVE は自動保存 OFF のときだけ。保存済み（SAVE・★・最高記録）なら SAVED で押せない
    document.querySelectorAll('.result-replay-save').forEach((b) => {
        const show = !!d && replayManualSave(d);
        b.style.display = show ? '' : 'none';
        b.disabled = !!it;
        b.querySelector('.result-replay-save-label').textContent = it ? 'SAVED' : 'SAVE';
    });
    if (window.FocusNav && window.FocusNav.getActivePageId() && /result$/.test(window.FocusNav.getActivePageId())) window.FocusNav.refresh();
};

window.ReplayStore = ReplayStore;
window.ReplaysPage = ReplaysPage;
