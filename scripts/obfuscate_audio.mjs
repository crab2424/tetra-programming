#!/usr/bin/env node
// ─────────────────────────────────────────────
// 音源(.ogg)を難読化して .dat に変換する。
//
// 配布元の規約（OpenTracks の「エンドユーザーが容易に音声ファイルとしてアクセス・複製できる
// 状態での利用」の禁止、効果音ラボ・Springin' の「可能な範囲で隠す」依頼）に対応するため、
// 公開リポジトリ・配信サーバーには .ogg を置かず、この .dat だけを置く。
// ブラウザ側は public/core/base.js の deobfuscateAudio() で元の .ogg バイト列に戻して再生する。
//
// 使い方:
//   node scripts/obfuscate_audio.mjs [入力ディレクトリ] [出力ディレクトリ]
//   既定: source_assets/audio_ogg → public/assets/audio
//   入力ディレクトリ配下の *.ogg を、同じ相対パスの *.dat として出力する。
//
// ★ 音源を差し替えたら、このスクリプトを実行したうえで base.js の ASSET_VERSION を +1 すること。
// ★ 形式（MAGIC / SEED / 鍵ストリーム）を変えたら base.js の deobfuscateAudio() も必ず揃えること。
// ─────────────────────────────────────────────

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative, dirname } from "node:path";

const MAGIC = [0x54, 0x4c, 0x41, 0x01]; // "TLA\x01"
const SEED = 0x7e71ab0d;

// xorshift32 の鍵ストリームと XOR する（復号も同じ処理）。4バイトごとに1語生成し、
// 下位バイトから順に使う。エンディアンに依存しないようバイト単位で取り出す。
function xorStream(bytes) {
    let s = SEED >>> 0;
    for (let i = 0; i < bytes.length; i += 4) {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;  s >>>= 0;
        for (let k = 0; k < 4 && i + k < bytes.length; k++) {
            bytes[i + k] ^= (s >>> (k * 8)) & 0xff;
        }
    }
    return bytes;
}

async function* walk(dir) {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) yield* walk(p);
        else if (ent.isFile() && ent.name.toLowerCase().endsWith(".ogg")) yield p;
    }
}

const inDir = process.argv[2] ?? "source_assets/audio_ogg";
const outDir = process.argv[3] ?? "public/assets/audio";

let count = 0;
for await (const src of walk(inDir)) {
    const rel = relative(inDir, src).replace(/\.ogg$/i, ".dat");
    const dst = join(outDir, rel);
    const body = xorStream(new Uint8Array(await readFile(src)));
    const out = new Uint8Array(MAGIC.length + body.length);
    out.set(MAGIC, 0);
    out.set(body, MAGIC.length);
    await mkdir(dirname(dst), { recursive: true });
    await writeFile(dst, out);
    console.log(`${src} → ${dst}`);
    count++;
}
console.log(`${count} file(s) converted.`);
