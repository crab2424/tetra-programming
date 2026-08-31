// ─────────────────────────────────────────────
// records.js — 最高記録（ローカルスコア）の保存・比較・表示整形
//
// 保存先: localStorage['tetlabo_records']
// キー設計: モード＋条件で分ける（MARATHONは150LINES/ENDLESSで難度が別物のため別枠）。
//   marathon:150 / marathon:endless / sprint:40 / ultra / puyo
//
// 将来のサーバー同期（Discord連携等 v2.2以降）へ差し替えやすいよう、
// - submit() は最初から Promise を返す（シグネチャを変えずに裏側だけ差し替え可能にする）
// - 各レコードに id(uuid) / at(ISO日時) / schemaVersion を持たせる
// - 予約フィールド meta:{} を用意（検証用の seed/inputHash 等を後から足せる）
// ─────────────────────────────────────────────

(function () {
  const STORAGE_KEY = 'tetlabo_records';
  const SCHEMA_VERSION = 1;

  // 主指標の比較ルール（field: 比較対象、better: 'higher'|'lower'）
  const RECORD_RULES = {
    'marathon:150':     { field: 'score',    better: 'higher' },
    'marathon:endless': { field: 'score',    better: 'higher' },
    'sprint:40':        { field: 'timeMs',   better: 'lower'  },
    'ultra':            { field: 'score',    better: 'higher' },
    'puyo':              { field: 'chainMax', better: 'higher' },
  };

  function _uuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function _loadAll() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { schemaVersion: SCHEMA_VERSION, records: {} };
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.records) return parsed;
    } catch (e) { /* 壊れたJSONは初期化して復旧 */ }
    localStorage.removeItem(STORAGE_KEY);
    return { schemaVersion: SCHEMA_VERSION, records: {} };
  }

  function _saveAll(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  function get(key) {
    const data = _loadAll();
    return data.records[key] || null;
  }

  function getAll() {
    return _loadAll().records;
  }

  function _isBetter(key, candidate, current) {
    if (!current) return true;
    const rule = RECORD_RULES[key] || { field: 'score', better: 'higher' };
    const a = candidate[rule.field];
    const b = current[rule.field];
    if (typeof a !== 'number' || !isFinite(a)) return false;
    if (typeof b !== 'number' || !isFinite(b)) return true;
    return rule.better === 'lower' ? a < b : a > b;
  }

  /**
   * 記録を提出する。上回った場合のみ保存し isNew:true を返す。
   * @returns {Promise<{isNew:boolean, prev:object|null, record:object}>}
   */
  async function submit(key, record) {
    const data = _loadAll();
    const prev = data.records[key] || null;
    const enriched = Object.assign({}, record, {
      id: _uuid(),
      at: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      meta: record.meta || {},
    });
    const isNew = _isBetter(key, enriched, prev);
    if (isNew) {
      data.records[key] = enriched;
      data.schemaVersion = SCHEMA_VERSION;
      _saveAll(data);
    }
    return { isNew, prev, record: isNew ? enriched : prev };
  }

  function reset() {
    localStorage.removeItem(STORAGE_KEY);
  }

  // ─── 表示整形 ───────────────────────────────
  function _formatTime(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '--:--.--';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
  }

  /** BEST表示用の主指標だけを整形した文字列を返す */
  function format(key, record) {
    if (!record) return '—';
    const rule = RECORD_RULES[key] || { field: 'score', better: 'higher' };
    if (rule.field === 'timeMs') return _formatTime(record.timeMs);
    if (rule.field === 'chainMax') return `${record.chainMax ?? 0} CHAIN`;
    const v = record[rule.field];
    return typeof v === 'number' ? v.toLocaleString('en-US') : '—';
  }

  window.Records = { get, getAll, submit, reset, format };
})();
