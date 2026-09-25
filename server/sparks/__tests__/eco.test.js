import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-eco-"));
process.env.SPARKS_JSON_PATH = path.join(tmp, "sparks.json");
process.env.SPARKS_SECRETS_PATH = path.join(tmp, "sparks-secrets.json");
process.env.SECRETS_KEY_PATH = path.join(tmp, ".secrets-key");

const { applyEco, ecoScript, normalizeEco, parseEcoBody, registerEcoRoutes } =
  await import("../../eco.js");
const { SparkRegistry } = await import("../SparkRegistry.js");

function freshRegistry() {
  fs.writeFileSync(process.env.SPARKS_JSON_PATH, '{"sparks":[]}\n');
  const r = new SparkRegistry();
  r.addSpark({ id: "a", lanIp: "127.0.0.1" });
  r.addSpark({ id: "b", lanIp: "127.0.0.2" });
  return r;
}

/** Minimal express stand-in: records handlers, invokes them with a fake res. */
function fakeApp() {
  const routes = {};
  return {
    post: (p, handler) => { routes[p] = handler; },
    async call(p, params, body) {
      const res = { statusCode: 200, body: null,
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; } };
      await routes[p]({ params, body }, res);
      return res;
    },
  };
}

test("ecoScript: GPU lock/reset and CPU cap/stock restore", () => {
  assert.equal(ecoScript("gpu", "2000"), "nvidia-smi -lgc 0,2000");
  assert.equal(ecoScript("gpu", "off"), "nvidia-smi -rgc");
  assert.match(ecoScript("cpu", "1750"), /echo 1750000 > "\$d\/max_perf"/);
  assert.match(ecoScript("cpu", "off"), /cat "\$d\/cpuinfo_max_freq" > "\$d\/max_perf"/);
  assert.throws(() => ecoScript("gpu", "9999"));
  assert.throws(() => ecoScript("cpu", "2000; reboot"));
});

test("normalizeEco and parseEcoBody reject unknown levels", () => {
  assert.deepEqual(normalizeEco(undefined), { gpu: "off", cpu: "off" });
  assert.deepEqual(normalizeEco({ gpu: "2200", cpu: "42" }), { gpu: "2200", cpu: "off" });
  assert.deepEqual(parseEcoBody({ cpu: "2000" }), { levels: { cpu: "2000" } });
  assert.ok(parseEcoBody({}).error);
  assert.ok(parseEcoBody({ gpu: 2000 }).error);
});

test("applyEco keeps the channel that succeeded when the other fails", async () => {
  const run = async (_spark, script) => {
    if (script.startsWith("nvidia-smi")) throw new Error("sudo: a password is required");
  };
  const out = await applyEco({ id: "a" }, { gpu: "2000", cpu: "2000" }, run);
  assert.deepEqual(out.applied, { cpu: "2000" });
  assert.deepEqual(out.errors, ["GPU: sudo: a password is required"]);
});

test("registry: eco persists via noteEco only, never via PATCH", () => {
  const r = freshRegistry();
  assert.deepEqual(r.getSpark("a").eco, { gpu: "off", cpu: "off" });
  r.updateSpark("a", { eco: { gpu: "1800" } });
  assert.deepEqual(r.getSpark("a").eco, { gpu: "off", cpu: "off" });
  assert.ok(r.noteEco("a", { gpu: "1800" }));
  assert.equal(r.noteEco("a", { gpu: "1800" }), null);
  assert.deepEqual(new SparkRegistry().getSpark("a").eco, { gpu: "1800", cpu: "off" });
});

test("routes: single Spark applies and records; fleet skips offline units", async () => {
  const r = freshRegistry();
  const app = fakeApp();
  const scripts = [];
  const changed = [];
  registerEcoRoutes(app, {
    registry: r,
    isOnline: (id) => id === "a",
    bootAt: () => null,
    onChange: (id) => changed.push(id),
    run: async (spark, script) => { scripts.push([spark.id, script]); },
  });

  const one = await app.call("/api/sparks/:id/eco", { id: "b" }, { gpu: "2200" });
  assert.equal(one.statusCode, 200);
  assert.equal(r.getSpark("b").eco.gpu, "2200");

  const fleet = await app.call("/api/sparks/eco-all", {}, { cpu: "1500" });
  assert.deepEqual(fleet.body.results, [
    { id: "a", ok: true },
    { id: "b", ok: false, skipped: true, error: "Offline — skipped" },
  ]);
  assert.deepEqual(scripts.map(([id]) => id), ["b", "a"]);
  assert.deepEqual(changed, ["b", "a"]);

  assert.equal((await app.call("/api/sparks/:id/eco", { id: "zz" }, { gpu: "off" })).statusCode, 404);
  assert.equal((await app.call("/api/sparks/:id/eco", { id: "a" }, { gpu: "1" })).statusCode, 400);
});

test("routes: a failed command returns 500 and leaves the saved level alone", async () => {
  const r = freshRegistry();
  const app = fakeApp();
  registerEcoRoutes(app, {
    registry: r, isOnline: () => true, bootAt: () => null, onChange: () => {},
    run: async () => { throw new Error("max_perf: No such file or directory"); },
  });
  const res = await app.call("/api/sparks/:id/eco", { id: "a" }, { cpu: "2000" });
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /^CPU: max_perf/);
  assert.equal(r.getSpark("a").eco.cpu, "off");
});

test("ecoClearedByReboot: only a recorded cap on a different boot counts", async () => {
  const { ecoClearedByReboot } = await import("../../eco.js");
  const boot = 1_700_000_000_000;
  assert.equal(ecoClearedByReboot({ gpu: "2000", cpu: "off", bootAt: boot }, boot + 5_000), false);
  assert.equal(ecoClearedByReboot({ gpu: "2000", cpu: "off", bootAt: boot }, boot + 3_600_000), true);
  assert.equal(ecoClearedByReboot({ gpu: "off", cpu: "off", bootAt: boot }, boot + 3_600_000), false);
  assert.equal(ecoClearedByReboot({ gpu: "2000", cpu: "off" }, boot), false);
  assert.equal(ecoClearedByReboot({ gpu: "2000", cpu: "off", bootAt: boot }, null), false);
});

test("routes record the boot time; a reset drops it", async () => {
  const r = freshRegistry();
  const app = fakeApp();
  registerEcoRoutes(app, {
    registry: r, isOnline: () => true, bootAt: () => 1234, onChange: () => {}, run: async () => {},
  });
  await app.call("/api/sparks/:id/eco", { id: "a" }, { cpu: "2000" });
  assert.deepEqual(r.getSpark("a").eco, { gpu: "off", cpu: "2000", bootAt: 1234 });
  r.noteEco("a", { gpu: "off", cpu: "off", bootAt: null });
  assert.deepEqual(r.getSpark("a").eco, { gpu: "off", cpu: "off" });
});
