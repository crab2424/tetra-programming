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

import PuyoIcon from "../puyo-icon.png";
import TetIcon from "../tet-icon.png";

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
    id: Uuid;
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
  isPublic: boolean;
  tags: RoomTag[];
  username: string;
  rule: Games;
}

export interface CreateRoomResponse {
  id: Uuid;
  roomId: Uuid;
  /** 友人共有用の6桁ルームコード */
  code: string;
}

export interface JoinByCodeRequest {
  id: Uuid;
  code: string;
  username: string;
  rule: Games;
}

export interface JoinByCodeResponse {
  id: Uuid;
  success: boolean;
  message?: string;
  roomId?: Uuid;
}

export interface JoinRandomMatchRequest {
  id: Uuid;
  username: string;
  rule: Games;
}

export interface JoinRandomMatchResponse {
  id: Uuid;
  matched: boolean;
  roomId?: Uuid;
}

export interface CancelRandomMatchRequest {
  id: Uuid;
}

export interface CancelRandomMatchResponse {
  id: Uuid;
  success: boolean;
}

export interface JoinRoomRequest {
  id: Uuid;
  roomId: Uuid;
  username: string;
  rule: Games;
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
  isPublic: boolean;
  tags: RoomTag[];
}

export interface UpdateRoomResponse {
  id: Uuid;
  success: boolean;
  message?: string;
}

export type Games = "puyo" | "tet";

export const Games = {
  alt: {
    puyo: "PUYO",
    tet: "TET",
  } as const satisfies Record<Games, string>,

  toAlt(game: Games): string {
    return this.alt[game];
  },

  icon: {
    puyo: PuyoIcon,
    tet: TetIcon,
  } as const satisfies Record<Games, string>,

  toIcon(game: Games): string {
    return this.icon[game];
  },
};

export interface RoomInfoNotificationRequest {
  id: Uuid;
}

export interface RoomInfoNotification {
  roomId: Uuid;
  ownerId: Uuid;
  roomName: string;
  players: [Uuid, string, Games][];
  maxPlayers: number;
  tags: RoomTag[];
  matchSetting: string; // JSON-serialized match settings
  /** READY済みプレイヤーのIDリスト */
  readyPlayers: Uuid[];
  /** 各プレイヤーの自己報告RTT (ms) */
  pings: [Uuid, number][];
  /** 6桁ルームコード */
  code: string;
  /** true=ルーム一覧に表示（公開）, false=コード参加のみ（非公開）*/
  isPublic?: boolean;
}
export const isRoomInfoNotification = (
  data: any,
): data is RoomInfoNotification => {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof data.roomId === "string" &&
    typeof data.ownerId === "string" &&
    typeof data.roomName === "string" &&
    Array.isArray(data.players) &&
    typeof data.maxPlayers === "number" &&
    Array.isArray(data.tags)
  );
};

// ── Match control messages ─────────────────────────────────────────────

export interface StartMatchRequest { id: Uuid; roomId: Uuid; }
export interface StartMatchResponse { id: Uuid; success: boolean; message?: string; }
export interface StartMatchNotification {
  roomId: Uuid;
  seed: number[]; // 16 bytes shared seed
  startTimeMs: number; // UNIX epoch ms + delay, all clients start at this time
  matchSetting: string;
}
export const isStartMatchNotification = (d: any): d is StartMatchNotification =>
  d && d.type === "JSONStartMatchNotification";

export interface UpdateMatchSettingRequest { id: Uuid; roomId: Uuid; setting: string; }
export interface UpdateMatchSettingResponse { id: Uuid; success: boolean; message?: string; }
export interface UpdateMatchSettingNotification { roomId: Uuid; setting: string; }
export const isUpdateMatchSettingNotification = (d: any): d is UpdateMatchSettingNotification =>
  d && d.type === "JSONUpdateMatchSettingNotification";

export interface UpdatePlayerRuleRequest { id: Uuid; roomId: Uuid; rule: string; }
export interface UpdatePlayerRuleResponse { id: Uuid; success: boolean; message?: string; }

