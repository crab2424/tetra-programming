/**
 * 対戦（CPU戦・オンライン戦共通）の終了処理を安定化するためのライフサイクル状態機械。
 *
 * これまで終了まわりは matchInProgress / rematchStarting / postMatchNavigating /
 * _versusFinishing といった boolean フラグのアドホックな組み合わせで排他されており、
 * ローカル死亡と WinnerNotification の競合・二重開始・決着後の遅延通知などで
 * 勝敗表示や画面遷移が壊れることがあった。本モジュールは「状態遷移は transition()
 * だけが行い、不正な遷移は黙って捨てる（ログのみ）」という単一書き込み点を提供する。
 *
 * 状態図:
 *   idle → preparing → countdown → playing → roundResolving → roundResult
 *            ↑                                                   │
 *            └────────── (セット未決着: 次ラウンド) ←────────────┤
 *                                                                └→ postMatch
 *   どの状態からも idle へ戻れる（cleanup）。
 *
 * セット戦（Best-of-N・複数本先取）に備えて SetState{target, round, wins} を
 * 最初から保持する。target=1 なら従来どおり1本勝負。
 */

export type BattlePhase =
  | "idle" // 未対戦（初期状態・cleanup後）
  | "preparing" // 次の対戦開始通知を待っている（初回参加・再戦合意後）
  | "countdown" // 開始通知を受けカウントダウン中
  | "playing" // 本編進行中
  | "roundResolving" // 勝敗確定を受けて凍結・演出中
  | "roundResult" // 結果表示中（ボタン操作可）
  | "postMatch"; // ルーム復帰/退出などの遷移処理中

/** 各状態から遷移してよい先。idle(cleanup) はどこからでも許可する */
const ALLOWED: Record<BattlePhase, BattlePhase[]> = {
  idle: ["preparing"],
  preparing: ["countdown", "roundResult", "idle"], // roundResult = 再戦開始の失敗で戻る
  countdown: ["playing", "roundResolving", "idle"], // roundResolving = カウントダウン中の相手切断など
  playing: ["roundResolving", "idle"],
  roundResolving: ["roundResult", "idle"],
  roundResult: ["preparing", "postMatch", "idle"],
  postMatch: ["idle"],
};

/** セット戦の進行状態。target 本先取・wins はプレイヤーID→勝数 */
export interface SetStateSnapshot {
  target: number;
  round: number;
  wins: ReadonlyMap<string, number>;
}

export class BattleLifecycle {
  private _phase: BattlePhase = "idle";
  private target = 1;
  private round = 0;
  private wins = new Map<string, number>();
  private readonly log: (msg: string) => void;

  constructor(opts?: { log?: (msg: string) => void }) {
    this.log = opts?.log ?? (() => {});
  }

  get phase(): BattlePhase {
    return this._phase;
  }

  /** 現在の状態から to へ遷移できるか（遷移はしない） */
  can(to: BattlePhase): boolean {
    return this._phase !== to && ALLOWED[this._phase].includes(to);
  }

  /**
   * 状態遷移を試みる。成立したら true。
   * 不正な遷移（二重通知・決着後の遅延イベントなど）は false を返すだけで
   * 何も起こさない。呼び出し側は false のとき DOM/エンジンを触ってはならない。
   */
  transition(to: BattlePhase, reason?: string): boolean {
    if (this._phase === to) {
      this.log(`[lifecycle] ${this._phase} → ${to} (no-op${reason ? `: ${reason}` : ""})`);
      return false;
    }
    if (!ALLOWED[this._phase].includes(to)) {
      this.log(
        `[lifecycle] BLOCKED ${this._phase} → ${to}${reason ? ` (${reason})` : ""}`,
      );
      return false;
    }
    this.log(`[lifecycle] ${this._phase} → ${to}${reason ? ` (${reason})` : ""}`);
    this._phase = to;
    return true;
  }

  // ── セット戦（Best-of-N）進行 ────────────────────────────────────────────

  /** セットを設定し勝数をリセットする。ルーム設定の setTarget（未指定は1本勝負）で呼ぶ */
  configureSet(target: number): void {
    this.target = Number.isFinite(target) && target >= 1 ? Math.floor(target) : 1;
    this.round = 0;
    this.wins.clear();
  }

  /** ラウンド開始時（countdown 遷移成立後）に呼ぶ */
  beginRound(): void {
    this.round += 1;
  }

  /** 勝敗確定時に勝者を記録する（null = 引き分けで記録なし） */
  recordWinner(winnerId: string | null): void {
    if (winnerId === null) return;
    this.wins.set(winnerId, (this.wins.get(winnerId) ?? 0) + 1);
  }

  winsOf(playerId: string): number {
    return this.wins.get(playerId) ?? 0;
  }

  /** 規定本数に到達したプレイヤー（セット勝者）。未決着なら null */
  setWinner(): string | null {
    for (const [id, w] of this.wins) {
      if (w >= this.target) return id;
    }
    return null;
  }

  isSetDecided(): boolean {
    return this.setWinner() !== null;
  }

  snapshot(): SetStateSnapshot {
    return { target: this.target, round: this.round, wins: new Map(this.wins) };
  }
}

/**
 * CPU戦(#versus-page)用の共有インスタンス。オンライン戦は OnlineGameController が
 * 自前のインスタンスを持つ（対戦セッションごとに独立させるため）。
 * versus.js（プレーンJS）からは window.BattleVersusLifecycle 経由で使う。
 * 旧 window._versusFinishing フラグの置き換え。
 */
export const versusLifecycle = new BattleLifecycle({
  log: (m) => console.log(`[VERSUS]${m}`),
});

declare global {
  interface Window {
    BattleVersusLifecycle: BattleLifecycle;
  }
}
window.BattleVersusLifecycle = versusLifecycle;
