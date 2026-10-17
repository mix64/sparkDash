import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildApplyProgram,
  buildManualCommand,
  buildResetProgram,
  buildStatusProgram,
  buildUnit,
  parseCapRequest,
  parseProgramOutput,
  UNIT_NAME,
} from "../commands.js";
import { CpuClockManager, assertSupported } from "../CpuClockManager.js";

/** GB10-like cores: two clusters with different stock ceilings, all uncapped. */
const CORES = [2808000, 2808000, 3900000, 3900000];

/**
 * A temp tree with a fake cpufreq sysfs and a systemctl that really runs the
 * installed unit's ExecStart / ExecStop (with systemd's `$$` unescaped), so the
 * unit text itself is exercised. The programs run unprivileged against it.
 */
function sandbox({ cores = CORES } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpuclock-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const d of ["units", "systemd"]) fs.mkdirSync(path.join(root, d));
  cores.forEach((max, i) => {
    const d = path.join(root, "cpu", `cpu${i}`, "cpufreq");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "cpuinfo_max_freq"), `${max}\n`);
    fs.writeFileSync(path.join(d, "cpuinfo_min_freq"), "338000\n");
    fs.writeFileSync(path.join(d, "max_perf"), `${max}\n`);
  });
  const calls = path.join(root, "calls.log");
  const unit = path.join(root, "units", UNIT_NAME);
  const runLine = (key) => `cmd=$(sed -n 's/^${key}=//p' ${unit} | sed 's/\\$\\$/$/g'); eval "$cmd" || exit 1`;
  fs.writeFileSync(
    path.join(bin, "systemctl"),
    `#!/bin/sh
echo "systemctl $*" >> ${calls}
case "$1" in
  restart) [ -f ${root}/restart_fails ] && exit 1; ${runLine("ExecStop")}; ${runLine("ExecStart")} ;;
  disable) [ "$2" = --now ] && [ -f ${unit} ] && { ${runLine("ExecStop")}; } ;;
  is-enabled) [ -f ${unit} ] && echo enabled || echo disabled ;;
  is-active) [ -f ${unit} ] && echo active || echo inactive ;;
esac
exit 0
`,
    { mode: 0o755 }
  );
  const paths = {
    unitDir: path.join(root, "units"),
    cpuDir: path.join(root, "cpu"),
    systemdRunDir: path.join(root, "systemd"),
    systemctl: path.join(bin, "systemctl"),
    sandbox: true,
  };
  const run = (program, { shell = "sh", env } = {}) =>
    parseProgramOutput(execFileSync(shell, ["-c", program], { encoding: "utf8", env: env ?? process.env }));
  const read = (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8") : null);
  const perf = () => cores.map((_, i) => Number(read(`cpu/cpu${i}/cpufreq/max_perf`)));
  return { root, paths, run, read, perf, bin, calls: () => read("calls.log") ?? "", cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("parseCapRequest accepts a normal cap and rejects everything else", () => {
  assert.deepEqual(parseCapRequest({ maxMHz: 2000 }), { maxMHz: 2000, persist: false });
  assert.deepEqual(parseCapRequest({ maxMHz: 1500, persist: true }), { maxMHz: 1500, persist: true });
  for (const bad of [
    null, {}, { maxMHz: "2000" }, { maxMHz: 2000.5 }, { maxMHz: 999 }, { maxMHz: 10001 },
    { maxMHz: "2000; rm -rf /" }, { maxMHz: 2000, persist: "yes" }, { maxMHz: NaN },
  ]) {
    assert.throws(() => parseCapRequest(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
});

test("program text only carries integers and fixed paths, and is valid POSIX sh", () => {
  assert.throws(() => buildApplyProgram({ maxMHz: "2000;id", persist: true }), /maxMHz/);
  assert.throws(() => buildApplyProgram({ maxMHz: 2000 }, { cpuDir: "/sys/x; id" }), /unsafe path/);
  assert.throws(() => buildApplyProgram({ maxMHz: 2000 }, { unitDir: "/etc/../tmp" }), /unsafe path/);
  for (const prog of [
    buildStatusProgram(),
    buildResetProgram(),
    buildApplyProgram({ maxMHz: 2000, persist: false }),
    buildApplyProgram({ maxMHz: 2000, persist: true }),
  ]) {
    execFileSync("sh", ["-n", "-c", prog]);
  }
});

test("the unit escapes systemd's $ and carries the cap in kHz", () => {
  const unit = buildUnit({ maxMHz: 2000 });
  assert.match(unit, /^ExecStart=\/bin\/sh -c '.*' sh \/sys\/devices\/system\/cpu 2000000$/m);
  assert.match(unit, /^ExecStop=\/bin\/sh -c '.*' sh \/sys\/devices\/system\/cpu stock$/m);
  assert.match(unit, /\$\$d\/max_perf/);
  assert.doesNotMatch(unit.replace(/\$\$/g, ""), /\$/);
});

test("status reads the cap back from max_perf: none, then the highest capped core", () => {
  const sb = sandbox();
  try {
    const none = sb.run(buildStatusProgram(sb.paths));
    assert.equal(none.RESULT, "ok");
    assert.equal(none.HWMAX, "3900000");
    assert.equal(none.HWMIN, "338000");
    assert.equal(none.CAP, "0");
    assert.equal(none.SVC_INSTALLED, "0");
    // A cap set by something else is still reported.
    fs.writeFileSync(path.join(sb.root, "cpu/cpu2/cpufreq/max_perf"), "2500000\n");
    assert.equal(sb.run(buildStatusProgram(sb.paths)).CAP, "2500000");
  } finally {
    sb.cleanup();
  }
});

test("apply without the service caps every core, never above its own ceiling, and installs no unit", () => {
  const sb = sandbox();
  try {
    const res = sb.run(buildApplyProgram({ maxMHz: 3000, persist: false }, sb.paths));
    assert.equal(res.RESULT, "ok");
    assert.equal(res.CAP, "3000");
    assert.deepEqual(sb.perf(), [2808000, 2808000, 3000000, 3000000]);
    assert.equal(sb.run(buildStatusProgram(sb.paths)).CAP, "3000000");
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);

    sb.run(buildApplyProgram({ maxMHz: 2000, persist: false }, sb.paths));
    assert.deepEqual(sb.perf(), [2000000, 2000000, 2000000, 2000000]);
  } finally {
    sb.cleanup();
  }
});

test("apply with the service installs a unit whose ExecStart and ExecStop really work", () => {
  const sb = sandbox();
  try {
    const res = sb.run(buildApplyProgram({ maxMHz: 2000, persist: true }, sb.paths));
    assert.equal(res.RESULT, "ok");
    assert.equal(res.PERSIST, "1");
    assert.match(sb.calls(), new RegExp(`systemctl enable ${UNIT_NAME}`));
    assert.match(sb.calls(), new RegExp(`systemctl restart ${UNIT_NAME}`));
    // The fake systemctl ran ExecStop then ExecStart from the installed file.
    assert.deepEqual(sb.perf(), [2000000, 2000000, 2000000, 2000000]);
    const status = sb.run(buildStatusProgram(sb.paths));
    assert.equal(status.SVC_INSTALLED, "1");
    assert.equal(status.SVC_CAP, "2000000");
    assert.equal(status.SVC_ENABLED, "enabled");
    assert.equal(status.CAP, "2000000");
  } finally {
    sb.cleanup();
  }
});

test("switching the service off removes the unit and keeps the new cap", () => {
  const sb = sandbox();
  try {
    sb.run(buildApplyProgram({ maxMHz: 2000, persist: true }, sb.paths));
    const res = sb.run(buildApplyProgram({ maxMHz: 2500, persist: false }, sb.paths));
    assert.equal(res.RESULT, "ok");
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
    assert.match(sb.calls(), new RegExp(`systemctl disable --now ${UNIT_NAME}`));
    // Stopping the old unit restored stock; the cap was written again afterwards.
    assert.deepEqual(sb.perf(), [2500000, 2500000, 2500000, 2500000]);
  } finally {
    sb.cleanup();
  }
});

test("a cap outside the hardware range is refused and nothing changes", () => {
  const sb = sandbox({ cores: [2808000, 2808000] });
  try {
    const res = sb.run(buildApplyProgram({ maxMHz: 3000, persist: true }, sb.paths));
    assert.equal(res.CODE, "range");
    assert.match(res.MSG, /above this CPU's maximum clock \(2808 MHz\)/);
    assert.deepEqual(sb.perf(), [2808000, 2808000]);
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
  } finally {
    sb.cleanup();
  }
});

test("a service that fails to start is rolled back and the live cap stays truthful", () => {
  const sb = sandbox();
  try {
    sb.run(buildApplyProgram({ maxMHz: 2000, persist: true }, sb.paths));
    const before = sb.read(`units/${UNIT_NAME}`);
    fs.writeFileSync(path.join(sb.root, "restart_fails"), "");
    const res = sb.run(buildApplyProgram({ maxMHz: 1500, persist: true }, sb.paths));
    assert.equal(res.CODE, "service-failed");
    assert.equal(sb.read(`units/${UNIT_NAME}`), before);
    assert.deepEqual(sb.perf(), [1500000, 1500000, 1500000, 1500000]);
  } finally {
    sb.cleanup();
  }
});

test("reset removes the service and puts every core's stock ceiling back", () => {
  const sb = sandbox();
  try {
    sb.run(buildApplyProgram({ maxMHz: 2000, persist: true }, sb.paths));
    const res = sb.run(buildResetProgram(sb.paths));
    assert.equal(res.RESULT, "ok");
    assert.equal(sb.read(`units/${UNIT_NAME}`), null);
    assert.deepEqual(sb.perf(), CORES);
    assert.equal(sb.run(buildStatusProgram(sb.paths)).CAP, "0");
  } finally {
    sb.cleanup();
  }
});

test("a unit without CPPC max_perf reports a clean error instead of touching anything", () => {
  const sb = sandbox({ cores: [] });
  try {
    for (const prog of [buildStatusProgram(sb.paths), buildApplyProgram({ maxMHz: 2000, persist: true }, sb.paths), buildResetProgram(sb.paths)]) {
      assert.equal(sb.run(prog).CODE, "no-cppc");
    }
    assert.equal(sb.calls(), "");
  } finally {
    sb.cleanup();
  }
});

test("as a normal user every privileged step goes through sudo -n; a sudo that wants a password changes nothing", () => {
  const sb = sandbox();
  try {
    const log = path.join(sb.root, "sudo.log");
    fs.writeFileSync(path.join(sb.bin, "sudo"), `#!/bin/sh\necho "sudo $*" >> ${log}\n[ "$1" = -n ] || exit 9\nshift\nexec "$@"\n`, { mode: 0o755 });
    // `install -o root -g root` cannot succeed unprivileged: drop the ownership flags only.
    fs.writeFileSync(path.join(sb.bin, "install"), `#!/bin/sh\nargs=""\nwhile [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) args="$args $1"; shift ;; esac; done\nexec /usr/bin/install $args\n`, { mode: 0o755 });
    const paths = { ...sb.paths, sandbox: false };
    const env = { ...process.env, PATH: `${sb.bin}:${process.env.PATH}` };
    assert.equal(sb.run(buildApplyProgram({ maxMHz: 2000, persist: true }, paths), { env }).RESULT, "ok");
    const calls = fs.readFileSync(log, "utf8");
    assert.match(calls, /sudo -n true/);
    assert.match(calls, /sudo -n sh -c for d in/);
    assert.match(calls, /sudo -n install -m 644 -o root -g root/);
    assert.match(calls, /sudo -n .*systemctl enable/);

    fs.writeFileSync(path.join(sb.bin, "sudo"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const denied = sb.run(buildApplyProgram({ maxMHz: 1500, persist: false }, paths), { env });
    assert.equal(denied.CODE, "no-sudo");
    assert.deepEqual(sb.perf(), [2000000, 2000000, 2000000, 2000000]);
  } finally {
    sb.cleanup();
  }
});

test("with a sudo password: it is piped to sudo -S, never an argument, and a wrong one changes nothing", () => {
  const sb = sandbox();
  try {
    const log = path.join(sb.root, "sudo.log");
    fs.writeFileSync(
      path.join(sb.bin, "sudo"),
      `#!/bin/sh
echo "sudo $*" >> ${log}
S=0
while [ $# -gt 0 ]; do case "$1" in -k) shift ;; -S) S=1; shift ;; -p) shift 2 ;; *) break ;; esac; done
pw=""; [ "$S" = 1 ] && read -r pw
[ "$pw" = "s3cret" ] || exit 1
exec "$@"
`,
      { mode: 0o755 }
    );
    const paths = { ...sb.paths, sandbox: false, password: true };
    const env = (pw) => ({ ...process.env, PATH: `${sb.bin}:${process.env.PATH}`, SPARKDASH_SUDO_PW: pw });
    const wrong = sb.run(buildApplyProgram({ maxMHz: 2000, persist: false }, paths), { env: env("nope") });
    assert.equal(wrong.CODE, "bad-password");
    assert.deepEqual(sb.perf(), CORES);

    const program = buildApplyProgram({ maxMHz: 2000, persist: false }, paths);
    assert.doesNotMatch(program, /s3cret/);
    assert.equal(sb.run(program, { env: env("s3cret") }).RESULT, "ok");
    assert.deepEqual(sb.perf(), [2000000, 2000000, 2000000, 2000000]);
    assert.doesNotMatch(fs.readFileSync(log, "utf8"), /s3cret/);
  } finally {
    sb.cleanup();
  }
});

test("the same programs behave under dash and bash --posix", () => {
  for (const shell of ["dash", "bash"]) {
    try {
      execFileSync(shell, ["-c", "true"]);
    } catch {
      continue; // not installed here
    }
    const sb = sandbox();
    try {
      const opt = { shell, env: process.env };
      const wrap = (prog) => (shell === "bash" ? `set -o posix\n${prog}` : prog);
      assert.equal(sb.run(wrap(buildApplyProgram({ maxMHz: 2000, persist: true }, sb.paths)), opt).RESULT, "ok", shell);
      assert.equal(sb.run(wrap(buildStatusProgram(sb.paths)), opt).CAP, "2000000", shell);
      assert.equal(sb.run(wrap(buildResetProgram(sb.paths)), opt).RESULT, "ok", shell);
      assert.deepEqual(sb.perf(), CORES, shell);
    } finally {
      sb.cleanup();
    }
  }
});

test("manual command: plain sudo that prompts, readable output, runs end to end, refusals exit non-zero", () => {
  const sb = sandbox();
  try {
    const cmd = buildManualCommand("apply", { maxMHz: 2000, persist: true }, sb.paths);
    assert.match(cmd, /cap the CPU clock at 2000 MHz and keep it after reboot/);
    const real = buildManualCommand("apply", { maxMHz: 2000, persist: true });
    assert.match(real, /SUDO="sudo"/);
    assert.doesNotMatch(real, /sudo -n/);
    assert.doesNotMatch(real, /RESULT=/);
    execFileSync("sh", ["-n", "-c", real]);
    assert.match(execFileSync("sh", ["-c", cmd], { encoding: "utf8" }), /Done: CPU clock capped at 2000 MHz and kept after reboot/);
    assert.deepEqual(sb.perf(), [2000000, 2000000, 2000000, 2000000]);
    assert.match(execFileSync("sh", ["-c", buildManualCommand("reset", {}, sb.paths)], { encoding: "utf8" }), /Done: CPU clock cap removed/);
    assert.deepEqual(sb.perf(), CORES);

    let err;
    try {
      execFileSync("sh", ["-c", buildManualCommand("apply", { maxMHz: 5000 }, sb.paths)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      err = e;
    }
    assert.equal(err?.status, 1);
    assert.match(err.stderr, /Error: the cap is above this CPU's maximum clock \(3900 MHz\)/);
    assert.throws(() => buildManualCommand("apply", { maxMHz: 500 }), (e) => e.status === 400);
    assert.throws(() => buildManualCommand("explode", {}), (e) => e.status === 400);
  } finally {
    sb.cleanup();
  }
});

test("only Linux Spark units are supported", () => {
  assert.throws(() => assertSupported({ id: "h", kind: "host" }), (e) => e.status === 400);
  assert.throws(() => assertSupported({ id: "w", kind: "spark", platform: "windows" }), (e) => e.status === 400);
  assert.doesNotThrow(() => assertSupported({ id: "s", kind: "spark" }));
});

test("CpuClockManager.status converts kHz to MHz, and a unit without CPPC is 'unsupported'", async () => {
  const spark = { id: "s1", kind: "spark" };
  const ok = new CpuClockManager({
    run: async () => "RESULT=ok\nHWMAX=3900000\nHWMIN=338000\nSUDO=yes\nCAP=2000000\nSVC_INSTALLED=1\nSVC_CAP=2000000\nSVC_ENABLED=enabled\nSVC_ACTIVE=active",
  });
  assert.deepEqual(await ok.status(spark), {
    supported: true, hwMaxMHz: 3900, hwMinMHz: 338, capMHz: 2000, sudo: "yes",
    service: { installed: true, capMHz: 2000, enabled: "enabled", active: "active" },
  });
  const uncapped = new CpuClockManager({ run: async () => "RESULT=ok\nHWMAX=3900000\nHWMIN=338000\nSUDO=no\nCAP=0\nSVC_INSTALLED=0" });
  assert.equal((await uncapped.status(spark)).capMHz, null);
  const none = new CpuClockManager({ run: async () => "RESULT=error\nCODE=no-cppc\nMSG=this unit has no CPPC max_perf control" });
  assert.equal((await none.status(spark)).supported, false);
});

test("CpuClockManager: maps errors to statuses, serialises per unit with its own message, redacts the password", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const outputs = [];
  const m = new CpuClockManager({
    run: async (_spark, program) => {
      if (program.includes("MAX=2200")) await gate;
      return outputs.shift();
    },
  });
  const spark = { id: "s1", name: "S1", kind: "spark" };

  outputs.push("RESULT=error\nCODE=write-failed\nMSG=could not write max_perf");
  await assert.rejects(m.apply(spark, { maxMHz: 1800 }), (e) => e.status === 422 && e.code === "write-failed");

  outputs.push("RESULT=ok\nCAP=2200\nPERSIST=1");
  const first = m.apply(spark, { maxMHz: 2200, persist: true });
  await assert.rejects(m.apply(spark, { maxMHz: 1900 }), (e) => e.status === 409 && /CPU clock action/.test(e.message));
  release();
  assert.deepEqual(await first, { capMHz: 2200, persist: true });

  const down = new CpuClockManager({ run: async () => { throw new Error("ssh failed for hunter22"); } });
  await assert.rejects(down.reset(spark, { sudoPassword: "hunter22" }), (e) => e.status === 502 && !e.message.includes("hunter22"));
  await assert.rejects(m.apply(spark, { maxMHz: "x" }), (e) => e.status === 400);
  await assert.rejects(m.status({ id: "h", kind: "host" }), (e) => e.status === 400);
});

test("CpuClockManager.command builds the manual command without touching the unit", () => {
  const m = new CpuClockManager({ run: async () => { throw new Error("must not run"); } });
  const spark = { id: "s1", kind: "spark" };
  assert.match(m.command(spark, { action: "apply", maxMHz: "2000", persist: "1" }).command, /cap the CPU clock at 2000 MHz and keep it after reboot/);
  assert.match(m.command(spark, { action: "reset" }).command, /remove the CPU clock cap/);
  assert.throws(() => m.command(spark, { action: "apply", maxMHz: "2e3" }), (e) => e.status === 400);
  assert.throws(() => m.command(spark, { action: "nope" }), (e) => e.status === 400);
});
