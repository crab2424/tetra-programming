// ─────────────────────────────────────────────
// fsa.ts
// File System Access API（Chrome / Edge）の薄いラッパ。
// 一度選んだファイルのハンドルは IndexedDB に保存し、次回からは許可の確認だけで読み書きできる。
// 型は lib.dom に無い部分だけ最小限で宣言する。
// ─────────────────────────────────────────────

export interface FsHandle {
    name: string;
    getFile(): Promise<File>;
    createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
    queryPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
    requestPermission?(o: { mode: 'readwrite' }): Promise<PermissionState>;
}
type PickerTypes = { description: string; accept: Record<string, string[]> }[];
type SavePicker = (o: { suggestedName: string; types: PickerTypes }) => Promise<FsHandle>;
type OpenPicker = (o: { types: PickerTypes; multiple: boolean }) => Promise<FsHandle[]>;

const JSON_TYPES: PickerTypes = [{ description: 'JSON', accept: { 'application/json': ['.json'] } }];

/** ファイルを選んで書けるか（File System Access。Chrome / Edge）。dev サーバーの書き込み口は dev-files.ts */
export function canPickFiles(): boolean {
    const w = window as unknown as { showSaveFilePicker?: unknown; showOpenFilePicker?: unknown };
    return typeof w.showSaveFilePicker === 'function' && typeof w.showOpenFilePicker === 'function';
}

// ─── IndexedDB（ハンドル保存用の最小ラッパ） ───
const DB_NAME = 'tetlabo-quiz-editor';
const STORE = 'handles';

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
    return new Promise(resolve => {
        try {
            const open = indexedDB.open(DB_NAME, 1);
            open.onupgradeneeded = () => open.result.createObjectStore(STORE);
            open.onerror = () => resolve(undefined);
            open.onsuccess = () => {
                // コールバック内の例外（保存できない値など）は外側の try に届かないのでここでも捕まえる
                try {
                    const tx = open.result.transaction(STORE, mode);
                    const req = fn(tx.objectStore(STORE));
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => resolve(undefined);
                } catch {
                    resolve(undefined);
                }
            };
        } catch {
            resolve(undefined);
        }
    });
}

/** 保存済みハンドルの名前（UI 表示用。許可の確認はしない） */
export async function savedHandleName(key: string): Promise<string | null> {
    const h = await idb<FsHandle>('readonly', s => s.get(key) as IDBRequest<FsHandle>);
    return h?.name ?? null;
}

/**
 * 読み書き用のハンドルを得る。保存済みで許可があればそれを使い、無ければファイルを選ばせる。
 *   picker: 'open' = 既存ファイルを開く（tdata/pdata.json）／'save' = 無ければ作れる（解答ファイル）
 */
export async function getHandle(key: string, picker: 'open' | 'save', forcePick: boolean): Promise<FsHandle> {
    let h = forcePick ? undefined : await idb<FsHandle>('readonly', s => s.get(key) as IDBRequest<FsHandle>);
    if (h) {
        // 許可が切れていれば聞き直す。ユーザー操作が無い等で失敗したら、選び直しに回す
        try {
            const perm = await h.queryPermission?.({ mode: 'readwrite' });
            if (perm !== 'granted' && (await h.requestPermission?.({ mode: 'readwrite' })) !== 'granted') h = undefined;
        } catch {
            h = undefined;
        }
    }
    if (!h) {
        const w = window as unknown as { showSaveFilePicker: SavePicker; showOpenFilePicker: OpenPicker };
        if (picker === 'save') h = await w.showSaveFilePicker({ suggestedName: key, types: JSON_TYPES });
        else {
            // 書き込みの許可は writeText の直前に取る（ファイルピッカーがユーザー操作を使い切るので、ここで requestPermission すると
            // SecurityError: User activation is required になる）
            [h] = await w.showOpenFilePicker({ types: JSON_TYPES, multiple: false });
        }
        await idb('readwrite', s => s.put(h, key));
    }
    return h;
}

export async function readText(h: FsHandle): Promise<string> {
    return (await h.getFile()).text();
}

/** 書く直前に書き込みの許可を確かめる。確認ダイアログを押した直後（ユーザー操作が新しい）に呼ぶ */
async function ensureWritable(h: FsHandle): Promise<void> {
    if ((await h.queryPermission?.({ mode: 'readwrite' })) === 'granted') return;
    let res: PermissionState | undefined;
    try {
        res = await h.requestPermission?.({ mode: 'readwrite' });
    } catch (err) {
        throw new Error(`書き込みの許可を取れませんでした（${(err as Error).message}）。もう一度 WRITE FILE を押してください`);
    }
    if (res !== undefined && res !== 'granted') throw new Error('書き込みが許可されませんでした');
}

export async function writeText(h: FsHandle, text: string): Promise<void> {
    await ensureWritable(h);
    const w = await h.createWritable();
    await w.write(text);
    await w.close();
}

export function downloadText(fileName: string, text: string) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
}
