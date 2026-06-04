export class Logger {
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  /**
   * 通常ログ出力用の関数
   * @param  {...any} args 追加のログ引数
   */
  log(...args: any[]) {
    console.log(`[${this.prefix}]`, ...args);
  }

  /**
   * 警告ログ出力用の関数
   * @param  {...any} args 追加のログ引数
   */
  warn(...args: any[]) {
    console.warn(`[${this.prefix}]`, ...args);
  }

  /**
   * エラーログ出力用の関数
   * @param  {...any} args 追加のログ引数
   */
  error(...args: any[]) {
    console.error(`[${this.prefix}]`, ...args);
  }

  /**
   * 情報ログ出力用の関数
   * @param  {...any} args 追加のログ引数
   */
  info(...args: any[]) {
    console.info(`[${this.prefix}]`, ...args);
  }
}
