/**
 * CPU戦（VERSUS / CPU TEST）のロード画面（v2.2.3 H）。
 *
 * 旧実装は「カウントダウン開始と同時に CPU を非同期ロード」していたため、START までに
 * CPU の思考 worker が ready にならないと自由落下→即置きで試合が始まっていた。
 * ここでは ONLINE と同じロード画面（loading_screen.ts / preload.ts）を使い、
 *   画像・効果音・BGM・フォント ＋ CPU（クラスJS読込 → 思考 worker を ready まで起動）
 * が揃ってからカウントダウンへ進める。
 *
 * - 全部が既に揃っている（2戦目以降の R リスタート等）なら FAST_PATH_MS 以内に終わるので、
 *   ロード画面は出さずにそのまま進む（ユーザー決定: 準備済みなら出さない）。
 * - 使い方:
 *     const prep = await BattleLocalLoading.prepare({...});
 *     if (prep.cancelled) return;
 *     …ページ切替・エンジン初期化・コントローラ生成…
 *     await BattleLocalLoading.reveal();   // ロード画面を出していた場合だけフェードイン
 */
import {
  showLoadingOverlay,
  hideLoadingOverlay,
  setLoadingProgress,
  setLoadingPlayers,
  setLoadingCancel,
  enterBlackout,
  revealBattle,
  type LoadingPlayerState,
} from "./loading_screen";
import { preloadBattleAssets } from "./preload";

/** これ以内に全ステップが終われば「準備済み」とみなしロード画面を出さない */
const FAST_PATH_MS = 80;
/** ローカルは待ち合わせが無いので ONLINE(900ms) より短く */
const LOCAL_MIN_VISIBLE_MS = 400;

export interface LocalCpuSpec {
  level: number;
  rule: "tet" | "puyo";
  /** ロード画面の準備状況に出す名前（例 "CPU LV 5"） */
  label: string;
}

export interface LocalPrepareOptions {
  rules: Array<"tet" | "puyo">;
  bgmKey?: string;
  cpus: LocalCpuSpec[];
  /** セッションが変わった（別の開始処理に追い越された）か */
  isStale: () => boolean;
}

export interface LocalPrepareResult {
  /** キャンセル・追い越し・CPU読込全滅のいずれかで中止した */
  cancelled: boolean;
  /** cpus と同じ順の CPU クラス（読込失敗は null） */
  classes: any[];
  /** CPU が1つも読めなかった */
  cpuFailed: boolean;
}

let overlayShown = false;
// 後から始まった prepare() に追い越された古い呼び出しが、新しい方のロード画面を消さないための世代
let prepGen = 0;

async function loadCpuClasses(cpus: LocalCpuSpec[], onEach: (i: number) => void): Promise<any[]> {
  const w = window as any;
  // 同じクラスは cpu_loader 側で読み込みを相乗りするので並列でよい
  // （DEV クラスを左右で使う場合も1回しか読み直さない）。
  const classes = await Promise.all(
    cpus.map((c) =>
      w.loadCpuWithFallback(c.level, c.rule).catch((e: unknown) => {
        console.warn("[local_loading] CPU load failed", c, e);
        return null;
      }),
    ),
  );
  // 同じ worker URL を何本使うか数えて、その本数ぶん ready にしておく
  const need = new Map<string, number>();
  for (const cls of classes) {
    for (const url of (cls && cls.WORKER_URLS) || []) need.set(url, (need.get(url) || 0) + 1);
  }
  const pool = w.CpuWorkerPool;
  await Promise.all(
    classes.map(async (cls, i) => {
      if (cls && pool) {
        await Promise.all(((cls.WORKER_URLS as string[]) || []).map((url) => pool.prewarm(url, need.get(url) || 1)));
      }
      onEach(i);
    }),
  );
  return classes;
}

export async function prepare(opts: LocalPrepareOptions): Promise<LocalPrepareResult> {
  const myGen = ++prepGen;
  const mine = () => myGen === prepGen;
  let shownByMe = false;
  let classes: any[] = [];
  let cancelled = false;
  let cancel: () => void = () => {};
  const cancelPromise = new Promise<void>((resolve) => {
    cancel = () => {
      cancelled = true;
      resolve();
    };
  });

  const players: LoadingPlayerState[] = opts.cpus.map((c) => ({ name: c.label, ready: false }));
  let lastProgress: [number, string] = [0, "読み込み中…"];

  const work = preloadBattleAssets({
    rules: opts.rules,
    bgmKey: opts.bgmKey ?? "versus_bgm",
    extraSteps: [
      {
        label: "CPU",
        run: async () => {
          classes = await loadCpuClasses(opts.cpus, (i) => {
            players[i].ready = true;
            if (shownByMe && mine()) setLoadingPlayers(players);
          });
        },
      },
    ],
    // CPU の wasm 初期化は遅い端末で数秒かかるので ONLINE と同じ 10 秒まで待つ
    onProgress: (done, total, label) => {
      lastProgress = [total === 0 ? 1 : done / total, label ? `${label} を読み込みました` : "読み込み中…"];
      if (shownByMe && mine()) setLoadingProgress(lastProgress[0], lastProgress[1]);
    },
  });

  const fast = await Promise.race([
    work.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), FAST_PATH_MS)),
  ]);

  if (!fast && !opts.isStale() && mine()) {
    showLoadingOverlay();
    overlayShown = true;
    shownByMe = true;
    setLoadingProgress(lastProgress[0], lastProgress[1]);
    setLoadingPlayers(players);
    setLoadingCancel({ label: "CANCEL", onCancel: cancel });
    await Promise.race([work, cancelPromise]);
  } else if (!fast) {
    await work;
  }

  // キャンセル時はまだ読み込み途中なだけなので「失敗」扱いにしない（失敗アラートを出さない）
  const cpuFailed = !cancelled && opts.cpus.length > 0 && classes.every((c) => !c);
  if (cancelled || opts.isStale() || !mine() || cpuFailed) {
    if (shownByMe && mine()) {
      hideLoadingOverlay();
      overlayShown = false;
    }
    return { cancelled: true, classes, cpuFailed };
  }

  if (shownByMe) {
    setLoadingProgress(1, "準備完了");
    setLoadingCancel(null);
    await enterBlackout(LOCAL_MIN_VISIBLE_MS);
  }
  return { cancelled: false, classes, cpuFailed: false };
}

/** prepare() でロード画面を出していた場合、真っ暗から対戦画面へフェードインする */
export function reveal(): Promise<void> {
  if (!overlayShown) return Promise.resolve();
  overlayShown = false;
  return revealBattle();
}

/** 中断経路（開始処理の途中で追い越された等）でロード画面を即座に閉じる */
export function abort(): void {
  overlayShown = false;
  hideLoadingOverlay();
}

export const BattleLocalLoading = { prepare, reveal, abort };

declare global {
  interface Window {
    BattleLocalLoading: typeof BattleLocalLoading;
  }
}
window.BattleLocalLoading = BattleLocalLoading;
