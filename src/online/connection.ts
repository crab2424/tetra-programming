// @ts-check

/**
 * ゲーム通信用コネクションクラス
 */
export class GameConnection {
  private transport: WebTransport;
  private masterStream: WebTransportBidirectionalStream | null = null;
  private masterWriter: WritableStreamDefaultWriter | null = null;

  /**
   * 通常ログ出力用の関数
   * @param  {...any} args 追加のログ引数
   */
  log(...args: any[]) {
    console.log("[ONLINE:Connection]", ...args);
  }

  /**
   * 警告ログ出力用の関数
   * @param  {...any} args 追加のログ引数
   */
  warn(...args: any[]) {
    console.warn("[ONLINE:Connection]", ...args);
  }

  /**
   * エラーログ出力用の関数
   * @param  {...any} args 追加のログ引数
   */
  error(...args: any[]) {
    console.error("[ONLINE:Connection]", ...args);
  }

  /**
   * 情報ログ出力用の関数
   * @param  {...any} args 追加のログ引数
   */
  info(...args: any[]) {
    console.info("[ONLINE:Connection]", ...args);
  }

  /**
   * ゲーム通信用コネクションクラス
   * @param {string} url WebTransportのサーバーURL
   * @param {WebTransportOptions | undefined} options WebTransportのオプション
   */
  constructor(
    url: string,
    options: WebTransportOptions | undefined = undefined,
  ) {
    this.transport = new WebTransport(url, options);
  }

  /**
   * WebTransportのコネクションを準備し，使用できるようにする
   */
  async ready() {
    await this.transport.ready;
    this.masterStream = await this.transport.createBidirectionalStream();
    this.masterWriter = this.masterStream.writable.getWriter();
  }

  /**
   * WebTransportのコネクションを閉じる
   */
  async close() {
    if (this.masterWriter) {
      await this.masterWriter.close();
    }
    await this.transport.close();
  }

  /**
   * 生データをDatagramとして送信する
   * @param {Uint8Array} payload 送信するデータ
   */
  async sendDGRAM(payload: Uint8Array) {
    const writer = this.transport.datagrams.writable.getWriter();
    try {
      await writer.write(payload);
    } finally {
      writer.releaseLock();
    }
  }

  /**
   * 生データをBIマスターストリームに送信する
   * @param {Uint8Array} payload 送信するデータ
   */
  async sendBI(payload: Uint8Array) {
    if (!this.masterWriter) {
      throw new Error("Master stream is not ready");
    }
    await this.masterWriter.write(payload);
  }
}
