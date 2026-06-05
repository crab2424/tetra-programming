// @ts-check

import {
  Array as BincodeArray,
  Struct,
  String as BincodeString,
  array,
  u8,
  encode,
  decode,
  BincodeConfig,
} from "bincode-ts";
import { RoomTag } from "./room";

export enum Opcodes {
  /** バイナリPing */
  Ping = 0x01,
  /** バイナリPong */
  Pong = 0x02,
  /** JSONでのサーバーへの要求 (応答必須) */
  JSONRequest = 0x03,
  /** JSONでのサーバーからの応答 */
  JSONResponse = 0x04,
  /** 接続切断 */
  Close = 0x05,
}

const JSONRequestPayloadType = Struct({
  data: BincodeString,
});

const JSONResponsePayloadType = Struct({
  data: BincodeString,
});

const UuidBytesType = BincodeArray(u8, 16);

const PingPayloadType = Struct({
  id: UuidBytesType,
});

const PongPayloadType = Struct({
  id: UuidBytesType,
});

const ClosePayloadType = Struct({});

export type Uuid = `${string}-${string}-${string}-${string}-${string}`;

export class Payload {
  private static estimateStringSize(value: string): number {
    return 8 + new TextEncoder().encode(value).length;
  }

  private static estimateUuidBytesSize(): number {
    return 16;
  }

  private static encodeWithOp(
    op: Opcodes,
    payloadSize: number,
    encodeFn: (buffer: ArrayBuffer) => void,
  ): Uint8Array {
    const buffer = new ArrayBuffer(1 + payloadSize);
    const view = new DataView(buffer);
    view.setUint8(0, op);
    encodeFn(buffer);
    return new Uint8Array(buffer);
  }

  /**
   * JSONRequest
   */
  static jsonRequest(op: Opcodes, data: string): Uint8Array {
    const payloadSize = Payload.estimateStringSize(data);
    return Payload.encodeWithOp(op, payloadSize, (buffer) => {
      encode(
        JSONRequestPayloadType,
        { data },
        buffer,
        1,
        BincodeConfig.STANDARD,
      );
    });
  }

  static jsonResponse(op: Opcodes, data: string): Uint8Array {
    const payloadSize = Payload.estimateStringSize(data);
    return Payload.encodeWithOp(op, payloadSize, (buffer) => {
      encode(
        JSONResponsePayloadType,
        { data },
        buffer,
        1,
        BincodeConfig.STANDARD,
      );
    });
  }

  static binaryPing(id: Uuid): Uint8Array {
    const payloadSize = Payload.estimateUuidBytesSize();
    return Payload.encodeWithOp(Opcodes.Ping, payloadSize, (buffer) => {
      encode(
        PingPayloadType,
        { id: Payload.uuidToBytes(id) },
        buffer,
        1,
        BincodeConfig.STANDARD,
      );
    });
  }

  static binaryPong(id: Uuid): Uint8Array {
    const payloadSize = Payload.estimateUuidBytesSize();
    return Payload.encodeWithOp(Opcodes.Pong, payloadSize, (buffer) => {
      encode(
        PongPayloadType,
        { id: Payload.uuidToBytes(id) },
        buffer,
        1,
        BincodeConfig.STANDARD,
      );
    });
  }

  static close(): Uint8Array {
    return Payload.encodeWithOp(Opcodes.Close, 0, (buffer) => {
      encode(ClosePayloadType, {}, buffer, 1, BincodeConfig.STANDARD);
    });
  }

