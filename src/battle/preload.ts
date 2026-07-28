/**
 * オンライン対戦の素材プリロード。
 *
 * ★ 背景: これまでオンライン戦は StartMatchNotification を受けてから
 *   「対戦ページへ切替 → パペット生成(PuyoGame の canvas/画像) → 自分のエンジン初期化 →
 *    BGM再生開始」を、サーバーが固定で決めた3秒のカウントダウン
 *   (`../tetra-server/src/connection/reliable.rs`: start_time_ms = now + 3000) の中で
 *   同時に行っていた。読み込みが間に合わない端末はカウントダウンが削られ、
 *   出だしが欠ける・盤面が白いまま始まる、という状態だった。
 *
 *   そこで「対戦開始の承認 → ロード画面 → 全員のロード完了 → 開始」の順にする。
 *   全員待ちは **既存の READY / startMatch の仕組みをそのまま使う**:
 *   サーバーは start_match で「オーナー以外の全員 READY」を検証しているので、
 *   READY の送信をロード完了後まで遅らせるだけで「全員のロードが終わるまで
 *   対戦が始まらない」が成立する（プロトコル・サーバーとも無改造）。
 *
 * 起動時に済んでいるもの（= 2戦目以降は即完了する）:
 *   - tetブロック画像 (Asset.init)
 *   - ぷよ画像31枚 + おじゃま予告アイコン (PuyoGame.preloadImages / preloadOjamaImages)
 *   - SE 全て (AudioLoader.loadSe)
 * ロード画面で追加で確実にするもの:
 *   - 上記が「本当に完了しているか」の待機（起動直後に対戦へ入った場合）
 *   - オンライン対戦BGMの先読み（従来は再生と同時にストリーミングしていた）
 *   - Webフォント（Orbitron。演出・ラベルで使う）
 */

export interface PreloadStep {
  label: string;
  run: () => Promise<void>;
}

export interface PreloadOptions {
  /** 自分と相手のルール。ぷよが一人も居なければぷよ素材の待機を省く。 */
  rules?: Array<"tet" | "puyo">;
  /** BGMキー。既定はオンライン対戦BGM。 */
  bgmKey?: string;
  /** 進捗通知（完了数 / 全体数 / 直前に終わった項目名）。 */
  onProgress?: (done: number, total: number, label: string) => void;
  /** 全体のタイムアウト。超えたら未完了でも解決する（相手を待たせ続けないため）。 */
  timeoutMs?: number;
}

export const PRELOAD_TIMEOUT_MS = 10000;

function whenTetImagesReady(): Promise<void> {
  const asset = (window as any).Asset;
  const sources = (window as any).BLOCK_SOURCES;
  if (!asset || !Array.isArray(sources)) return Promise.resolve();
  const loaded = () =>
    Array.isArray(asset.blockImages) &&
    asset.blockImages.filter(Boolean).length >= sources.length;
  if (loaded()) return Promise.resolve();
  // Asset.init は base.js の window.onload で走っている。完了を短い間隔で待つ
  // （再度 init を呼ぶと二重ロードになるので呼ばない）。
  return new Promise((resolve) => {
    const started = performance.now();
    const tick = () => {
      if (loaded() || performance.now() - started > PRELOAD_TIMEOUT_MS) resolve();
      else setTimeout(tick, 50);
    };
    tick();
  });
}

function whenPuyoImagesReady(): Promise<void> {
  const puyo = (window as any).PuyoGame;
  if (!puyo?.preloadImages) return Promise.resolve();
  return new Promise<void>((resolve) => {
    // preloadImages は in-flight ガード付きで、完了済みなら即コールバックする
    puyo.preloadImages(() => resolve());
  });
}

function whenOjamaImagesReady(): Promise<void> {
  const puyo = (window as any).PuyoGame;
  if (!puyo?.preloadOjamaImages) return Promise.resolve();
  return new Promise<void>((resolve) => {
    // preloadOjamaImages も in-flight ガード付きで、完了済みなら即コールバックする
    puyo.preloadOjamaImages(() => resolve());
  });
}

function whenSeReady(): Promise<void> {
  const loader = (window as any).AudioLoader;
  if (!loader?.whenSeReady) return Promise.resolve();
  return loader.whenSeReady().then(() => undefined);
}

function whenBgmReady(key: string): Promise<void> {
  const loader = (window as any).AudioLoader;
  if (!loader?.prefetchBgm) return Promise.resolve();
  return loader.prefetchBgm(key).then(() => undefined);
}

function whenFontsReady(): Promise<void> {
  const fonts = (document as any).fonts;
  if (!fonts?.ready) return Promise.resolve();
  return fonts.ready.then(() => undefined);
}

/** タイムアウト付きで待つ（失敗・遅延で対戦開始を止めない）。 */
function withTimeout(p: Promise<void>, ms: number, label: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      console.warn(`[preload] "${label}" timed out after ${ms}ms; continuing.`);
      finish();
    }, ms);
    p.then(finish, (e) => {
      console.warn(`[preload] "${label}" failed; continuing.`, e);
      finish();
    }).finally(() => clearTimeout(timer));
  });
}

/**
 * 対戦に必要な素材を全て読み込む。**必ず解決する**（失敗・タイムアウトでも reject しない）。
 * 対戦開始をブロックし続けないことを優先し、失敗した項目は警告ログのみ残す。
 */
export async function preloadBattleAssets(options: PreloadOptions = {}): Promise<void> {
  const rules = options.rules ?? ["tet", "puyo"];
  const bgmKey = options.bgmKey ?? "online_bgm";
  const timeoutMs = options.timeoutMs ?? PRELOAD_TIMEOUT_MS;

  const steps: PreloadStep[] = [];
  if (rules.includes("tet")) {
    steps.push({ label: "ブロック画像", run: whenTetImagesReady });
  }
  if (rules.includes("puyo")) {
    steps.push({ label: "ぷよ画像", run: whenPuyoImagesReady });
    steps.push({ label: "おじゃまアイコン", run: whenOjamaImagesReady });
  }
  steps.push({ label: "効果音", run: whenSeReady });
  steps.push({ label: "BGM", run: () => whenBgmReady(bgmKey) });
  steps.push({ label: "フォント", run: whenFontsReady });

  const total = steps.length;
  let done = 0;
  options.onProgress?.(0, total, "");

  await Promise.all(
    steps.map((step) =>
      withTimeout(step.run(), timeoutMs, step.label).then(() => {
        done += 1;
        options.onProgress?.(done, total, step.label);
      }),
    ),
  );
}
