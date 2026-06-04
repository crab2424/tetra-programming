// @ts-check
import {
  Payload,
  JSONPayload,
  type JSONGetRoomsResponse,
  Opcodes,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type JoinRoomRequest,
  type JoinRoomResponse,
  type LeaveRoomRequest,
  type LeaveRoomResponse,
  type UpdateRoomRequest,
  type UpdateRoomResponse,
} from "./payload.js";

import { Logger } from "./logger";

/**
 * ゲーム通信用コネクションクラス
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const RELIABLE_CHANNEL_LABEL = "reliable-main";
const UNRELIABLE_CHANNEL_LABEL = "unreliable-main";
export class GameConnection {
  private ws: WebSocket;
  private pc: RTCPeerConnection;

  /**
   * 信頼性のあるデータチャンネル
   */
  private rdc: RTCDataChannel;

  /**
   * 信頼性のないデータチャンネル
   */
  private urdc: RTCDataChannel;

  private rdcFunctions: ((event: MessageEvent) => void)[] = [];
  private urdcFunctions: ((event: MessageEvent) => void)[] = [];

  public dcReady: boolean = false;

  public closed: boolean = false;

  private readonly logger = new Logger("ONLINE:Connection");

  /**
   * ゲーム通信用コネクションクラス
   * @param {string} url WebSocket URL
   * @param {(() => void)?} onClose WebSocketやDataChannelが閉じたときのコールバック関数
   */
  constructor(url: string, onClose?: () => void) {
    this.ws = new WebSocket(url);
    this.pc = new RTCPeerConnection();

    this.rdc = this.pc.createDataChannel(RELIABLE_CHANNEL_LABEL);
    this.urdc = this.pc.createDataChannel(UNRELIABLE_CHANNEL_LABEL, {
      ordered: false,
      maxRetransmits: 0,
    });

    this.rdc.onopen = () => {
      this.logger.log("Data channel opened");
      this.dcReady = true;
    };
    this.urdc.onopen = () => {
      this.logger.log("Unreliable data channel opened");
    };

    this.rdc.onmessage = (event) => {
      this.handleInbound(event).finally(() => {
        this.rdcFunctions.forEach((func) => func(event));
      });
    };
    this.urdc.onmessage = (event) => {
      this.urdcFunctions.forEach((func) => func(event));
    };

    this.rdc.onerror = (event) => {
      this.logger.error(`Data channel ${RELIABLE_CHANNEL_LABEL} error:`, event);
    };
    this.urdc.onerror = (event) => {
      this.logger.error(
        `Data channel ${UNRELIABLE_CHANNEL_LABEL} error:`,
        event,
      );
    };

    this.ws.onerror = (event) => {
      this.logger.error("WebSocket error:", event);
    };

    this.rdc.onclose = () => {
      this.logger.log("Data channel closed");
      this.dcReady = false;
      if (onClose && !this.closed) onClose();
      this.closed = true;
    };
    this.urdc.onclose = () => {
      this.logger.log("Unreliable data channel closed");
    };

    this.ws.onclose = () => {
      this.logger.log("WebSocket connection closed");
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
          this.logger.log("Received answer and set remote description");

          while (this.dcReady === false) {
            await sleep(10);
          }
          resolve();
        } else if (message.type === "candidate") {
          const sdpMid = message.sdpMid ?? message.sdp_mid ?? null;
          const sdpMLineIndex =
            message.sdpMLineIndex ?? message.sdp_m_line_index ?? null;
          if (sdpMid == null && sdpMLineIndex == null) {
            this.logger.warn(
              "Ignoring ICE candidate without sdpMid/sdpMLineIndex",
            );
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
            this.logger.warn("Failed to add ICE candidate", e);
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
    this.logger.log("Closing connection...");
    this.dcReady = false;
    this.sendRDC(Payload.close());

    try {
      this.rdc.close();
    } catch (e) {}
    try {
      this.urdc.close();
    } catch (e) {}

    this.pc.close();
    this.ws.close();
    this.logger.log("Connection closed");
  }

  addReaderFunction(func: (event: MessageEvent) => void) {
    this.rdcFunctions.push(func);
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
        this.sendRDC(Payload.binaryPong(id));
        return;
      }

      if (decoded.op === Opcodes.JSONRequest) {
        const parsed = JSON.parse(decoded.data);
        if (parsed?.type === "JSONPing" && typeof parsed.id === "string") {
          const resp = { type: "JSONPong", id: parsed.id };
          this.sendRDC(
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
  sendRDC(data: Uint8Array) {
    if (!this.dcReady) throw new Error("Data channel is not ready");
    // RTCDataChannel in browsers accepts ArrayBuffer or BufferSource
    this.rdc.send(data.buffer as unknown as ArrayBuffer);
  }

  /**
   * Send binary data over the data channel
   * @param data Uint8Array
   */
  sendURDC(data: Uint8Array) {
    if (!this.dcReady) throw new Error("Data channel is not ready");
    // RTCDataChannel in browsers accepts ArrayBuffer or BufferSource
    this.urdc.send(data.buffer as unknown as ArrayBuffer);
  }

  sendWS(message: string) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.ws.send(message);
  }

  async waitResponseRDC<T>(op: Opcodes, data: Object): Promise<T> {
    if (!this.dcReady) {
      throw new Error("Data channel is not ready");
    }

    const sendData = {
      id: crypto.randomUUID(),
      ...data,
    } as const;

    // send binary payload
    this.sendRDC(Payload.jsonRequest(op, JSON.stringify(sendData)));

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
                this.rdcFunctions = this.rdcFunctions.filter(
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
            this.rdcFunctions = this.rdcFunctions.filter((f) => f !== handler);
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
    await this.sendRDC(Payload.binaryPing(id));
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
                  this.rdcFunctions = this.rdcFunctions.filter(
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
              this.rdcFunctions = this.rdcFunctions.filter(
                (f) => f !== handler,
              );
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

  sendJsonPing(): Promise<{ id: string }> {
    return this.waitResponseRDC<{ id: string }>(Opcodes.JSONRequest, {
      type: "JSONPing",
    });
  }

  getRooms(): Promise<JSONGetRoomsResponse> {
    return this.waitResponseRDC<JSONGetRoomsResponse>(Opcodes.JSONRequest, {
      type: "JSONGetRoomsRequest",
    });
  }

  createRoom(data: Omit<CreateRoomRequest, "id">): Promise<CreateRoomResponse> {
    return this.waitResponseRDC<CreateRoomResponse>(Opcodes.JSONRequest, {
      type: "CreateRoomRequest",
      ...data,
    });
  }

  joinRoom(data: Omit<JoinRoomRequest, "id">): Promise<JoinRoomResponse> {
    return this.waitResponseRDC<JoinRoomResponse>(Opcodes.JSONRequest, {
      type: "JoinRoomRequest",
      ...data,
    });
  }

  leaveRoom(data: Omit<LeaveRoomRequest, "id">): Promise<LeaveRoomResponse> {
    return this.waitResponseRDC<LeaveRoomResponse>(Opcodes.JSONRequest, {
      type: "LeaveRoomRequest",
      ...data,
    });
  }

  updateRoom(data: Omit<UpdateRoomRequest, "id">): Promise<UpdateRoomResponse> {
    return this.waitResponseRDC<UpdateRoomResponse>(Opcodes.JSONRequest, {
      type: "UpdateRoomRequest",
      ...data,
    });
  }
}
