// @ts-check

export class Payload {
    // MARK: 各種定義
    /**
     * @enum {string}
     */
    static FieldTypes = Object.freeze({
        u8: 'u8',
        u16: 'u16',
        u32: 'u32',
        str: 'str',
    });

    /**
     * @enum {number}
     */
    static Opcodes = Object.freeze({
        SearchRooms: 0,
        CreateRoom: 1,
    });

    /**
     * @typedef {Object} PayloadDef
     * @property {string} name ペイロードの種類
     * @property {FieldTypes} type データの型
     */

    // MARK: エンコード処理
    /**
     * @private
     * @param {PayloadDef[]} schema ペイロードのスキーマ
     * @param {{[field: string]: any}} data ペイロードのデータ
     * @returns {Uint8Array} エンコードされたペイロード
     */
    static __encode(schema, data) {
        const encoder = new TextEncoder();

        /** @type {number} */
        let totalSize = 0;

        const d = schema.map(({ name, type }) => {
            const value = data[name];
            let size = 0;
            /** @type {Uint8Array?} */
            let extra = null;

            if (type === Payload.FieldTypes.u8) size = 1;
            else if (type === Payload.FieldTypes.u16) size = 2;
            else if (type === Payload.FieldTypes.u32) size = 4;
            else if (type === Payload.FieldTypes.str) {
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
            if (type === Payload.FieldTypes.u8) view.setUint8(offset, value);
            else if (type === Payload.FieldTypes.u16) view.setUint16(offset, value, true);
            else if (type === Payload.FieldTypes.u32) view.setUint32(offset, value, true);
            else if (type === Payload.FieldTypes.str) {
                if (!extra) throw new Error("String type must have extra data");
                view.setUint16(offset, extra.length, true);
                uint8View.set(extra, offset + 2);
            }
            offset += size;
        });

        return uint8View;
    }

    // MARK: ペイロード定義

    /**
     * @typedef {{ op: 0 } | { op: 1, name: string }} Payloads
     */

    /**
     * @private
     * @type {PayloadDef[]} SearchRoomsSchema
     */
    static SearchRoomsSchema = [
        { name: 'op', type: Payload.FieldTypes.u8 },
    ]

    /**
     * オンラインのルーム検索
     * @returns {Uint8Array} エンコードされたペイロード
     */
    static searchRooms() {
        return Payload.__encode(Payload.SearchRoomsSchema, { op: Payload.Opcodes.SearchRooms });
    }

    /**
     * @private
     * @type {PayloadDef[]} CreateRoomSchema
     */
    static CreateRoomSchema = [
        { name: 'op', type: Payload.FieldTypes.u8 },
        { name: 'name', type: Payload.FieldTypes.str },
    ]

    /**
     * オンラインのルーム作成
     * @param {string} name ユーザー名
     * @returns {Uint8Array} エンコードされたペイロード
     */
    static createRoom(name) {
        return Payload.__encode(Payload.CreateRoomSchema, { op: Payload.Opcodes.CreateRoom, name });
    }

    // MARK: デコード処理

    /**
     * @private
     * @type {readonly (PayloadDef[]?)[]}
     */
    static schemaOrders = Object.freeze([
        null,
        Payload.SearchRoomsSchema,
        Payload.CreateRoomSchema,
    ])

    /**
     * 送信されたデータをデコードする
     * @param {Uint8Array} buffer 受信したデータ
     * @return {Payloads} デコードされたペイロード
     */
    static __decode(buffer) {
        const view = new DataView(buffer.buffer);
        const decoder = new TextDecoder();

        const op = view.getUint8(0);
        const schema = Payload.schemaOrders[op];
        if (!schema) {
            throw new Error(`Unknown opcode: ${op}`);
        }

        const slicedSchema = schema.slice(1); // opを除外

        /** @type {{[field: string]: any}} */
        let data = { op };
        let offset = 1;

        slicedSchema.forEach(({ name, type }) => {
            if (type === Payload.FieldTypes.u8) {
                data[name] = view.getUint8(offset);
                offset += 1;
            } else if (type === Payload.FieldTypes.u16) {
                data[name] = view.getUint16(offset, true);
                offset += 2;
            }
            else if (type === Payload.FieldTypes.u32) {
                data[name] = view.getUint32(offset, true);
                offset += 4;
            }
            else if (type === Payload.FieldTypes.str) {
                const length = view.getUint16(offset, true);
                offset += 2;
                const strBytes = buffer.slice(offset, offset + length);
                data[name] = decoder.decode(strBytes);
                offset += length;
            }
        });

        return /** @type {Payloads} */ (data);
    }
}
