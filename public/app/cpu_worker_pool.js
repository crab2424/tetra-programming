// ─────────────────────────────────────────────
// cpu_worker_pool.js — CPU思考用 Web Worker の使い回し（v2.2.3 G）
//
// 背景: CPUコントローラは生成のたびに new Worker(url) し、stop() で terminate していた。
//   worker 起動 → emscripten glue/wasm 取得 → wasm 初期化 → 'ready' までの時間が
//   カウントダウンに収まらないと、tetCPU は即置き・puyoCPU は無操作のまま試合が始まっていた
//   （リスタート時の「約2秒自由落下→即置き」）。
//
// 方針: worker は殺さずプールに返して次のコントローラへ貸し出す。
//   ・acquire(url) は Worker 互換の「リース」を返す（postMessage / onmessage / onerror / terminate）。
//     コントローラ側は `new Worker(url)` を `CpuWorkerPool.acquire(url)` に置き換えるだけで、
//     stop() の terminate() はそのまま「返却」として働く。
//   ・ready 済みの worker を貸す場合は、onmessage が設定された瞬間に合成 {type:'ready'} を
//     同期で配送する（コンストラクタ直後に start() しても workerReady が立っている）。
//   ・返却直前に投げた計算の結果が次の持ち主へ届かないよう、送信データに __lease を付け、
//     worker 側（各 cpu_worker*.js 冒頭）が返信へ同じ値をエコーする。一致しない返信は捨てる。
//
// 寿命: メインメニュー／タイトルへ戻ったとき clear()（navigation.js）。idle が
//   IDLE_TIMEOUT_MS 続いた worker も破棄する（wasm は 1本 16〜32MB 確保するため）。
// ─────────────────────────────────────────────
const CpuWorkerPool = (() => {
  const IDLE_TIMEOUT_MS = 3 * 60 * 1000;
  const MAX_IDLE_PER_URL = 2;   // CPU同士の同レベル対戦で同じ URL を 2 本使う

  let nextLeaseId = 1;
  const entries = new Set();    // { url, worker, ready, broken, lease, idleTimer, readyWaiters[] }

  function createEntry(url) {
    const entry = {
      url, worker: new Worker(url), ready: false, broken: false,
      lease: null, idleTimer: null, readyWaiters: [],
    };
    entry.worker.onmessage = (e) => {
      const d = e.data;
      if (d && d.type === 'ready') {
        entry.ready = true;
        const waiters = entry.readyWaiters;
        entry.readyWaiters = [];
        waiters.forEach((fn) => fn());
        if (entry.lease) entry.lease._deliverReady();
        return;
      }
      const lease = entry.lease;
      if (!lease) return; // idle 中に届いた古い結果
      if (d && typeof d === 'object' && d.__lease !== undefined && d.__lease !== lease.id) return;
      lease._deliver(e);
    };
    entry.worker.onerror = (err) => {
      entry.broken = true;
      if (entry.lease && typeof entry.lease.onerror === 'function') entry.lease.onerror(err);
    };
    entries.add(entry);
    return entry;
  }

  function destroy(entry) {
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    try { entry.worker.terminate(); } catch (_) { /* noop */ }
    entries.delete(entry);
    const waiters = entry.readyWaiters;
    entry.readyWaiters = [];
    waiters.forEach((fn) => fn()); // 待っている側を永久に止めない
  }

  function idleEntries(url) {
    const list = [];
    for (const e of entries) if (e.url === url && !e.lease && !e.broken) list.push(e);
    return list;
  }

  function scheduleIdleTimeout(entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (!entry.lease) destroy(entry);
    }, IDLE_TIMEOUT_MS);
  }

  function whenEntryReady(entry) {
    if (entry.ready || !entries.has(entry)) return Promise.resolve();
    return new Promise((resolve) => entry.readyWaiters.push(resolve));
  }

  class Lease {
    constructor(entry) {
      this.id = nextLeaseId++;
      this.url = entry.url;
      this._entry = entry;
      this._released = false;
      this._onmessage = null;
      this._readyPending = false;
      this.onerror = null;
    }
    get onmessage() { return this._onmessage; }
    set onmessage(fn) {
      this._onmessage = fn;
      // ready 済み worker の貸し出し: ハンドラが付いた時点で同期配送する
      if (fn && this._readyPending) {
        this._readyPending = false;
        fn({ data: { type: 'ready' } });
      }
    }
    postMessage(data, transfer) {
      if (this._released) return;
      if (data && typeof data === 'object') data.__lease = this.id;
      if (transfer) this._entry.worker.postMessage(data, transfer);
      else this._entry.worker.postMessage(data);
    }
    // 返却（worker 自体は殺さない）。コントローラの stop() から呼ばれる。
    terminate() { release(this); }
    whenReady() { return whenEntryReady(this._entry); }
    get ready() { return this._entry.ready; }
    _deliver(e) {
      if (!this._released && this._onmessage) this._onmessage(e);
    }
    _deliverReady() {
      if (this._released) return;
      if (this._onmessage) this._onmessage({ data: { type: 'ready' } });
      else this._readyPending = true;
    }
  }

  function acquire(url) {
    const idle = idleEntries(url);
    // ready 済みを優先して貸す
    const entry = idle.find((e) => e.ready) || idle[0] || createEntry(url);
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    const lease = new Lease(entry);
    entry.lease = lease;
    if (entry.ready) lease._readyPending = true;
    return lease;
  }

  function release(lease) {
    if (lease._released) return;
    lease._released = true;
    lease._onmessage = null;
    const entry = lease._entry;
    if (entry.lease !== lease) return;
    entry.lease = null;
    if (entry.broken || idleEntries(entry.url).length > MAX_IDLE_PER_URL) {
      destroy(entry);
      return;
    }
    scheduleIdleTimeout(entry);
  }

  // url の worker を ready 済みで count 本 idle に用意する（ロード画面から呼ぶ）。
  function prewarm(url, count = 1) {
    const idle = idleEntries(url);
    const list = idle.slice(0, count);
    while (list.length < count) {
      const entry = createEntry(url);
      scheduleIdleTimeout(entry);
      list.push(entry);
    }
    return Promise.all(list.map(whenEntryReady)).then(() => undefined);
  }

  // prewarm せずに済む（＝もう ready 済みの idle が count 本ある）か
  function isWarm(url, count = 1) {
    return idleEntries(url).filter((e) => e.ready).length >= count;
  }

  // コントローラが持つ全リース（worker / pcWorker 等）が ready になるまで待つ
  function whenControllerReady(ctrl) {
    if (!ctrl) return Promise.resolve();
    const leases = Object.values(ctrl).filter((v) => v instanceof Lease);
    return Promise.all(leases.map((l) => l.whenReady())).then(() => undefined);
  }

  function clear() {
    for (const entry of [...entries]) {
      if (entry.lease) entry.lease._released = true;
      destroy(entry);
    }
  }

  return { acquire, prewarm, isWarm, whenControllerReady, clear, Lease };
})();

window.CpuWorkerPool = CpuWorkerPool;
