// @ts-check
import {
  Payload,
  JSONPayload,
  type JSONGetRoomsResponse,
  Opcodes,
} from "./payload.js";

/**
 * ゲーム通信用コネクションクラス
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export class GameConnection {
  private ws: WebSocket;
  private pc: RTCPeerConnection;

  private dc: RTCDataChannel;

  private dcFunctions: ((event: MessageEvent) => void)[] = [];

  public dcReady: boolean = false;

  public closed: boolean = false;

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
   * @param {string} url WebSocket URL
   * @param {(() => void)?} onClose WebSocketやDataChannelが閉じたときのコールバック関数
   */
  constructor(url: string, onClose?: () => void) {
    this.ws = new WebSocket(url);
    this.pc = new RTCPeerConnection();

    this.dc = this.pc.createDataChannel("game-payload", {
      ordered: false,
      maxRetransmits: 0,
    });

    this.dc.onopen = () => {
      this.log("Data channel opened");
      this.dcReady = true;
    };

    this.dc.onmessage = (event) => {
      this.handleInbound(event).finally(() => {
        this.dcFunctions.forEach((func) => func(event));
      });
    };

    this.dc.onerror = (event) => {
      this.error("Data channel `game-payload` error:", event);
    };

    this.ws.onerror = (event) => {
      this.error("WebSocket error:", event);
    };

    this.dc.onclose = () => {
      this.log("Data channel closed");
      this.dcReady = false;
      if (onClose && !this.closed) onClose();
      this.closed = true;
    };

    this.ws.onclose = () => {
      this.log("WebSocket connection closed");
      if (onClose && !this.closed) onClose();
      this.closed = true;
    };

    this.pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const msg = {
        type: "candidate",
        candidate: event.candidate.candidate,
        sdp_mid: event.candidate.sdpMid,
        sdp_m_line_index: event.candidate.sdpMLineIndex,
      };
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      }
    };
  }

  /**
   * WebSocketコネクションを準備して，WebRTCのOfferを送信する
   */
  ready() {
    return new Promise<void>(async (resolve, reject) => {
      while (
        this.ws.readyState !== WebSocket.OPEN &&
        this.ws.readyState !== WebSocket.CLOSED
      ) {
        await sleep(10);
      }

      if (this.ws.readyState === WebSocket.CLOSED) {
        reject(new Error("WebSocket connection failed"));
        return;
      }

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      this.ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);

        if (message.type === "answer") {
          await this.pc.setRemoteDescription(
            new RTCSessionDescription(message),
          );
          this.log("Received answer and set remote description");

          while (this.dcReady === false) {
            await sleep(10);
          }
          resolve();
        } else if (message.type === "candidate") {
          const sdpMid = message.sdpMid ?? message.sdp_mid ?? null;
          const sdpMLineIndex =
            message.sdpMLineIndex ?? message.sdp_m_line_index ?? null;
          if (sdpMid == null && sdpMLineIndex == null) {
            this.warn("Ignoring ICE candidate without sdpMid/sdpMLineIndex");
            return;
          }
          try {
            await this.pc.addIceCandidate(
              new RTCIceCandidate({
                candidate: message.candidate,
                sdpMid,
                sdpMLineIndex,
              }),
            );
          } catch (e) {
            this.warn("Failed to add ICE candidate", e);
          }
        }
      };

      this.ws.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));
    });
  }

  /**
   * 各種コネクションを閉じる
   */
  async close() {
    this.log("Closing connection...");
    this.dcReady = false;
    this.dc.close();
    this.pc.close();
    this.ws.close();
    this.log("Connection closed");
  }

  addReaderFunction(func: (event: MessageEvent) => void) {
    this.dcFunctions.push(func);
  }

  private async handleInbound(event: MessageEvent) {
    const data = event.data;
    let buf: Uint8Array | null = null;
    if (data instanceof ArrayBuffer) buf = new Uint8Array(data);
    else if (data instanceof Blob) {
      const ab = await data.arrayBuffer();
      buf = new Uint8Array(ab);
    } else if (data instanceof Uint8Array) buf = data;
    else if (data?.buffer instanceof ArrayBuffer)
      buf = new Uint8Array(data.buffer);

    if (!buf) return;

    try {
      const decoded = Payload.decode(buf);
      if (decoded.op === Opcodes.Ping) {
        const id = Payload.bytesToUuid(decoded.idBytes);
        await this.sendBI(Payload.binaryPong(id));
        return;
      }

      if (decoded.op === Opcodes.JSONRequest) {
        const parsed = JSON.parse(decoded.data);
        if (parsed?.type === "JSONPing" && typeof parsed.id === "string") {
          const resp = { type: "JSONPong", id: parsed.id };
          await this.sendBI(
            Payload.jsonResponse(Opcodes.JSONResponse, JSON.stringify(resp)),
          );
        }
      }
    } catch (e) {
      // ignore decode errors
    }
  }

  /**
   * Send binary data over the data channel
   * @param data Uint8Array
   */
  async sendBI(data: Uint8Array) {
    if (!this.dcReady) throw new Error("Data channel is not ready");
    // RTCDataChannel in browsers accepts ArrayBuffer or BufferSource
    this.dc.send(data.buffer as unknown as ArrayBuffer);
  }

  async sendWS(message: string) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.ws.send(message);
  }

  async sendDC(message: string) {
    if (!this.dcReady) {
      throw new Error("Data channel is not ready");
    }
    this.dc.send(message);
  }

  async waitResponseBI<T>(op: Opcodes, data: Object): Promise<T> {
    if (!this.dcReady) {
      throw new Error("Data channel is not ready");
    }

    const sendData = {
      id: crypto.randomUUID(),
      ...data,
    } as const;

    // send binary payload
    await this.sendBI(Payload.jsonRequest(op, JSON.stringify(sendData)));

    return new Promise((resolve) => {
      let responseReceived = false;
      const handler = (event: MessageEvent) => {
        if (responseReceived) return;
        try {
          const data = event.data;
          // normalize to Uint8Array
          let buf: Uint8Array;
          if (data instanceof ArrayBuffer) buf = new Uint8Array(data);
          else if (data instanceof Blob) {
            // Blob: convert to ArrayBuffer asynchronously
            const reader = new FileReader();
            reader.onload = () => {
              const ab = reader.result as ArrayBuffer;
              const b = new Uint8Array(ab);
              const decoded = JSONPayload.fromPayload(b);
              if ("id" in decoded && decoded.id === sendData.id) {
                responseReceived = true;
                this.dcFunctions = this.dcFunctions.filter(
                  (f) => f !== handler,
                );
                resolve(decoded as T);
              }
            };
            reader.readAsArrayBuffer(data);
            return;
          } else if (data instanceof Uint8Array) buf = data;
          else if (data.buffer instanceof ArrayBuffer)
            buf = new Uint8Array(data.buffer);
          else return;

          const decoded = JSONPayload.fromPayload(buf);
          if ("id" in decoded && decoded.id === sendData.id) {
            responseReceived = true;
            this.dcFunctions = this.dcFunctions.filter((f) => f !== handler);
            resolve(decoded as T);
          }
        } catch (e) {
          // ignore parse errors
        }
      };

      this.addReaderFunction(handler);
    });
  }

  async sendBinaryPing(): Promise<string> {
    const id = crypto.randomUUID();
    await this.sendBI(Payload.binaryPing(id));
    return this.waitBinaryPong(id);
  }

  async waitBinaryPong(id: string): Promise<string> {
    return new Promise((resolve) => {
      let responseReceived = false;
      const handler = (event: MessageEvent) => {
        if (responseReceived) return;
        try {
          const data = event.data;
          let buf: Uint8Array;
          if (data instanceof ArrayBuffer) buf = new Uint8Array(data);
          else if (data instanceof Blob) {
            const reader = new FileReader();
            reader.onload = () => {
              const ab = reader.result as ArrayBuffer;
              const b = new Uint8Array(ab);
              const decoded = Payload.decode(b);
              if (decoded.op === Opcodes.Pong) {
                const recvId = Payload.bytesToUuid(decoded.idBytes);
                if (recvId === id) {
                  responseReceived = true;
                  this.dcFunctions = this.dcFunctions.filter(
                    (f) => f !== handler,
                  );
                  resolve(recvId);
                }
              }
            };
            reader.readAsArrayBuffer(data);
            return;
          } else if (data instanceof Uint8Array) buf = data;
          else if (data.buffer instanceof ArrayBuffer)
            buf = new Uint8Array(data.buffer);
          else return;

          const decoded = Payload.decode(buf);
          if (decoded.op === Opcodes.Pong) {
            const recvId = Payload.bytesToUuid(decoded.idBytes);
            if (recvId === id) {
              responseReceived = true;
              this.dcFunctions = this.dcFunctions.filter((f) => f !== handler);
              resolve(recvId);
            }
          }
        } catch (e) {
          // ignore parse errors
        }
      };

      this.addReaderFunction(handler);
    });
  }

  async sendJsonPing(): Promise<{ id: string }> {
    return this.waitResponseBI<{ id: string }>(Opcodes.JSONRequest, {
      type: "JSONPing",
    });
  }

  getRooms(): Promise<JSONGetRoomsResponse> {
    return this.waitResponseBI<JSONGetRoomsResponse>(Opcodes.JSONRequest, {
      type: "JSONGetRoomsRequest",
    });
  }
}
