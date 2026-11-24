// 通信プロトコル番号（設計: source_assets/memory/v2.2.1/tetlabo-protocol-version-design.md）。
// アプリのバージョン(APP_VERSION = package.jsonのversion)とは別に、サーバーが接続を
// 許可するかどうかを決める値。サーバー側の同名定数(tetra-server: src/main.rs の
// PROTOCOL_VERSION)と完全一致でなければ接続は拒否される。
//
// 次のいずれかを変えたときだけ +1 し、サーバー側も同時に上げる:
//   1. シグナリング(WebSocketのJSON)の形式
//   2. ゲームフレーム(DataChannelのバイナリ)のopcode追加・形式変更・受理条件
//   3. 相手に影響する対戦ルール(おじゃまの計算・相殺など)
// それ以外の変更(見た目・PRACTICE・シングルの修正など)では上げない。
//
// 直近の変更(3→4): ZONE BATTLE ONLINE（設計 source_assets/memory/mode/tet_zone/tetlabo-zone-online-design.md）。
// 部屋の種類（battle）・ZONE BATTLE の部屋設定・Garbage 版 3（ZONE の印）・0x2C ZoneState・
// フェーズ／マージン段階の通知を足した（1・2・3 すべて）。サーバーは [4] のみ（tetra-server src/main.rs）。
// その前(2→3): テトのおじゃまの穴を送る側ではなく受ける側が着弾時に決める規則に
// 変えたため（3. 対戦ルールの変更。フレームの形は同じ）。版の違う人が混ざると穴の決まり方が
// 人によって変わるので番号を分ける。
// その前(1→2): online アカウント化(設計 v2.2.2 §7.4)。Auth.ticket・
// AuthResult.account/reconnectSecret/ticketError・Offer.reconnectSecret・
// RoomInfoNotification.accounts を追加したため（tetra-server: src/main.rs 参照）。
export const PROTOCOL_VERSION = 4;
