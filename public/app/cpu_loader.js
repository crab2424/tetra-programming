// ─────────────────────────────────────────────
// cpu_loader.js — CPUスクリプトの動的ロード・破棄
// （router.js から分割。CPU_CONFIGS は modes.js）
// ─────────────────────────────────────────────
// ─── CPU動的ロード・破棄システム ──────────────
// ★ v2.2.3: 「アクティブな1クラス」だけを持つ方式から、className ごとのレジストリに変更。
//   ・CPU同士の対戦（J）で左右に別レベルのクラスを同時に載せられる。
//   ・同じクラスの読み込みが進行中なら、その Promise を共有して待つ（直列化）。
//     旧実装はリスタート連打で unload が別の読み込み途中に window[className] を消し、
//     後続の prototype 拡張ファイルが TypeError になる競合があった。
//   スクリプト本体の破棄は unloadCpuScript()（メインメニュー／タイトル帰還時）で一括。
// src が配列のCPU（例: PuyoCPU4 の分割ファイル群）に対応するため scripts は常に配列で保持する。
const _cpuClassRegistry = new Map(); // className -> { scripts: HTMLScriptElement[], loading: Promise|null }

// 1ファイルを <script> として追加し、onload を待つ Promise を返す。
function _appendCpuScript(src, isDevCpu) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    // ★ 開発中のみタイムスタンプをクエリパラメータとして付与し、ブラウザキャッシュを無効化
    //   （src に既存の ?v=… が付いていても剥がしてから付与し、?が二重にならないようにする）
    script.src = isDevCpu ? `${src.split('?')[0]}?v=${Date.now()}` : src;
    script.className = 'dynamic-cpu-script';

    script.onload = () => resolve(script);
    script.onerror = (e) => {
      console.error(`CPUスクリプトのロードに失敗しました: ${src}`, e);
      reject(e);
    };
    document.body.appendChild(script);
  });
}

function _removeCpuClass(className) {
  const rec = _cpuClassRegistry.get(className);
  if (rec) {
    for (const script of rec.scripts) {
      if (script && script.parentNode) script.parentNode.removeChild(script);
    }
  }
  _cpuClassRegistry.delete(className);
  if (window[className]) delete window[className];
}

// 開発中（評価係数チューニング中）のCPUクラス。startVersusGame 等の「開始」ごとに最新を読み直す。
//
// ★ 注意：ここに載せると「リスタート・再戦のたびにクラスJSを実ネットワークから
//   再ダウンロードする」ことになる（CPU6 なら 1 回あたり約 75KB）。
//   チューニング中のCPUだけを載せ、実装が固まったら外して `CPU_CONFIGS` 側の
//   `?v=` 運用（＝編集したら app/modes.js の ?v を上げる）に戻すこと。
//   2026-08-29: CPU6 は当面チューニング予定が無いためここから外した。
//   2026-09-24: PuyoCPU5 はチューニング継続のため残す（ユーザー確認済み）。
const DEV_CPU_CLASSES = ['PuyoCPU5'];

function isDevCpuClass(level, rule) {
  const config = CPU_CONFIGS[rule] && CPU_CONFIGS[rule][level];
  return !!config && DEV_CPU_CLASSES.includes(config.className);
}

// 既に読み込み済みで、開始時に読み直す必要が無いか（ロード画面の省略判定に使う）
function isCpuScriptLoaded(level, rule) {
  const config = CPU_CONFIGS[rule] && CPU_CONFIGS[rule][level];
  if (!config) return false;
  if (DEV_CPU_CLASSES.includes(config.className)) return false;
  const rec = _cpuClassRegistry.get(config.className);
  return !!rec && !rec.loading && !!window[config.className];
}

async function loadCpuScript(level, rule, opts = {}) {
  const config = CPU_CONFIGS[rule][level];
  if (!config) throw new Error("Invalid CPU Level or Rule");
  const className = config.className;
  const isDevCpu = DEV_CPU_CLASSES.includes(className);

  const rec = _cpuClassRegistry.get(className);
  if (rec && rec.loading) return rec.loading; // 同じクラスを読み込み中なら相乗りする
  // DEV クラスは opts.reload（＝開始ごと1回）の時だけ読み直す。同じ開始処理の中で
  // 左右のCPUが同じクラスを要求した場合などは読み込み済みのものを使う。
  const needReload = isDevCpu && opts.reload !== false;
  if (rec && window[className] && !needReload) return window[className];

  _removeCpuClass(className);
  const entry = { scripts: [], loading: null };
  _cpuClassRegistry.set(className, entry);
  entry.loading = (async () => {
    // ★ src は文字列 or 配列。配列の場合は「class 定義ファイル → prototype 拡張ファイル」の
    //   順序が重要なため、Promise.all ではなく必ず逐次ロードする。
    const srcs = Array.isArray(config.src) ? config.src : [config.src];
    try {
      for (const src of srcs) {
        entry.scripts.push(await _appendCpuScript(src, isDevCpu));
      }
    } catch (e) {
      if (_cpuClassRegistry.get(className) === entry) _removeCpuClass(className);
      throw e;
    }
    entry.loading = null;
    if (!window[className]) {
      if (_cpuClassRegistry.get(className) === entry) _removeCpuClass(className);
      throw new Error(`CPUクラス ${className} が定義されませんでした`);
    }
    return window[className];
  })();
  return entry.loading;
}

// ★ フォールバック付きのCPUロード関数
async function loadCpuWithFallback(targetLevel, rule, opts = {}) {
  for (let lv = targetLevel; lv >= 1; lv--) {
    try {
      const CPUClass = await loadCpuScript(lv, rule, opts);
      if (lv !== targetLevel) {
        alert(`指定されたCPU(LV ${targetLevel})の読み込みに失敗しました。\n現在CPUは LV ${lv} まで実装しています。\nLV ${lv} を読み込んで開始します。`);
      }
      return CPUClass;
    } catch (e) {
      console.warn(`CPU LV ${lv} (${rule}) の読み込みに失敗しました。`);
      // 失敗した場合は1つ下のレベルを試すループが続く
    }
  }
  throw new Error("CPUスクリプトのロードに全て失敗しました。");
}

function unloadCpuScript() {
  for (const className of [..._cpuClassRegistry.keys()]) {
    const rec = _cpuClassRegistry.get(className);
    if (rec && rec.loading) continue; // 読み込み途中のものは消さない（完了後に使われる）
    _removeCpuClass(className);
  }
}
