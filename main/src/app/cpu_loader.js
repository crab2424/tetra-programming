// ─────────────────────────────────────────────
// cpu_loader.js — CPUスクリプトの動的ロード・破棄
// （router.js から分割。CPU_CONFIGS は modes.js）
// ─────────────────────────────────────────────
// ─── CPU動的ロード・破棄システム ──────────────
let activeCpuScript = null;
let activeCpuClassName = null;

function loadCpuScript(level, rule) {
  return new Promise((resolve, reject) => {
    const config = CPU_CONFIGS[rule][level];
    if (!config) return reject(new Error("Invalid CPU Level or Rule"));

    //  開発中のCPUスクリプトは毎回キャッシュをバイパスして再読み込みする
    // （他のCPUスクリプトは従来通りキャッシュを利用）
    // ここに登録したクラスは評価係数を変えるたび ?v=Date.now() で必ず最新が反映される
    const DEV_CPU_CLASSES = ['PuyoCPU4', 'CPU6'];
    const isDevCpu = DEV_CPU_CLASSES.includes(config.className);

    if (!isDevCpu && activeCpuClassName === config.className && window[config.className]) {
      return resolve(window[config.className]);
    }

    unloadCpuScript();

    const script = document.createElement('script');
    // ★ 開発中のみタイムスタンプをクエリパラメータとして付与し、ブラウザキャッシュを無効化
    //   （src に既存の ?v=… が付いていても剥がしてから付与し、?が二重にならないようにする）
    script.src = isDevCpu ? `${config.src.split('?')[0]}?v=${Date.now()}` : config.src;
    script.id = `dynamic-cpu-script`;
    
    script.onload = () => {
      activeCpuScript = script;
      activeCpuClassName = config.className;
      resolve(window[config.className]);
    };
    script.onerror = (e) => {
      console.error(`CPUスクリプトのロードに失敗しました: ${config.src}`, e);
      reject(e);
    };
    document.body.appendChild(script);
  });
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
  if (activeCpuScript && activeCpuScript.parentNode) {
    activeCpuScript.parentNode.removeChild(activeCpuScript);
    activeCpuScript = null;
  }
  if (activeCpuClassName && window[activeCpuClassName]) {
    delete window[activeCpuClassName];
    activeCpuClassName = null;
  }
}
