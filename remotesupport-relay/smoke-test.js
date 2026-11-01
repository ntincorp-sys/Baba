// End-to-end check of the relay: fake phone + fake browser viewer.
// Run: npm install && node smoke-test.js   (add --long to also check the 25 s keep-alive)
"use strict";
const assert = require("assert");
const WebSocket = require("ws");
const { server } = require("./server");

const LONG = process.argv.includes("--long");

function next(ws, pred, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    ws.on("message", function h(data, isBinary) {
      const v = isBinary ? data : JSON.parse(data.toString());
      if (pred(v, isBinary)) { clearTimeout(t); ws.off("message", h); resolve(v); }
    });
  });
}
const closed = (ws) => new Promise((r) => ws.on("close", (code, reason) => r({ code, reason: reason.toString() })));
const opened = (ws) => new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });

server.listen(0, async () => {
  const base = `ws://127.0.0.1:${server.address().port}`;
  try {
    const id = "123456789", pin = "654321";

    // Phone comes online
    const host = new WebSocket(base + "/host");
    await opened(host);
    host.send(JSON.stringify({ type: "hello", id, pin }));
    assert.equal((await next(host, (m) => m.type === "ready")).viewers, 0);

    // Wrong PIN rejected
    const bad = new WebSocket(`${base}/view?id=${id}&pin=000000`);
    assert.equal((await closed(bad)).code, 4005);

    // Unknown phone rejected
    const none = new WebSocket(`${base}/view?id=999999999&pin=${pin}`);
    assert.equal((await closed(none)).code, 4004);

    // Viewer joins, phone is told
    const count = next(host, (m) => m.type === "viewers" && m.count === 1);
    const viewer = new WebSocket(`${base}/view?id=${id}&pin=${pin}`);
    await opened(viewer);
    await count;

    // Frame phone -> viewer
    const frame = Buffer.from([0xff, 0xd8, 9, 9, 0xff, 0xd9]);
    const got = next(viewer, (_, bin) => bin);
    host.send(frame, { binary: true });
    assert.deepEqual(Buffer.from(await got), frame);

    // Input viewer -> phone, extra fields stripped
    const input = next(host, (m) => m.type === "input");
    viewer.send(JSON.stringify({ type: "input", action: "tap", x: 0.5, y: 0.25, evil: "x" }));
    assert.deepEqual(await input, { type: "input", action: "tap", x: 0.5, y: 0.25 });

    // Status phone -> viewer
    const st = next(viewer, (m) => m.type === "status");
    host.send(JSON.stringify({ type: "status", control: true }));
    assert.equal((await st).control, true);

    if (LONG) {
      // Both sockets must survive two keep-alive rounds (ws clients answer pings automatically).
      await new Promise((r) => setTimeout(r, 55_000));
      assert.equal(host.readyState, WebSocket.OPEN, "phone socket was dropped by keep-alive");
      assert.equal(viewer.readyState, WebSocket.OPEN, "viewer socket was dropped by keep-alive");
      console.log("keep-alive ok");
    }

    // Phone stops -> viewer closed
    const vc = closed(viewer);
    host.close();
    assert.equal((await vc).code, 4010);

    console.log("smoke test passed");
    process.exit(0);
  } catch (e) {
    console.error("smoke test FAILED:", e);
    process.exit(1);
  }
});
