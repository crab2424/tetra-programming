// ─────────────────────────────────────────────
// modes.js — モード定義・CPU設定・共有state
// （router.js から分割。旧 router.js はバックアップとして残置・未読込）
// ─────────────────────────────────────────────
// 開始カウントダウン（3→2→1→START!）の長さ。START!（=ゲーム開始）に到達するまで約2100ms。
// runCountdown（base.js）が 700ms 間隔で進むのに合わせる。ゲーム開始時のメニューBGMフェードアウトに使用。
const COUNTDOWN_TO_START_MS = 2100;
// ─── モード定義 ───────────────────────────────
const GAME_MODES = {
  marathon: {
    id:          'marathon',
    label:       'MARATHON',
    icon:        '∞',
    description: 'レベルが上がるにつれてミノが加速する。',
    descriptionEn: 'Speed increases as your level rises.',
    color:       'var(--accent)',
  },
  sprint: {
    id:          'sprint',
    label:       'SPRINT',
    icon:        '⚡',
    description: '40ラインのタイムアタック。',
    descriptionEn: 'Clear 40 lines as fast as possible.',
    color:       'var(--accent3)',
  },
  ultra: {
    id:          'ultra',
    label:       'ULTRA',
    icon:        '★',
    description: '2分間のスコアアタック。',
    descriptionEn: 'Score as many points as possible in 2 minutes.',
    color:       'var(--accent2)',
  },
  test: {
    id:          'test',
    label:       'CPU TEST',
    icon:        '🤖',
    description: 'CPUの動作確認用モードです。',
    descriptionEn: 'Test mode for CPU behavior. ',
    color:       'var(--success)',
  },
  puyo: {
    id:          'puyo',
    label:       'PUYO',
    icon:        '🫧',
    description: 'ぷよモードシングルプレイ。',
    descriptionEn: 'Chain combos to score as high as possible.',
    color:       'var(--accent2)',
  },
  // ─── QUIZモード ───────────────────────────────
  quiz: {
    id:          'quiz',
    label:       'QUIZ',
    icon:        '❓',
    description: '謎解きパズルモード。テト・ぷよ両対応。',
    descriptionEn: 'Puzzle challenge mode for both Tet and Puyo.',
    color:       '#f58542',
  },
};

let testCpuControl = true; 
let testRule = 'tet';

function setTestCpuControl(isOn) {
  testCpuControl = isOn;
  const toggle = document.getElementById('test-cpu-control-toggle');
  if (toggle) {
    toggle.querySelectorAll('.opt-btn').forEach(btn => {
      const isOn_ = btn.textContent === 'ON';
      btn.classList.toggle('active', isOn_ === isOn);
    });
  } else {
    renderModeCheck();
  }
}

function setTestRule(rule) {
  testRule = rule;
  const toggle = document.getElementById('test-rule-toggle');
  if (toggle) {
    toggle.querySelectorAll('.opt-btn').forEach(btn => {
      btn.classList.toggle('active', btn.textContent.toLowerCase() === rule.toLowerCase());
    });
  } else {
    renderModeCheck();
  }
}

let currentGameMode = null;
let versusRule = 'tet'; // 既存の互換性のため残す
let versusPlayerRule = 'tet'; // プレイヤー側のルール ('tet' or 'puyo')
let versusCpuRule = 'tet';    // CPU側のルール ('tet' or 'puyo')

// カウントダウン中の中断を防ぐためのセッション管理
let currentSessionId = 0;
// ─── VERSUSモード用グローバル変数 ──────────────
const CPU_LEVELS = {
  1: { label: 'LV 1', desc: '初心者向け', gravityLevel: 1  },
  2: { label: 'LV 2', desc: '初級者向け', gravityLevel: 2  },
  3: { label: 'LV 3', desc: '中級者向け', gravityLevel: 2  },
  4: { label: 'LV 4', desc: '上級者向け', gravityLevel: 2 },
  5: { label: 'LV 5', desc: '最上級者向け', gravityLevel: 2 },
  // ★ 隠し要素: 準備画面で「6」キーを押すと出現（tet限定）
  6: { label: 'LV 6', desc: '???', gravityLevel: 2 },
};
let selectedCpuLevel = 1; 

const CPU_CONFIGS = {
  tet: {
    1: { className: 'CPU',  src: 'cpu/tet/lv1/cpu.js' },  
    2: { className: 'CPU2', src: 'cpu/tet/lv2/cpu2.js' },
    3: { className: 'CPU3', src: 'cpu/tet/lv3/cpu3.js' },
    4: { className: 'CPU4', src: 'cpu/tet/lv4/cpu4.js?v=4' },
    5: { className: 'CPU5', src: 'cpu/tet/lv5/cpu5.js?v=4' },
    6: { className: 'CPU6', src: 'cpu/tet/lv6/cpu6.js?v=17' }
  },
  puyo: {
    1: { className: 'PuyoCPU',  src: 'cpu/puyo/lv1/cpu1.js' },  
    2: { className: 'PuyoCPU2', src: 'cpu/puyo/lv2/cpu2.js' },
    3: { className: 'PuyoCPU3', src: 'cpu/puyo/lv3/cpu3.js' },
    4: { className: 'PuyoCPU4', src: 'cpu/puyo/lv4/cpu4.js' }, 
    5: { className: 'PuyoCPU5', src: 'cpu/puyo/lv5/cpu5.js' }  
  }
};
