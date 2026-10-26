const MAX_PER_LOBBY = 20;
const DODGE_SLOTS = 6;
const ALLOWED_ORIGINS = [];

const PRESENCE_KEYS = ["nm", "lk", "x", "y", "z", "yw", "mv", "hd", "em", "emt", "b"];
const EVENTS = new Set(["chat", "dgs", "dgt", "dgend"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("Rec Room server is running.", { headers: { "content-type": "text/plain" } });
    if (url.pathname !== "/ws") return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    const origin = request.headers.get("Origin") || "";
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) return new Response("Forbidden", { status: 403 });
    let room = (url.searchParams.get("room") || "lobby-1").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) || "lobby-1";
    const stub = env.LOBBY.get(env.LOBBY.idFromName(room));
    return stub.fetch(request);
  },
};

const num = (v, d = 0) => (typeof v === "number" && isFinite(v) ? v : d);

function cleanPresence(p) {
  const o = {};
  if (!p || typeof p !== "object") return o;
  for (const k of PRESENCE_KEYS) {
    if (!(k in p)) continue;
    const v = p[k];
    if (k === "nm") o.nm = String(v == null ? "" : v).slice(0, 16);
    else if (k === "lk") o.lk = Array.isArray(v) ? v.slice(0, 16).map((n) => num(n)) : [];
    else if (k === "em") o.em = typeof v === "string" ? v.slice(0, 12) : null;
    else if (k === "b") o.b = Array.isArray(v) ? v.slice(0, 8).map((e) => (Array.isArray(e) ? e.slice(0, 9).map((n) => num(n)) : [])) : [];
    else o[k] = num(v);
  }
  return o;
}

export class Lobby {
  constructor(state, env) {
    this.state = state;
    this.peers = new Map();
    this.dg = { players: [], host: null };
  }

  async fetch(request) {
    if (this.peers.size >= MAX_PER_LOBBY) {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({ t: "full" }));
      pair[1].close(1000, "full");
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    const id = crypto.randomUUID().slice(0, 8);
    const peer = { ws: server, p: {}, tokens: 40, lastRefill: Date.now() };
    this.peers.set(id, peer);

    const others = [];
    for (const [pid, pr] of this.peers) if (pid !== id) others.push({ id: pid, p: pr.p });
    this.send(peer, { t: "hi", id, peers: others, dg: this.dgView() });
    this.broadcast({ t: "j", id, p: {} }, id);

    server.addEventListener("message", (ev) => this.onMessage(id, peer, ev.data));
    const gone = () => this.onLeave(id);
    server.addEventListener("close", gone);
    server.addEventListener("error", gone);
    return new Response(null, { status: 101, webSocket: client });
  }

  send(peer, obj) { try { peer.ws.send(JSON.stringify(obj)); } catch (e) {} }
  broadcast(obj, exceptId) {
    const s = JSON.stringify(obj);
    for (const [pid, pr] of this.peers) if (pid !== exceptId) { try { pr.ws.send(s); } catch (e) {} }
  }

  allow(peer) {
    const now = Date.now();
    peer.tokens = Math.min(40, peer.tokens + ((now - peer.lastRefill) / 1000) * 40);
    peer.lastRefill = now;
    if (peer.tokens < 1) return false;
    peer.tokens -= 1;
    return true;
  }

  onMessage(id, peer, raw) {
    if (typeof raw !== "string" || raw.length > 4000) return;
    if (!this.allow(peer)) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== "object") return;

    if (m.t === "p") {
      const patch = cleanPresence(m.d);
      Object.assign(peer.p, patch);
      this.broadcast({ t: "p", id, d: patch }, id);
    } else if (m.t === "e") {
      if (!EVENTS.has(m.k)) return;
      let d = m.d;
      if (m.k === "chat") {
        if (peer.lastChat && Date.now() - peer.lastChat < 400) return;
        peer.lastChat = Date.now();
        d = { n: String((d && d.n) || "Player").slice(0, 16), m: String((d && d.m) || "").slice(0, 120) };
        if (!d.m.trim()) return;
        this.broadcast({ t: "e", id, k: "chat", d });
      } else if (m.k === "dgs" || m.k === "dgend") {
        if (this.dg.host !== id) return;
        this.broadcast({ t: "e", id, k: m.k, d });
        if (m.k === "dgend") { this.dg.players = []; this.dg.host = null; this.broadcastDg(); }
      } else if (m.k === "dgt") {
        const h = this.peers.get(this.dg.host);
        if (h && this.dg.host !== id) this.send(h, { t: "e", id, k: "dgt", d });
      }
    } else if (m.t === "dgj") {
      if (this.dg.players.some((x) => x.id === id)) { this.broadcastDg(); return; }
      if (this.dg.players.length >= DODGE_SLOTS) { this.send(peer, { t: "dgfull" }); return; }
      const nB = this.dg.players.filter((x) => x.team === "B").length;
      const nR = this.dg.players.length - nB;
      this.dg.players.push({ id, team: nB <= nR ? "B" : "R" });
      if (!this.dg.host) this.dg.host = id;
      this.broadcastDg();
    } else if (m.t === "dgl") {
      this.dgRemove(id);
    }
  }

  dgView() {
    const nB = this.dg.players.filter((x) => x.team === "B").length;
    const nR = this.dg.players.length - nB;
    return { players: this.dg.players, host: this.dg.host, bots: { B: Math.max(0, 3 - nB), R: Math.max(0, 3 - nR) } };
  }
  broadcastDg() { this.broadcast({ t: "dg", dg: this.dgView() }); }
  dgRemove(id) {
    const before = this.dg.players.length;
    this.dg.players = this.dg.players.filter((x) => x.id !== id);
    if (this.dg.host === id) this.dg.host = this.dg.players.length ? this.dg.players[0].id : null;
    if (before !== this.dg.players.length) this.broadcastDg();
  }

  onLeave(id) {
    if (!this.peers.has(id)) return;
    this.peers.delete(id);
    this.dgRemove(id);
    this.broadcast({ t: "l", id });
  }
}
