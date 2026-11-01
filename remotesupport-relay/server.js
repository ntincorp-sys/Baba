// RemoteSupport relay server
//
// Phones (hosts) connect OUT to this server, so they work from any network:
// mobile data, hotel Wi-Fi, behind NAT. Browsers (viewers) open the page,
// enter the phone's Device ID + PIN, and get the live screen; their taps and
// swipes are sent back to the phone.
//
//   wss://<server>/host            phone  -> server (hello {id, pin}, then JPEG frames)
//   wss://<server>/view?id=..&pin=..  browser -> server (receives frames, sends input JSON)
//   https://<server>/              viewer page
//
// Run:  npm install && npm start        (PORT env var, default 8080)
// Deploy behind HTTPS (Render, Fly.io, Railway, a VPS with Caddy...) so traffic is TLS-encrypted.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8080);
const MAX_FRAME_BYTES = 2 * 1024 * 1024;     // reject frames over 2 MB
const VIEWER_BACKLOG_BYTES = 1024 * 1024;    // skip frames for a viewer that's falling behind
const MAX_VIEWERS_PER_DEVICE = 3;
const MAX_FAILED_JOINS = 5;                  // wrong PINs per device before lockout
const LOCKOUT_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS_PER_IP_PER_MIN = 20;

const viewerPage = fs.readFileSync(path.join(__dirname, "public", "index.html"));

/** id -> { host: WebSocket, pinHash: Buffer, viewers: Set<WebSocket>, failed: number, lockedUntil: number } */
const devices = new Map();
/** ip -> { count, windowStart } */
const ipAttempts = new Map();

const hashPin = (pin) => crypto.createHash("sha256").update(String(pin)).digest();
const validId = (id) => typeof id === "string" && /^\d{9}$/.test(id);
const validPin = (pin) => typeof pin === "string" && /^\d{6}$/.test(pin);

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (typeof fwd === "string" && fwd.split(",")[0].trim()) || req.socket.remoteAddress || "?";
}

function ipAllowed(ip) {
  const now = Date.now();
  const rec = ipAttempts.get(ip);
  if (!rec || now - rec.windowStart > 60_000) {
    ipAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  rec.count += 1;
  return rec.count <= MAX_ATTEMPTS_PER_IP_PER_MIN;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of ipAttempts) if (now - rec.windowStart > 60_000) ipAttempts.delete(ip);
}, 60_000).unref();

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function notifyHostViewerCount(dev) {
  if (dev.host) sendJson(dev.host, { type: "viewers", count: dev.viewers.size });
}

// ---- HTTP: serve the viewer page and a health check ------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    });
    return res.end(viewerPage);
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/host" && url.pathname !== "/view") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Heartbeat bookkeeping (handleUpgrade does not emit "connection" by itself).
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    if (url.pathname === "/host") handleHost(ws, req);
    else handleViewer(ws, req, url);
  });
});

// ---- Phone side ------------------------------------------------------------
function handleHost(ws, req) {
  let dev = null;
  let id = null;
  const helloTimer = setTimeout(() => ws.close(4000, "hello timeout"), 10_000);

  ws.on("message", (data, isBinary) => {
    if (!dev) {
      // First message must be: {"type":"hello","id":"123456789","pin":"123456"}
      if (isBinary) return ws.close(4001, "expected hello");
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return ws.close(4001, "bad hello"); }
      if (msg.type !== "hello" || !validId(msg.id) || !validPin(msg.pin)) return ws.close(4001, "bad hello");
      clearTimeout(helloTimer);
      id = msg.id;
      const existing = devices.get(id);
      if (existing && existing.host && existing.host.readyState === ws.OPEN) {
        existing.host.close(4002, "replaced by new connection");
      }
      dev = existing || { viewers: new Set(), failed: 0, lockedUntil: 0 };
      dev.host = ws;
      dev.pinHash = hashPin(msg.pin);
      dev.failed = 0;
      dev.lockedUntil = 0;
      devices.set(id, dev);
      sendJson(ws, { type: "ready", viewers: dev.viewers.size });
      log(`host ${id} online from ${clientIp(req)}`);
      return;
    }

    if (isBinary) {
      // A screen frame: fan out to viewers that are keeping up.
      for (const v of dev.viewers) {
        if (v.readyState === v.OPEN && v.bufferedAmount < VIEWER_BACKLOG_BYTES) v.send(data, { binary: true });
      }
    } else {
      // Status text from the phone (e.g. control on/off) -> forward to viewers.
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "status") for (const v of dev.viewers) sendJson(v, msg);
    }
  });

  ws.on("close", () => {
    clearTimeout(helloTimer);
    if (dev && dev.host === ws) {
      dev.host = null;
      for (const v of dev.viewers) v.close(4010, "phone stopped sharing");
      dev.viewers.clear();
      devices.delete(id);
      log(`host ${id} offline`);
    }
  });
  ws.on("error", () => {});
}

// ---- Browser side ----------------------------------------------------------
function handleViewer(ws, req, url) {
  const ip = clientIp(req);
  const id = url.searchParams.get("id") || "";
  const pin = url.searchParams.get("pin") || "";

  if (!ipAllowed(ip)) return ws.close(4029, "Too many attempts, wait a minute");
  if (!validId(id) || !validPin(pin)) return ws.close(4003, "Device ID must be 9 digits and PIN 6 digits");

  const dev = devices.get(id);
  if (!dev || !dev.host) return ws.close(4004, "That phone is not sharing right now");
  if (Date.now() < dev.lockedUntil) return ws.close(4029, "Too many wrong PINs, try again later");
  if (!crypto.timingSafeEqual(hashPin(pin), dev.pinHash)) {
    dev.failed += 1;
    if (dev.failed >= MAX_FAILED_JOINS) {
      dev.lockedUntil = Date.now() + LOCKOUT_MS;
      dev.failed = 0;
      sendJson(dev.host, { type: "alert", message: "Several wrong PIN attempts - viewer access locked for 10 minutes" });
    }
    return ws.close(4005, "Wrong PIN");
  }
  if (dev.viewers.size >= MAX_VIEWERS_PER_DEVICE) return ws.close(4006, "Too many viewers");

  dev.failed = 0;
  dev.viewers.add(ws);
  notifyHostViewerCount(dev);
  log(`viewer joined ${id} from ${ip} (${dev.viewers.size})`);

  ws.on("message", (data, isBinary) => {
    if (isBinary || data.length > 1024) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type !== "input" || typeof msg.action !== "string") return;
    // Only forward known fields, as plain values.
    const clean = { type: "input", action: msg.action.slice(0, 16) };
    for (const k of ["x", "y", "x2", "y2", "ms"]) if (typeof msg[k] === "number" && isFinite(msg[k])) clean[k] = msg[k];
    if (dev.host) sendJson(dev.host, clean);
  });

  ws.on("close", () => {
    dev.viewers.delete(ws);
    notifyHostViewerCount(dev);
  });
  ws.on("error", () => {});
}

// Keep connections alive through proxies that drop idle sockets.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000).unref();

function log(s) {
  console.log(new Date().toISOString(), s);
}

if (require.main === module) {
  server.listen(PORT, () => log(`RemoteSupport relay listening on :${PORT}`));
}

module.exports = { server, devices };