export interface SetReadyRequest { id: Uuid; roomId: Uuid; ready: boolean; }
export interface SetReadyResponse { id: Uuid; success: boolean; message?: string; }

export interface TimeSyncRequest { id: Uuid; }
export interface TimeSyncResponse { id: Uuid; serverTimeMs: number; }

export interface UpdatePlayerPingRequest { id: Uuid; roomId: Uuid; pingMs: number; }

/** MatchSettingのJSONスキーマ (matchSetting文字列をパースした型) */
export interface OnlineMatchSetting {
  holdEnabled: boolean;
  b2bBonus: boolean;
  garbageMultiplier: number; // 1.0 = 等倍
  /** マージンタイム（秒）。0 = 無効 */
  marginTime: number;
  /** おじゃま穴の連続率 (%) */
  garbageHoleRate: number;
  /** ライン消去時にもおじゃまが降るか（テト） */
  garbageDamageOnClear: boolean;
  /** おじゃまぷよ換算レート（ぷよ用） */
  ojamaRate: number;
}

export const defaultMatchSetting: OnlineMatchSetting = {
  holdEnabled: true,
  b2bBonus: true,
  garbageMultiplier: 1.0,
  marginTime: 96,
  garbageHoleRate: 70,
  garbageDamageOnClear: true,
  ojamaRate: 70,
};

export function parseMatchSetting(json: string): OnlineMatchSetting {
  try {
    const parsed = JSON.parse(json);
    return {
      holdEnabled: parsed.holdEnabled ?? defaultMatchSetting.holdEnabled,
      b2bBonus: parsed.b2bBonus ?? defaultMatchSetting.b2bBonus,
      garbageMultiplier: typeof parsed.garbageMultiplier === "number" ? parsed.garbageMultiplier : defaultMatchSetting.garbageMultiplier,
      marginTime: typeof parsed.marginTime === "number" ? parsed.marginTime : defaultMatchSetting.marginTime,
      garbageHoleRate: typeof parsed.garbageHoleRate === "number" ? parsed.garbageHoleRate : defaultMatchSetting.garbageHoleRate,
      garbageDamageOnClear: parsed.garbageDamageOnClear ?? defaultMatchSetting.garbageDamageOnClear,
      ojamaRate: typeof parsed.ojamaRate === "number" ? parsed.ojamaRate : defaultMatchSetting.ojamaRate,
    };
  } catch {
    return { ...defaultMatchSetting };
  }
}

export interface PauseRequest { id: Uuid; roomId: Uuid; }
export interface PauseNotification { roomId: Uuid; pausedBy: Uuid; }
export const isPauseNotification = (d: any): d is PauseNotification =>
  d && d.type === "JSONPauseNotification";

export interface ResumeRequest { id: Uuid; roomId: Uuid; }
export interface ResumeNotification { roomId: Uuid; }
export const isResumeNotification = (d: any): d is ResumeNotification =>
  d && d.type === "JSONResumeNotification";

export interface NotifyGameOverRequest { id: Uuid; roomId: Uuid; }
export interface NotifyGameOverResponse { id: Uuid; success: boolean; }

export interface WinnerNotification { roomId: Uuid; winner: Uuid | null; }
export const isWinnerNotification = (d: any): d is WinnerNotification =>
  d && d.type === "JSONWinnerNotification";

export interface PostMatchActionRequest { id: Uuid; roomId: Uuid; action: number; } // 0=rematch 1=room 2=leave
export interface PostMatchActionNotification { playerId: Uuid; roomId: Uuid; action: number; }
export const isPostMatchActionNotification = (d: any): d is PostMatchActionNotification =>
  d && d.type === "JSONPostMatchActionNotification";

export interface PlayerDisconnectedNotification { roomId: Uuid; playerId: Uuid; }
export const isPlayerDisconnectedNotification = (d: any): d is PlayerDisconnectedNotification =>
  d && d.type === "JSONPlayerDisconnectedNotification";

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
