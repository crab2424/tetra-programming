// ─────────────────────────────────────────────
// keybinds.ts
// PLACE モードの操作キーを TETLABO の KEY CONFIG と同期する（設計 §5・Q6）
//   読込元: localStorage `game_binds`（public/config/settings.js の saveBinds() 形式）
//           → 無ければ旧形式 `game_keyconfig` → それも無ければエディタ既定（回転は Z/X）
//   エディタは Vite dev の同一オリジンなので、同じ dev サーバーで TETLABO を開いて保存した設定が読める。
// ─────────────────────────────────────────────

export type PlaceAction = 'moveLeft' | 'moveRight' | 'softDrop' | 'hardDrop' | 'rotateCW' | 'rotateCCW' | 'hold';
export const PLACE_ACTIONS: PlaceAction[] = ['moveLeft', 'moveRight', 'softDrop', 'hardDrop', 'rotateCW', 'rotateCCW', 'hold'];

export const ACTION_NAMES: Record<PlaceAction, string> = {
    moveLeft: '左移動', moveRight: '右移動', softDrop: 'ソフトドロップ（1段下）', hardDrop: 'ハードドロップして確定',
    rotateCW: '右回転', rotateCCW: '左回転', hold: 'HOLD（使う/使わないを切替）',
};

export interface KeyBind { code: string; label: string; }
export type BindSource = 'game_binds' | 'game_keyconfig' | 'default';
export interface PlaceBinds { source: BindSource; keys: Record<PlaceAction, KeyBind[]>; }

const EDITOR_DEFAULT: Record<PlaceAction, KeyBind[]> = {
    moveLeft: [{ code: 'ArrowLeft', label: '←' }],
    moveRight: [{ code: 'ArrowRight', label: '→' }],
    softDrop: [{ code: 'ArrowDown', label: '↓' }],
    hardDrop: [{ code: 'Space', label: 'SPACE' }],
    rotateCW: [{ code: 'KeyX', label: 'X' }],
    rotateCCW: [{ code: 'KeyZ', label: 'Z' }],
    hold: [{ code: 'KeyC', label: 'C' }],
};

function readJson(key: string): unknown {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) as unknown : null;
    } catch {
        return null;
    }
}

function asKeyBind(v: unknown): KeyBind | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    if (typeof o.code !== 'string' || !o.code) return null;
    if (o.type !== undefined && o.type !== 'key') return null;
    return { code: o.code, label: typeof o.label === 'string' && o.label ? o.label : o.code };
}

export function loadPlaceBinds(): PlaceBinds {
    // 現行形式: { action: [Bind, Bind, Bind] }（type:'key' 以外＝パッドは無視）
    const binds = readJson('game_binds');
    if (binds && typeof binds === 'object') {
        const keys = {} as Record<PlaceAction, KeyBind[]>;
        for (const a of PLACE_ACTIONS) {
            const list = (binds as Record<string, unknown>)[a];
            const kb = Array.isArray(list) ? list.map(asKeyBind).filter((b): b is KeyBind => b !== null) : [];
            keys[a] = kb.length ? kb : EDITOR_DEFAULT[a];
        }
        return { source: 'game_binds', keys };
    }
    // 旧形式: { action: {code, label} }
    const legacy = readJson('game_keyconfig');
    if (legacy && typeof legacy === 'object') {
        const keys = {} as Record<PlaceAction, KeyBind[]>;
        for (const a of PLACE_ACTIONS) {
            const kb = asKeyBind((legacy as Record<string, unknown>)[a]);
            keys[a] = kb ? [kb] : EDITOR_DEFAULT[a];
        }
        return { source: 'game_keyconfig', keys };
    }
    return { source: 'default', keys: EDITOR_DEFAULT };
}

export function actionFor(binds: PlaceBinds, code: string): PlaceAction | null {
    for (const a of PLACE_ACTIONS) if (binds.keys[a].some(b => b.code === code)) return a;
    return null;
}

export function bindLabel(binds: PlaceBinds, a: PlaceAction): string {
    return binds.keys[a].map(b => b.label).join(' / ');
}

export function sourceLabel(s: BindSource): string {
    return s === 'game_binds' ? 'TETLABO の KEY CONFIG'
        : s === 'game_keyconfig' ? 'TETLABO の KEY CONFIG（旧形式）'
        : 'エディタ既定（TETLABO の設定が見つかりません）';
}

// ─── 連続移動（DAS / ARR）: TETLABO の localStorage `game_tuning` と同期（単位はフレーム＝1/60 秒） ───
export interface PlaceTuning { source: 'game_tuning' | 'default'; dasMs: number; arrMs: number; }
const TUNING_DEFAULT = { das: 9.0, arr: 1.6 };   // public/config/settings.js の DEFAULT_TUNING と同じ
const FRAME_MS = 1000 / 60;

export function loadPlaceTuning(): PlaceTuning {
    const raw = readJson('game_tuning');
    const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
    const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : def);
    return {
        source: o ? 'game_tuning' : 'default',
        dasMs: num(o?.das, TUNING_DEFAULT.das) * FRAME_MS,
        arrMs: num(o?.arr, TUNING_DEFAULT.arr) * FRAME_MS,
    };
}

export function tuningLabel(t: PlaceTuning): string {
    return `DAS ${Math.round(t.dasMs)}ms / ARR ${Math.round(t.arrMs)}ms` + (t.source === 'default' ? '（既定値）' : '');
}
