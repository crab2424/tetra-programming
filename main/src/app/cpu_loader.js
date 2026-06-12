// ─────────────────────────────────────────────
// cpu_loader.js — CPUスクリプトの動的ロード・破棄
// （router.js から分割。CPU_CONFIGS は modes.js）
// ─────────────────────────────────────────────
// ─── CPU動的ロード・破棄システム ──────────────
// ★ activeCpuScript は1クラス分のスクリプト要素群。
//   src が配列のCPU（例: PuyoCPU4 の分割ファイル群）に対応するため常に配列で保持する。
let activeCpuScripts = [];
let activeCpuClassName = null;

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

async function loadCpuScript(level, rule) {
  const config = CPU_CONFIGS[rule][level];
  if (!config) throw new Error("Invalid CPU Level or Rule");

  //  開発中のCPUスクリプトは毎回キャッシュをバイパスして再読み込みする
  // （他のCPUスクリプトは従来通りキャッシュを利用）
  // ここに登録したクラスは評価係数を変えるたび ?v=Date.now() で必ず最新が反映される
  const DEV_CPU_CLASSES = ['PuyoCPU4', 'CPU6'];
  const isDevCpu = DEV_CPU_CLASSES.includes(config.className);

  if (!isDevCpu && activeCpuClassName === config.className && window[config.className]) {
    return window[config.className];
  }

  unloadCpuScript();

  // ★ src は文字列 or 配列。配列の場合は「class 定義ファイル → prototype 拡張ファイル」の
  //   順序が重要なため、Promise.all ではなく必ず逐次ロードする。
  const srcs = Array.isArray(config.src) ? config.src : [config.src];
  const loaded = [];
  for (const src of srcs) {
    loaded.push(await _appendCpuScript(src, isDevCpu));
  }

  activeCpuScripts = loaded;
  activeCpuClassName = config.className;
  return window[config.className];
}

// ★ フォールバック付きのCPUロード関数（カウントダウン中に非同期で呼ばれる）
async function loadCpuWithFallback(targetLevel, rule) {
  for (let lv = targetLevel; lv >= 1; lv--) {
    try {
      const CPUClass = await loadCpuScript(lv, rule);
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
  for (const script of activeCpuScripts) {
    if (script && script.parentNode) script.parentNode.removeChild(script);
  }
  activeCpuScripts = [];

  if (activeCpuClassName && window[activeCpuClassName]) {
    delete window[activeCpuClassName];
    activeCpuClassName = null;
  }
}
