/**
 * 途中切断UI（S4）: 相手/自分の接続喪失〜再接続猶予の表示を出す唯一の入口。
 * countdown-overlay / finish-overlay と同じ命名規則（`<prefix>dc-overlay` / `<prefix>dc-text`）で
 * index.html にDOMを用意済み。`onlineFieldPrefix`（finish_overlay.ts）で prefix を解決する。
 */

export interface DisconnectOverlayHandle {
  stop(): void;
}

const NOOP_HANDLE: DisconnectOverlayHandle = { stop() {} };

/**
 * 切断UIを表示する。`graceMs` を渡すと1秒ごとの `setInterval` で残り秒数をカウントダウンする
 * （rAFは使わない＝表示中もメインスレッドを奪わない）。
 * 自分自身の切断（サーバー側の猶予秒数が分からない）表示には `graceMs` を省略する。
 */
export function showDisconnectOverlay(prefix: string, graceMs?: number): DisconnectOverlayHandle {
  const overlay = document.getElementById(`${prefix}dc-overlay`);
  const text = document.getElementById(`${prefix}dc-text`);
  if (!overlay || !text) return NOOP_HANDLE;

  overlay.classList.add("active");

  if (graceMs === undefined) {
    text.textContent = "接続が切れました\n再接続しています…";
    return {
      stop() {
        overlay.classList.remove("active");
        text.textContent = "";
      },
    };
  }

  let remainingSec = Math.max(0, Math.ceil(graceMs / 1000));
  const render = () => {
    text.textContent = remainingSec > 0
      ? `接続が切れました\n再接続を待っています… 残り${remainingSec}秒`
      : "接続が切れました\n再接続を待っています…";
  };
  render();
  const intervalId = window.setInterval(() => {
    remainingSec = Math.max(0, remainingSec - 1);
    render();
  }, 1000);

  return {
    stop() {
      window.clearInterval(intervalId);
      overlay.classList.remove("active");
      text.textContent = "";
    },
  };
}

/** `showDisconnectOverlay` のハンドルを持たない箇所からの後始末用（DOM直叩き）。 */
export function hideDisconnectOverlay(prefix: string): void {
  document.getElementById(`${prefix}dc-overlay`)?.classList.remove("active");
  const text = document.getElementById(`${prefix}dc-text`);
  if (text) text.textContent = "";
}
