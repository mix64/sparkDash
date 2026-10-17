import { test } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import { registerCpuClockRoutes } from "../routes.js";
import { CpuClockManager } from "../CpuClockManager.js";

async function withApp({ run, allow = () => true, remoteAddr }, fn) {
  const events = [];
  const app = express();
  app.use(express.json());
  // Test hook: pretend the browser connected from another machine.
  if (remoteAddr) app.use((req, _res, next) => { Object.defineProperty(req.socket, "remoteAddress", { value: remoteAddr, configurable: true }); next(); });
  const known = { s1: { id: "s1", name: "S1", kind: "spark" }, h1: { id: "h1", name: "H1", kind: "host" } };
  registerCpuClockRoutes(app, {
    manager: new CpuClockManager({ run }),
    registry: { getSpark: (id) => known[id] },
    recordEvent: (e) => events.push(e),
    allowRead: allow,
    allowChange: allow,
    rejectLimited: (res, message) => res.status(429).json({ error: message }),
  });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/sparks`;
  try {
    await fn(base, events);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("PUT validates, applies, records an Activity event; DELETE removes and records", async () => {
  await withApp({ run: async (_s, program) => (program.includes("MAX=") ? "RESULT=ok\nCAP=2000\nPERSIST=1" : "RESULT=ok") }, async (base, events) => {
    assert.equal((await fetch(`${base}/s1/cpu-clock`, json("PUT", { maxMHz: "2000; id" }))).status, 400);
    const ok = await fetch(`${base}/s1/cpu-clock`, json("PUT", { maxMHz: 2000, persist: true }));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { success: true, capMHz: 2000, persist: true });
    assert.equal((await fetch(`${base}/s1/cpu-clock`, json("DELETE"))).status, 200);
    assert.deepEqual(events.map((e) => [e.type, e.message]), [
      ["cpu.clock.set", "CPU clock capped at 2000 MHz (kept after reboot)"],
      ["cpu.clock.reset", "CPU clock cap removed"],
    ]);
  });
});

test("host units, unknown units and rate-limited callers are refused before anything runs", async () => {
  const run = async () => { throw new Error("must not run"); };
  await withApp({ run }, async (base) => {
    assert.equal((await fetch(`${base}/h1/cpu-clock`, json("PUT", { maxMHz: 2000 }))).status, 400);
    assert.equal((await fetch(`${base}/nope/cpu-clock`)).status, 404);
  });
  await withApp({ run, allow: () => false }, async (base) => {
    assert.equal((await fetch(`${base}/s1/cpu-clock`, json("PUT", { maxMHz: 2000 }))).status, 429);
    assert.equal((await fetch(`${base}/s1/cpu-clock`)).status, 429);
  });
});

test("a refused action comes back with its code and no event is recorded", async () => {
  await withApp({ run: async () => "RESULT=error\nCODE=no-sudo\nMSG=passwordless sudo is required" }, async (base, events) => {
    const res = await fetch(`${base}/s1/cpu-clock`, json("DELETE"));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "no-sudo");
    assert.equal(events.length, 0);
  });
});

test("GET /command needs no access to the unit; status says whether a password is accepted here", async () => {
  await withApp({ run: async () => "RESULT=ok\nHWMAX=3900000\nHWMIN=338000\nSUDO=no\nCAP=0\nSVC_INSTALLED=0" }, async (base) => {
    const cmd = await fetch(`${base}/s1/cpu-clock/command?action=apply&maxMHz=2000&persist=1`);
    assert.match((await cmd.json()).command, /cap the CPU clock at 2000 MHz/);
    assert.equal((await fetch(`${base}/s1/cpu-clock/command?action=apply&maxMHz=abc`)).status, 400);
    assert.equal((await (await fetch(`${base}/s1/cpu-clock`)).json()).passwordAllowed, true);
  });
  await withApp({ run: async () => "RESULT=ok\nHWMAX=3900000\nSUDO=no\nCAP=0", remoteAddr: "192.168.1.20" }, async (base) => {
    assert.equal((await (await fetch(`${base}/s1/cpu-clock`)).json()).passwordAllowed, false);
    const put = await fetch(`${base}/s1/cpu-clock`, json("PUT", { maxMHz: 2000, sudoPassword: "pw" }));
    assert.equal(put.status, 400);
    assert.equal((await put.json()).code, "insecure-transport");
  });
});
