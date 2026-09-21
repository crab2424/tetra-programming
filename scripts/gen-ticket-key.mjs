// ─────────────────────────────────────────────
// gen-ticket-key.mjs — online チケット署名用の Ed25519 鍵ペアを生成する
// 設計: source_assets/memory/v2.2.2/tetlabo-discord-integration-design.md §7
//
//   node scripts/gen-ticket-key.mjs                    新しい鍵ペアを生成
//   node scripts/gen-ticket-key.mjs --public-from <秘密鍵>  秘密鍵から公開鍵を再計算（鍵ローテーション・紛失時）
//
// 出力の登録先:
//   秘密鍵 (TICKET_PRIVATE_KEY) … Cloudflare の citgame Worker の Secret。**リポジトリ・チャット等に貼らない**
//   公開鍵 (TICKET_PUBLIC_KEY)  … tetra-server の env（EC2 の override.conf）。公開しても問題ない
// ─────────────────────────────────────────────

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

// Ed25519 の SPKI(DER) は 12byte のヘッダ + 32byte の生公開鍵。tetra-server は生の32byteを使う。
function rawPublicKeyBase64(publicKey) {
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32).toString('base64');
}

// 生成した鍵で実際に署名→検証できることを確かめてから出力する。
function selfTest(privateKey, publicKey) {
  const msg = Buffer.from('tetlabo-ticket-self-test');
  const sig = sign(null, msg, privateKey);
  if (!verify(null, msg, publicKey, sig)) throw new Error('self-test failed: signature did not verify');
}

const args = process.argv.slice(2);
let privateKey;
let publicKey;

if (args[0] === '--public-from') {
  if (!args[1]) {
    console.error('usage: node scripts/gen-ticket-key.mjs --public-from <TICKET_PRIVATE_KEY>');
    process.exit(1);
  }
  privateKey = createPrivateKey({ key: Buffer.from(args[1], 'base64'), format: 'der', type: 'pkcs8' });
  publicKey = createPublicKey(privateKey);
} else {
  ({ privateKey, publicKey } = generateKeyPairSync('ed25519'));
}

selfTest(privateKey, publicKey);

const publicB64 = rawPublicKeyBase64(publicKey);

if (args[0] === '--public-from') {
  console.log(`TICKET_PUBLIC_KEY=${publicB64}`);
} else {
  const privateB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  console.log('# ── Cloudflare (citgame Worker) の Secret に登録。他所に貼らない ──');
  console.log(`TICKET_PRIVATE_KEY=${privateB64}`);
  console.log('');
  console.log('# ── tetra-server (EC2 override.conf) に登録。公開してよい ──');
  console.log(`TICKET_PUBLIC_KEY=${publicB64}`);
}
