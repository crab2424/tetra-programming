// ─────────────────────────────────────────────────────────────
// online/net.js — オンライン対戦トランスポート層
//
// WebRTC シグナリング（WebSocket）→ RTCPeerConnection → reliable / unreliable
// の 2 本の DataChannel を確立し、サーバー(tetra-server)とフレームを送受信する。
//
// フレーム規約（Rust 側 schemas! と一致）:
//   0x01 Ping / 0x02 Pong
//   0x03 JSONRequest  = [0x03] ++ varint(len) ++ utf8(JSON)
//   0x04 JSONResponse = [0x04] ++ varint(len) ++ utf8(JSON)
//   0x06 GameEvent  (reliable)   = [0x06] ++ data（中身は Subprotocol が解釈）
//   0x07 PieceState (unreliable) = [0x07] ++ data（同上）
//
// JSON 層は wincode(varint, LittleEndian)。JsonMessage は #[serde(tag="type")] で
// variant 名そのまま（例 "JSONCreateRoomRequest"）・フィールドは camelCase。
//
// 依存なし（Subprotocol は呼び出し側が使う）。クラシック script、グローバル `OnlineNet`。
// testclient/index.html の接続ロジックを本体用にクラス化したもの。
// ─────────────────────────────────────────────────────────────
(function (root) {
  "use strict";

  // 接続先シグナリングサーバー。`window.ONLINE_SIGNALING_URL` で上書き可能。
  // 既定はローカル開発（cargo run の listen アドレス）。本番は VPS の wss URL に差し替える。
  const DEFAULT_SIGNALING_URL = "ws://127.0.0.1:8080";

  // ── wincode varint (u64, LittleEndian) ──
  function varintU64Encode(n) {
    if (n <= 250) return [n];
    if (n <= 0xffff) return [251, n & 0xff, (n >> 8) & 0xff];
    if (n <= 0xffffffff) return [252, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
    const out = [253]; let v = BigInt(n);
    for (let i = 0; i < 8; i++) { out.push(Number(v & 0xffn)); v >>= 8n; }
    return out;
  }
  function varintU64Decode(bytes, off) {
    const tag = bytes[off];
    if (tag <= 250) return [tag, off + 1];
    if (tag === 251) return [bytes[off + 1] | (bytes[off + 2] << 8), off + 3];
    if (tag === 252) return [(bytes[off + 1] | (bytes[off + 2] << 8) | (bytes[off + 3] << 16) | (bytes[off + 4] << 24)) >>> 0, off + 5];
    if (tag === 253) { let v = 0n; for (let i = 0; i < 8; i++) v |= BigInt(bytes[off + 1 + i]) << BigInt(8 * i); return [Number(v), off + 9]; }
    throw new Error("unsupported varint tag " + tag);
  }
  // JSONRequest フレーム: [0x03] ++ varint(len) ++ utf8(JSON)
  function buildJsonRequest(msgObj) {
    const utf8 = new TextEncoder().encode(JSON.stringify(msgObj));
    const lenBytes = varintU64Encode(utf8.length);
    const frame = new Uint8Array(1 + lenBytes.length + utf8.length);
    frame[0] = 0x03;
    frame.set(lenBytes, 1);
    frame.set(utf8, 1 + lenBytes.length);
    return frame;
  }

  // 一意なリクエスト ID
  const reqId = () => (root.crypto && crypto.randomUUID ? crypto.randomUUID()
    : "id-" + Date.now() + "-" + Math.floor(Math.random() * 1e9));

  class OnlineNet {
    constructor() {
      this.pc = null;
      this.ws = null;
      this.reliable = null;
      this.unreliable = null;
      this._remoteSet = false;
      this._openCount = 0;
      this._pendingCandidates = [];
      this._handlers = Object.create(null);
      // idle | connecting | signaling | ready | closed | error
      this.state = "idle";
    }

    // ── 簡易イベントバス ──
    on(ev, cb) { (this._handlers[ev] || (this._handlers[ev] = [])).push(cb); return this; }
    _emit(ev, ...args) {
      const list = this._handlers[ev];
      if (!list) return;
      for (const cb of list) { try { cb(...args); } catch (e) { console.error("[OnlineNet] handler error", ev, e); } }
    }
    _setState(s) { if (this.state === s) return; this.state = s; this._emit("state", s); }

    get isReady() { return this.state === "ready"; }

    // ── 接続開始 ──
    connect(url) {
      if (this.state === "connecting" || this.state === "signaling" || this.state === "ready") return;
      url = url || root.ONLINE_SIGNALING_URL || DEFAULT_SIGNALING_URL;
      this._remoteSet = false;
      this._openCount = 0;
      this._pendingCandidates.length = 0;
      this._setState("connecting");

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        this._setState("error");
        this._emit("error", e);
        return;
      }
      this.ws = ws;

      ws.onerror = (e) => { this._emit("wserror", e); };
      ws.onclose = () => {
        this._emit("wsclose");
        if (this.state !== "ready" && this.state !== "closed") this._setState("error");
      };
      ws.onmessage = (ev) => this._onSignal(ev);
      ws.onopen = () => this._onWsOpen();
    }

    async _onWsOpen() {
      this._setState("signaling");
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      this.pc = pc;

      pc.oniceconnectionstatechange = () => this._emit("ice", pc.iceConnectionState);
      pc.onicecandidate = (e) => {
        if (e.candidate && this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: "candidate",
            candidate: e.candidate.candidate,
            sdp_mid: e.candidate.sdpMid,
            sdp_m_line_index: e.candidate.sdpMLineIndex,
          }));
        }
      };

      // offer の SDP に載せるため createOffer の前に両チャンネルを作る
      this.reliable = pc.createDataChannel("reliable-main", { ordered: true });
      this.unreliable = pc.createDataChannel("unreliable-main", { ordered: false, maxRetransmits: 0 });
      this.reliable.binaryType = "arraybuffer";
      this.unreliable.binaryType = "arraybuffer";
      this._wireChannel(this.reliable, "reliable-main");
      this._wireChannel(this.unreliable, "unreliable-main");

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.ws.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));
      } catch (e) {
        this._setState("error");
        this._emit("error", e);
      }
    }

    async _onSignal(ev) {
      let sig;
      try { sig = JSON.parse(ev.data); } catch (_) { return; }
      if (sig.type === "answer") {
        try {
          await this.pc.setRemoteDescription({ type: "answer", sdp: sig.sdp });
          this._remoteSet = true;
          for (const c of this._pendingCandidates) await this._addCandidate(c);
          this._pendingCandidates.length = 0;
        } catch (e) { this._emit("error", e); }
      } else if (sig.type === "candidate") {
        const cand = { candidate: sig.candidate, sdpMid: sig.sdp_mid, sdpMLineIndex: sig.sdp_m_line_index };
        if (this._remoteSet) await this._addCandidate(cand);
        else this._pendingCandidates.push(cand);
      }
    }

    async _addCandidate(c) {
      try { await this.pc.addIceCandidate(c); } catch (e) { this._emit("error", e); }
    }

    _wireChannel(ch, name) {
      ch.onopen = () => {
        this._openCount++;
        this._emit("channelopen", name, this._openCount);
        if (this._openCount === 2) {
          // reliable / unreliable 両方確立 → 通信準備完了
          this._setState("ready");
          this._emit("ready");
        }
      };
      ch.onclose = () => { this._emit("channelclose", name); };
      ch.onmessage = (e) => this._handleIncoming(name, new Uint8Array(e.data));
    }

    // ── 受信ディスパッチ ──
    _handleIncoming(chName, bytes) {
      const op = bytes[0];
      switch (op) {
        case 0x02: // Pong
          this._emit("pong", chName);
          return;
        case 0x04: { // JSONResponse
          let msg = null;
          try {
            const [len, off] = varintU64Decode(bytes, 1);
            const json = new TextDecoder().decode(bytes.subarray(off, off + len));
            msg = JSON.parse(json);
          } catch (e) {
            this._emit("error", e);
            return;
          }
          this._emit("json", msg);
          return;
        }
        case 0x06: // GameEvent（相手から中継されたもの）— data 部のみ渡す
          this._emit("gameEvent", bytes.subarray(1));
          return;
        case 0x07: // PieceState（同上）
          this._emit("pieceState", bytes.subarray(1));
          return;
        default:
          this._emit("unknown", op, chName);
          return;
      }
    }

    // ── 送信 ──
    sendJson(obj) {
      if (!this.reliable || this.reliable.readyState !== "open") return false;
      if (!obj.id) obj.id = reqId();
      this.reliable.send(buildJsonRequest(obj));
      return true;
    }
    // data = Subprotocol.encode*() の戻り（opcode を含まない）
    sendGameEvent(data) {
      if (!this.reliable || this.reliable.readyState !== "open") return false;
      const f = new Uint8Array(1 + data.length); f[0] = 0x06; f.set(data, 1);
      this.reliable.send(f);
      return true;
    }
    sendPieceState(data) {
      if (!this.unreliable || this.unreliable.readyState !== "open") return false;
      const f = new Uint8Array(1 + data.length); f[0] = 0x07; f.set(data, 1);
      this.unreliable.send(f);
      return true;
    }
    ping() {
      if (!this.reliable || this.reliable.readyState !== "open") return false;
      const buf = new Uint8Array(1 + 16); buf[0] = 0x01;
      if (root.crypto && crypto.getRandomValues) crypto.getRandomValues(buf.subarray(1));
      this.reliable.send(buf);
      return true;
    }

    // ── 切断・破棄 ──
    close() {
      this._setState("closed");
      try { if (this.reliable) this.reliable.close(); } catch (_) {}
      try { if (this.unreliable) this.unreliable.close(); } catch (_) {}
      try { if (this.pc) this.pc.close(); } catch (_) {}
      try { if (this.ws) this.ws.close(); } catch (_) {}
      this.reliable = this.unreliable = this.pc = this.ws = null;
      this._openCount = 0;
      this._remoteSet = false;
      this._pendingCandidates.length = 0;
    }
  }

  OnlineNet.reqId = reqId;
  OnlineNet.buildJsonRequest = buildJsonRequest;
  OnlineNet.varintU64Encode = varintU64Encode;
  OnlineNet.varintU64Decode = varintU64Decode;

  root.OnlineNet = OnlineNet;
})(typeof window !== "undefined" ? window : globalThis);