  static decode(
    buffer: Uint8Array,
  ):
    | { op: Opcodes.JSONRequest | Opcodes.JSONResponse; data: string }
    | { op: Opcodes.Ping | Opcodes.Pong; idBytes: number[] } {
    if (buffer.length < 2) {
      throw new Error("Payload is too short");
    }
    const op = buffer[0];
    const offset = buffer.byteOffset + 1;
    const ab = buffer.buffer as ArrayBuffer;

    switch (op) {
      case Opcodes.Ping: {
        const { value } = decode(
          PingPayloadType,
          ab,
          offset,
          BincodeConfig.STANDARD,
        );
        return { op, idBytes: value.id };
      }
      case Opcodes.Pong: {
        const { value } = decode(
          PongPayloadType,
          ab,
          offset,
          BincodeConfig.STANDARD,
        );
        return { op, idBytes: value.id };
      }
      case Opcodes.JSONRequest: {
        const { value } = decode(
          JSONRequestPayloadType,
          ab,
          offset,
          BincodeConfig.STANDARD,
        );
        return { op, data: value.data };
      }
      case Opcodes.JSONResponse: {
        const { value } = decode(
          JSONResponsePayloadType,
          ab,
          offset,
          BincodeConfig.STANDARD,
        );
        return { op, data: value.data };
      }
      default:
        throw new Error(`Unknown opcode: ${op}`);
    }
  }

  static uuidToBytes(uuid: Uuid): number[] & { readonly length: 16 } {
    const hex = uuid.replace(/-/g, "");
    if (hex.length !== 32) {
      throw new Error("Invalid UUID format");
    }
    const out: number[] = [];
    for (let i = 0; i < 32; i += 2) {
      out.push(parseInt(hex.slice(i, i + 2), 16));
    }
    return array(
      out[0],
      out[1],
      out[2],
      out[3],
      out[4],
      out[5],
      out[6],
      out[7],
      out[8],
      out[9],
      out[10],
      out[11],
      out[12],
      out[13],
      out[14],
      out[15],
    );
  }

  static bytesToUuid(bytes: number[]): Uuid {
    if (bytes.length !== 16) {
      throw new Error("Invalid UUID bytes length");
    }
    const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}

export interface JSONGetRoomsResponse {
  id: Uuid;
  rooms: {
    id: string;
    roomName: string;
    players: number;
    maxPlayers: number;
    locked: boolean;
    tags: RoomTag[];
  }[];
}

export interface CreateRoomRequest {
  id: Uuid;
  roomName: string;
  maxPlayers: number;
  password?: string;
  tags: RoomTag[];
}

export interface CreateRoomResponse {
  id: Uuid;
  roomId: Uuid;
}

export interface JoinRoomRequest {
  id: Uuid;
  roomId: Uuid;
  password?: string;
}

export interface JoinRoomResponse {
  id: Uuid;
  success: boolean;
  message?: string;
}

export interface LeaveRoomRequest {
  id: Uuid;
  roomId: Uuid;
}

export interface LeaveRoomResponse {
  id: Uuid;
  success: boolean;
  message?: string;
}

export interface UpdateRoomRequest {
  id: Uuid;
  roomId: Uuid;
  roomName: string;
  maxPlayers: number;
  password: string;
  tags: RoomTag[];
}

export interface UpdateRoomResponse {
  id: Uuid;
  success: boolean;
  message?: string;
}

export interface RooInfoNotification {
  roomId: Uuid;
  roomName: string;
  players: [Uuid, string][];
  maxPlayers: number;
  tags: RoomTag[];
}

export interface RoomLeaveNotification {
  message: string;
}

export class JSONPayload {
  static toPayload(op: Opcodes, data: string): Uint8Array {
    return Payload.jsonRequest(op, data);
  }

  static fromPayload(buffer: Uint8Array): { [key: string]: any } {
    const decoded = Payload.decode(buffer);
    if (decoded.op === Opcodes.JSONResponse) {
      try {
        const parsed = JSON.parse(decoded.data);
        if (typeof parsed === "object" && parsed !== null) {
          return parsed as { [key: string]: any };
        }
        return { value: parsed } as { [key: string]: any };
      } catch (e) {
        throw new Error("Failed to parse JSON data: " + e);
      }
    } else {
      throw new Error("Invalid JSONResponse payload");
    }
  }
}
