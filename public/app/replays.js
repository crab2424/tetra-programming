// ─────────────────────────────────────────────
// replays.js — リプレイの保存・REPLAYS 画面・エクスポート/インポート（録画 M6）
//
// 設計: source_assets/memory/record/tetlabo-record-design.md §6・§9
//   ・保存: 最後まで遊んだ試合は IndexedDB（tetlabo-replays）に自動保存（core/replay.js の ReplayManager.onRecorded）。
//     直近 30 本を残して古いものから消す（並びは保存した時刻。インポートしたものも同じ）。
//     ★を付けたもの・最高記録に結び付いたもの（keepFor）・クリップは消さない。
//   ・最高記録: records.js の記録の meta.replayId にリプレイを結び付け、準備画面の BEST の下から見られる。
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
    async function save(data, opts = {}) {
        const prev = await get(data.id);
        const item = prev || { id: data.id, savedAt: Date.now(), star: false, keepFor: [], imported: !!opts.imported, data };
        item.data = data;
        await tx('readwrite', (st) => st.put(item));
        await prune();
        return item;
    }

    function get(id) {
        if (!id) return Promise.resolve(null);
        return tx('readonly', (st) => st.get(id)).then((x) => x || null);
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
        const item = await get(id);
        if (!item) return null;
        fn(item);
        await tx('readwrite', (st) => st.put(item));
        await prune();
        return item;
    }

    const isKept = (it) => it.star || (it.keepFor && it.keepFor.length) || (it.data && it.data.clip);

    // 直近 30 本（守るものを除く）を残す
    async function prune() {
        const all = (await tx('readonly', (st) => st.getAll())) || [];
        const loose = all.filter((it) => !isKept(it)).sort((a, b) => b.savedAt - a.savedAt);
        const drop = loose.slice(REPLAY_KEEP_COUNT);
        if (!drop.length) return;
        await tx('readwrite', (st) => { drop.forEach((it) => st.delete(it.id)); return null; });
    }

    return { save, get, list, remove, update, isKept };
})();

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
const REPLAY_MODE_LABEL = { marathon: 'MARATHON', sprint: 'SPRINT', ultra: 'ULTRA', puyo: 'PUYO', versus: 'VERSUS', test: 'CPU TEST' };

function replaySummary(data) {
    const r = data.result || {};
    const b0 = (r.boards || [])[0] || {};
    const pl = data.players || [];
    let mode = REPLAY_MODE_LABEL[data.mode] || String(data.mode).toUpperCase();
    if (data.mode === 'marathon' && data.modeOption) mode += data.modeOption === 'endless' ? ' ENDLESS' : ' ' + data.modeOption;
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

    open() {
        if (typeof switchPage === 'function') switchPage('replays');
    },

    // switchPage('replays') の後（ReplayManager.onSwitchPage から）
    async render() {
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
        for (const it of items) listEl.appendChild(this._row(it));
        if (window.FocusNav && window.FocusNav.refresh) window.FocusNav.refresh();
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
        main.onclick = () => ReplayManager.watch(d, 'replays');
        const tags = [];
        if (d.clip) tags.push('<span class="replays-tag">CLIP</span>');
        if (it.keepFor && it.keepFor.length) tags.push('<span class="replays-tag">BEST</span>');
        if (it.imported) tags.push('<span class="replays-tag">IMPORT</span>');
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
        star.onclick = async () => { await ReplayStore.update(it.id, (x) => { x.star = !x.star; }); this.render(); };
        const exp = document.createElement('button');
        exp.className = 'replays-icon';
        exp.textContent = '⤓';
        exp.title = 'EXPORT';
        exp.onclick = () => replayDownload(d).catch((e) => this._status('書き出せませんでした: ' + e.message));
        const del = document.createElement('button');
        del.className = 'replays-icon replays-del';
        del.textContent = '✕';
        del.title = 'DELETE';
        del.onclick = async () => {
            if (!confirm('このリプレイを削除しますか？')) return;
            await ReplayStore.remove(it.id);
            this.render();
        };
        for (const b of [main, star, exp, del]) b.onmousedown = (e) => e.preventDefault();
        row.append(main, star, exp, del);
        return row;
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

// ─── 録画が終わったら保存する・最高記録との結び付け・リザルト画面の ★ / EXPORT ───
ReplayManager.onRecorded = (data) => {
    ReplayStore.save(data).catch((e) => console.warn('[replay] 保存できませんでした', e));
};

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
        if (id) await set(id, true);
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

ReplayManager.watchById = async (id, returnPage) => {
    const it = await ReplayStore.get(id);
    if (!it) { if (typeof showGlobalToast === 'function') showGlobalToast('リプレイが見つかりません'); return; }
    ReplayManager.watch(it.data, returnPage);
};

ReplayManager.starResult = async () => {
    const d = ReplayManager.resultReplay;
    if (!d) return;
    const it = await ReplayStore.update(d.id, (x) => { x.star = !x.star; });
    ReplayManager.updateResultTools(it);
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
};

window.ReplayStore = ReplayStore;
window.ReplaysPage = ReplaysPage;
