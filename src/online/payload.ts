// @ts-check

// MARK: 各種定義

type PayloadDef = {
  name: string;
  type: string;
};

enum FieldTypes {
  u8 = "u8",
  u16 = "u16",
  u32 = "u32",
  str = "str",
}

enum Opcodes {
  /** JSONでのサーバーへの要求 (応答必須) */
  JSONRequest = 0x10,
  /** JSONでのサーバーからの応答 */
  JSONResponse = 0x11,
  /** JSONでのサーバーへのデータ送信 (応答なし) */
  JSONtoServer = 0x12,
  /** JSONでのサーバーからのデータ送信 */
  JSONtoClient = 0x13,
}

export class Payload {
  // MARK: エンコード処理
  private static __encode(
    schema: PayloadDef[],
    data: { [field: string]: any },
  ): Uint8Array {
    const encoder = new TextEncoder();

    /** @type {number} */
    let totalSize = 0;

    const d = schema.map(({ name, type }) => {
      const value = data[name];
      let size = 0;
      /** @type {Uint8Array?} */
      let extra = null;

      if (type === FieldTypes.u8) size = 1;
      else if (type === FieldTypes.u16) size = 2;
      else if (type === FieldTypes.u32) size = 4;
      else if (type === FieldTypes.str) {
        extra = encoder.encode(value);
        size = 2 + extra.length;
      } else {
        throw new Error(`Unsupported type: ${type}`);
      }

      totalSize += size;
      return { name, type, value, size, extra };
    });

    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const uint8View = new Uint8Array(buffer);

    /** @type {number} */
    let offset = 0;

    d.forEach(({ type, value, size, extra }) => {
      if (type === FieldTypes.u8) view.setUint8(offset, value);
      else if (type === FieldTypes.u16) view.setUint16(offset, value, true);
      else if (type === FieldTypes.u32) view.setUint32(offset, value, true);
      else if (type === FieldTypes.str) {
        if (!extra) throw new Error("String type must have extra data");
        view.setUint16(offset, extra.length, true);
        uint8View.set(extra, offset + 2);
      }
      offset += size;
    });

    return uint8View;
  }

  // MARK: ペイロード定義

  private static readonly JSONRequestSchema: PayloadDef[] = [
    { name: "op", type: FieldTypes.u8 },
    { name: "data", type: FieldTypes.str },
  ];

  /**
   * JSONRequest
   */
  static jsonRequest(data: string): Uint8Array {
    return Payload.__encode(Payload.JSONRequestSchema, {
      op: Opcodes.JSONRequest,
      data: data,
    });
  }

  private static readonly JSONResponseSchema: PayloadDef[] = [
    { name: "op", type: FieldTypes.u8 },
    { name: "data", type: FieldTypes.str },
  ];

  // MARK: デコード処理

  private static readonly schemaCatalogs: { [opcode: number]: PayloadDef[] } = {
    [Opcodes.JSONRequest]: Payload.JSONRequestSchema,
    [Opcodes.JSONResponse]: Payload.JSONResponseSchema,
  };

  /**
   * 送信されたデータをデコードする (`Object`を返すので型ガードが必要)
   */
  static __decode(buffer: Uint8Array): Object {
    const view = new DataView(buffer.buffer);
    const decoder = new TextDecoder();

    const op = view.getUint8(0);
    const schema = Payload.schemaCatalogs[op];
    if (!schema) {
      throw new Error(`Unknown opcode: ${op}`);
    }

    const slicedSchema = schema.slice(1); // opを除外

    let data: { [field: string]: any } = { op };
    let offset = 1;

    slicedSchema.forEach(({ name, type }) => {
      if (type === FieldTypes.u8) {
        data[name] = view.getUint8(offset);
        offset += 1;
      } else if (type === FieldTypes.u16) {
        data[name] = view.getUint16(offset, true);
        offset += 2;
      } else if (type === FieldTypes.u32) {
        data[name] = view.getUint32(offset, true);
        offset += 4;
      } else if (type === FieldTypes.str) {
        const length = view.getUint16(offset, true);
        offset += 2;
        const strBytes = buffer.slice(offset, offset + length);
        data[name] = decoder.decode(strBytes);
        offset += length;
      }
    });

    return data;
  }
}
