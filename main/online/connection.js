// @ts-check

/**
 * ゲーム通信用コネクションクラス
 */
export class GameConnection {
    /**
     * @private
     * @type {WebTransport}
     */
    transport;

    /**
     * @private
     * @type {WebTransportBidirectionalStream | null}
     */
    masterStream = null;

    /**
     * @private
     * @type {WritableStreamDefaultWriter | null}
     */
    masterWriter = null;

    /**
     * ゲーム通信用コネクションクラス
     * @param {string} url WebTransportのサーバーURL
     * @param {WebTransportOptions | undefined} options WebTransportのオプション
     */
    constructor(url, options = undefined) {
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
    async sendDatagram(payload) {
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
    async sendBI(payload) {
        if (!this.masterWriter) {
            throw new Error("Master stream is not ready");
        }
        await this.masterWriter.write(payload);
    }
}
