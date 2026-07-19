/**
 * 対戦相手（オポネント）の生成・駆動を表す抽象。CPU戦の相手=AIが操作する実エンジン、
 * オンライン戦の相手=ネットワーク受信で描画だけ行うパペット、と実装は大きく異なるが、
 * どちらも「start/stop」だけのライフサイクルで扱えるようにする。
 *
 * 現時点では CPU 側の非同期ロード部分（loadLocalCpu）のみをここへ切り出している。
 * オンライン側のパペット構築・フレーム適用（NetworkDriver 相当）は #versus-page と
 * #online-battle-page を1枚に統合する回でないと安全に共通化できないため、あえて
 * 見送っている（online_game.ts 側は現状のままで良い）。理由は
 * [[project-battle-rework]] 参照。
 */
export interface OpponentDriver {
  start(): void;
  stop(): void;
}

declare global {
  interface Window {
    /** cpu_loader.js が定義するグローバル関数（CPUスクリプトの動的ロード） */
    loadCpuWithFallback: (level: number, rule: "tet" | "puyo") => Promise<any>;
    /** 現在アクティブなCPU AIコントローラ。CPU TEST モード(navigation.js)とも共有するグローバル */
    _cpuController: any;
  }
}

/**
 * CPU戦の相手(AI)を非同期にロード・生成する（cpu_loader.js の loadCpuWithFallback をラップ）。
 * 旧 versus.js の startVersusGame 内にあった cpuLoadPromise の生成ロジックをそのまま抽出したもので、
 * 挙動は変えていない：
 *   - 生成した AI コントローラは window._cpuController に代入する
 *     （stopAllGames/CPU TESTモード等、既存の全参照箇所と互換にするため、専用の状態を
 *     新設せず既存のグローバルへ委譲する）
 *   - isStale() が true を返す時点（対戦が再スタート済み等）では代入しない
 *   - 読み込み失敗時は控えめに警告し null を返す（呼び出し側は自由落下にフォールバックする）
 */
export async function loadLocalCpu(
  game: any,
  level: number,
  rule: "tet" | "puyo",
  isStale: () => boolean,
): Promise<any> {
  try {
    const CPUClass = await window.loadCpuWithFallback(level, rule);
    if (CPUClass && !isStale()) {
      if (window._cpuController && typeof window._cpuController.stop === "function") {
        window._cpuController.stop();
      }
      window._cpuController = new CPUClass(game);
    }
    return CPUClass;
  } catch (e) {
    console.warn("CPUスクリプトの読み込みに失敗しました。自由落下になります。");
    return null;
  }
}

export const BattleDriver = { loadLocalCpu };

declare global {
  interface Window {
    BattleDriver: typeof BattleDriver;
  }
}
window.BattleDriver = BattleDriver;
