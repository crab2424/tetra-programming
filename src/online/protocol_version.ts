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
// 直近の変更(1→2): online アカウント化(設計 v2.2.2 §7.4)。Auth.ticket・
// AuthResult.account/reconnectSecret/ticketError・Offer.reconnectSecret・
// RoomInfoNotification.accounts を追加したため（tetra-server: src/main.rs 参照）。
export const PROTOCOL_VERSION = 2;
