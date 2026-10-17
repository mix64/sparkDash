/**
 * On-unit programs for the CPU clock cap: every core's CPPC `max_perf` is set
 * to the cap (or to that core's `cpuinfo_max_freq` when the cap is above it),
 * optionally kept across reboots by a oneshot systemd service.
 *
 * On GB10 `max_perf` and `cpuinfo_max_freq` are both kHz, and
 * `cpuinfo_max_freq` keeps the stock per-cluster ceiling (2808000 / 3900000)
 * while capped, so removing the cap needs no saved snapshot. `max_perf` is
 * world-readable, so the cap in effect is read back from the hardware rather
 * than from a marker. `scaling_max_freq` is not used: on GB10 it follows the
 * cap in reporting only.
 *
 * Same shape as the GPU clock programs (../gpuclock/commands.js): POSIX sh,
 * only validated integers and fixed paths are interpolated, root runs it
 * directly and anyone else uses `sudo -n` (or `sudo -S` with a typed password),
 * and the programs always exit 0 and report on stdout as `KEY=value` lines.
 */

export const CPU_CLOCK_SERVICE = "spark-cpu-clock-limit";
export const UNIT_NAME = `${CPU_CLOCK_SERVICE}.service`;

/** Lowest cap accepted: a box capped lower is hard to even log in to, and a kept cap returns at every boot. */
export const MIN_CAP_MHZ = 1000;
export const MAX_CAP_MHZ = 10000;

const SAFE_PATH = /^\/[A-Za-z0-9_./-]*$/;

const DEFAULT_PATHS = Object.freeze({
  unitDir: "/etc/systemd/system",
  cpuDir: "/sys/devices/system/cpu",
  systemdRunDir: "/run/systemd/system",
  systemctl: "systemctl",
  // true = the script is run by a person in a terminal on the unit: plain `sudo` (asks for the
  // password), readable output, non-zero exit on failure.
  manual: false,
  // true = a sudo password arrives in $SPARKDASH_SUDO_PW (set by the runner from stdin) and
  // every privileged step pipes it to `sudo -S`; it is never put in an argument list.
  password: false,
  // Test sandbox only: run unprivileged against a fake sysfs tree and systemctl.
  sandbox: false,
});

/**
 * Writes one kHz value (or each core's stock ceiling for "stock") into every
 * core's max_perf. Arguments: $1 the cpu sysfs directory, $2 kHz or "stock".
 * Fixed text with no single quotes, so it can sit inside '…' in sh and in the
 * systemd unit alike.
 */
const CAP_LOOP = [
  'for d in "$1"/cpu[0-9]*/cpufreq',
  'do [ -f "$d/max_perf" ] || continue',
  'm=$(cat "$d/cpuinfo_max_freq") || exit 1',
  "c=$2",
  'if [ "$c" = stock ] || [ "$c" -gt "$m" ]; then c=$m; fi',
  'echo "$c" > "$d/max_perf" || exit 1',
  "done",
].join("; ");

/** Paths come from code only (tests point them at a sandbox); still refuse anything odd. */
function resolvePaths(overrides = {}) {
  const p = { ...DEFAULT_PATHS, ...overrides };
  const list = [p.unitDir, p.cpuDir, p.systemdRunDir];
  if (p.systemctl !== "systemctl") list.push(p.systemctl);
  for (const v of list) {
    if (typeof v !== "string" || !SAFE_PATH.test(v) || v.includes("..")) {
      throw new Error("unsafe path in CPU clock program");
    }
  }
  return p;
}

/**
 * Validate a cap request. Returns normalized values or throws an Error with `status` 400.
 * @param {unknown} body
 * @returns {{ maxMHz: number, persist: boolean }}
 */
export function parseCapRequest(body) {
  const fail = (msg) => Object.assign(new Error(msg), { status: 400 });
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const maxMHz = b.maxMHz;
  if (!Number.isInteger(maxMHz) || maxMHz < MIN_CAP_MHZ || maxMHz > MAX_CAP_MHZ) {
    throw fail(`maxMHz must be a whole number from ${MIN_CAP_MHZ} to ${MAX_CAP_MHZ}`);
  }
  if (b.persist !== undefined && typeof b.persist !== "boolean") throw fail("persist must be true or false");
  return { maxMHz, persist: b.persist === true };
}

/** The systemd unit. `$$` is systemd's escape for `$`. */
export function buildUnit({ maxMHz, cpuDir = DEFAULT_PATHS.cpuDir }) {
  if (!Number.isInteger(maxMHz) || maxMHz <= 0) throw new Error("bad clock value");
  const loop = `/bin/sh -c '${CAP_LOOP.replace(/\$/g, "$$$$")}' sh ${cpuDir}`;
  return [
    "[Unit]",
    `Description=Limit CPU clock (max ${maxMHz} MHz), managed by sparkDash`,
    "After=systemd-modules-load.service",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=10",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `ExecStart=${loop} ${maxMHz * 1000}`,
    `ExecStop=${loop} stock`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/** The sudo gate: with a typed password a refusal means a wrong password, otherwise missing NOPASSWD. */
function needSudoLine(paths) {
  if (!paths.password) {
    return 'need_sudo || fail no-sudo "passwordless sudo (NOPASSWD: ALL) is required for the user that runs the change"';
  }
  return [
    "need_sudo || { case \"$SUDO_ERR\" in",
    '  __missing__) fail no-sudo "sudo is not installed on this unit" ;;',
    '  "") fail bad-password "the sudo password was not accepted" ;;',
    '  *"incorrect password"*|*"Sorry, try again"*|*"password is required"*|*"Authentication failure"*) fail bad-password "the sudo password was not accepted" ;;',
    '  *) fail no-sudo "sudo refused the request: $(clean "$SUDO_ERR")" ;;',
    "esac; }",
  ].join("\n");
}

function header(paths) {
  return [
    "set -u",
    // Read the password into a plain shell variable and drop it from the environment first
    // thing, so nothing this script starts (not even `id`) inherits it.
    ...(paths.password
      ? [
          "PW=${SPARKDASH_SUDO_PW-}",
          "unset SPARKDASH_SUDO_PW",
          "spw_sudo() { printf '%s\\n' \"$PW\" | LC_ALL=C sudo -S -p '' \"$@\"; }",
        ]
      : []),
    'SUDO=""',
    paths.sandbox ? ":" : `[ "$(id -u)" = 0 ] || SUDO="${paths.password ? "spw_sudo" : paths.manual ? "sudo" : "sudo -n"}"`,
    `SYSTEMCTL=${paths.systemctl}`,
    `OWNER="${paths.sandbox ? "" : "-o root -g root"}"`,
    `UNIT=${paths.unitDir}/${UNIT_NAME}`,
    `CPUDIR=${paths.cpuDir}`,
    `LOOP='${CAP_LOOP}'`,
    paths.manual
      ? "fail() { printf 'Error: %s\\n' \"$2\" >&2; exit 1; }"
      : "fail() { printf 'RESULT=error\\nCODE=%s\\nMSG=%s\\n' \"$1\" \"$2\"; exit 0; }",
    "digits() { tr -dc 0-9; }",
    'clean() { printf "%s" "$1" | head -n 1 | tr -cd "A-Za-z0-9 .,:_()/-" | head -c 160; }',
    // HW / HWMIN: highest stock ceiling and highest floor across cores (kHz); CAP: the
    // highest max_perf below its core's ceiling, i.e. the cap in effect (0 = none).
    "scan() {",
    "  HW=0; HWMIN=0; CAP=0; N=0",
    '  for d in "$CPUDIR"/cpu[0-9]*/cpufreq; do',
    '    [ -r "$d/max_perf" ] || continue',
    '    m=$(digits < "$d/cpuinfo_max_freq" 2>/dev/null); p=$(digits < "$d/max_perf" 2>/dev/null); lo=$(digits < "$d/cpuinfo_min_freq" 2>/dev/null)',
    '    [ -n "$m" ] && [ -n "$p" ] || continue',
    "    N=$((N + 1))",
    '    [ "$m" -gt "$HW" ] && HW=$m',
    '    [ -n "$lo" ] && [ "$lo" -gt "$HWMIN" ] && HWMIN=$lo',
    '    [ "$p" -lt "$m" ] && [ "$p" -gt "$CAP" ] && CAP=$p',
    "  done",
    '  [ "$N" -gt 0 ] || fail no-cppc "this unit has no CPPC max_perf control (cppc_cpufreq)"',
    "}",
    'cap() { $SUDO sh -c "$LOOP" sh "$CPUDIR" "$1"; }',
    paths.password
      ? // Why a refusal happened matters: only a wrong password counts toward the lock.
        "need_sudo() { SUDO_ERR=''; [ -z \"$SUDO\" ] && return 0; command -v sudo >/dev/null 2>&1 || { SUDO_ERR=__missing__; return 1; }; SUDO_ERR=$(printf '%s\\n' \"$PW\" | LC_ALL=C sudo -k -S -p '' true 2>&1 >/dev/null) && return 0; return 1; }"
      : paths.manual
      ? 'need_sudo() { [ -z "$SUDO" ] && return 0; command -v sudo >/dev/null 2>&1 && sudo -v; }'
      : 'need_sudo() { [ -z "$SUDO" ] && return 0; command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; }',
    // Removes a previous service; stopping it puts the stock ceilings back (ExecStop).
    "drop_service() {",
    '  if [ -f "$UNIT" ]; then',
    `    $SUDO $SYSTEMCTL disable --now ${UNIT_NAME} >/dev/null 2>&1 || true`,
    '    $SUDO rm -f "$UNIT" || return 1',
    "    $SUDO $SYSTEMCTL daemon-reload >/dev/null 2>&1 || true",
    "  fi",
    "}",
  ];
}

/** Read-only: current cap, hardware range, sudo availability and the service state. */
export function buildStatusProgram(overrides = {}) {
  const paths = resolvePaths(overrides);
  return [
    ...header(paths),
    "scan",
    'if [ "$(id -u)" = 0 ]; then S=root; elif need_sudo; then S=yes; else S=no; fi',
    "INST=0; SCAP=''; EN=''; ACT=''",
    'if [ -f "$UNIT" ]; then',
    "  INST=1",
    '  SCAP=$(sed -n \'s/^ExecStart=.* \\([0-9][0-9]*\\)$/\\1/p\' "$UNIT" | head -n 1 | digits)',
    `  EN=$($SYSTEMCTL is-enabled ${UNIT_NAME} 2>/dev/null | head -n 1 | tr -dc "a-z-")`,
    `  ACT=$($SYSTEMCTL is-active ${UNIT_NAME} 2>/dev/null | head -n 1 | tr -dc "a-z-")`,
    "fi",
    "printf 'RESULT=ok\\nHWMAX=%s\\nHWMIN=%s\\nSUDO=%s\\nCAP=%s\\nSVC_INSTALLED=%s\\nSVC_CAP=%s\\nSVC_ENABLED=%s\\nSVC_ACTIVE=%s\\n' \"$HW\" \"$HWMIN\" \"$S\" \"$CAP\" \"$INST\" \"$SCAP\" \"$EN\" \"$ACT\"",
    "exit 0",
    "",
  ].join("\n");
}

/** Apply a cap now; with `persist`, also install/enable the boot service. */
export function buildApplyProgram({ maxMHz, persist }, overrides = {}) {
  const paths = resolvePaths(overrides);
  // Defense in depth: the caller validated already, but this is what reaches a root shell.
  const req = parseCapRequest({ maxMHz, persist });
  const unit = buildUnit({ maxMHz: req.maxMHz, cpuDir: paths.cpuDir });
  return [
    ...header(paths),
    `MAX=${req.maxMHz}; KHZ=${req.maxMHz * 1000}; PERSIST=${req.persist ? 1 : 0}`,
    "scan",
    '[ "$KHZ" -le "$HW" ] || fail range "the cap is above this CPU\'s maximum clock ($((HW / 1000)) MHz)"',
    '[ "$KHZ" -ge "$HWMIN" ] || fail range "the cap is below this CPU\'s minimum clock ($((HWMIN / 1000)) MHz)"',
    needSudoLine(paths),
    `if [ "$PERSIST" = 1 ] && [ ! -d ${paths.systemdRunDir} ]; then fail no-systemd "systemd is not running on this unit"; fi`,
    // Order matters: nothing existing is touched until the new cap has been written.
    'OUT=$(cap "$KHZ" 2>&1) || fail write-failed "could not write max_perf: $(clean "$OUT")"',
    'if [ "$PERSIST" = 0 ]; then',
    '  if [ -f "$UNIT" ]; then',
    // Stopping the old service restores the stock ceilings (ExecStop), so the cap is written again afterwards.
    '    drop_service || fail service-failed "could not remove the existing service"',
    '    OUT=$(cap "$KHZ" 2>&1) || fail write-failed "could not write max_perf: $(clean "$OUT")"',
    "  fi",
    "else",
    "  D=$(mktemp -d) || fail service-failed \"could not create a temporary directory\"",
    '  trap \'rm -rf "$D"\' EXIT',
    '  if [ -f "$UNIT" ]; then cp "$UNIT" "$D/unit.old" || fail service-failed "could not back up the existing service"; fi',
    "  cat > \"$D/unit\" <<'SPARKDASH_UNIT_EOF'",
    unit.replace(/\n$/, ""),
    "SPARKDASH_UNIT_EOF",
    // Past this point a failure restores the previous service (or removes ours) and re-writes the live cap.
    "  rollback() {",
    '    if [ -f "$D/unit.old" ]; then',
    '      $SUDO install -m 644 $OWNER "$D/unit.old" "$UNIT" >/dev/null 2>&1',
    "    else",
    `      $SUDO $SYSTEMCTL disable ${UNIT_NAME} >/dev/null 2>&1`,
    '      $SUDO rm -f "$UNIT"',
    "    fi",
    "    $SUDO $SYSTEMCTL daemon-reload >/dev/null 2>&1",
    '    cap "$KHZ" >/dev/null 2>&1',
    "  }",
    '  $SUDO install -m 644 $OWNER "$D/unit" "$UNIT" || fail service-failed "could not install the service file"',
    "  $SUDO $SYSTEMCTL daemon-reload || { rollback; fail service-failed \"systemctl daemon-reload failed; the cap applies until the next reboot\"; }",
    `  $SUDO $SYSTEMCTL enable ${UNIT_NAME} >/dev/null 2>&1 || { rollback; fail service-failed "could not enable the service; the cap applies until the next reboot"; }`,
    `  $SUDO $SYSTEMCTL restart ${UNIT_NAME} >/dev/null 2>&1 || { rollback; fail service-failed "the service did not start; the cap applies until the next reboot"; }`,
    `  [ "$($SYSTEMCTL is-active ${UNIT_NAME} 2>/dev/null)" = active ] || { rollback; fail service-failed "the service is not active; the cap applies until the next reboot"; }`,
    "fi",
    paths.manual
      ? `if [ "$PERSIST" = 1 ]; then printf 'Done: CPU clock capped at %s MHz and kept after reboot (${UNIT_NAME}).\\n' "$MAX"; else printf 'Done: CPU clock capped at %s MHz until the next reboot.\\n' "$MAX"; fi`
      : "printf 'RESULT=ok\\nCAP=%s\\nPERSIST=%s\\n' \"$MAX\" \"$PERSIST\"",
    "exit 0",
    "",
  ].join("\n");
}

/** Remove the cap: stop and delete the service, put every core's stock ceiling back. */
export function buildResetProgram(overrides = {}) {
  const paths = resolvePaths(overrides);
  return [
    ...header(paths),
    "scan",
    needSudoLine(paths),
    'drop_service || fail service-failed "could not remove the existing service"',
    'OUT=$(cap stock 2>&1) || fail write-failed "could not write max_perf: $(clean "$OUT")"',
    paths.manual ? "printf 'Done: CPU clock cap removed.\\n'" : "printf 'RESULT=ok\\n'",
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Parse a program's KEY=value stdout. Unknown keys are dropped, values are
 * length-capped, and a missing RESULT line is an error (never "healthy").
 * @param {string} out
 * @returns {Record<string, string>}
 */
export function parseProgramOutput(out) {
  const KEYS = new Set([
    "RESULT", "CODE", "MSG", "HWMAX", "HWMIN", "SUDO", "CAP", "PERSIST",
    "SVC_INSTALLED", "SVC_CAP", "SVC_ENABLED", "SVC_ACTIVE",
  ]);
  const res = {};
  for (const line of String(out ?? "").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && KEYS.has(m[1])) res[m[1]] = m[2].slice(0, 300);
  }
  if (res.RESULT !== "ok" && res.RESULT !== "error") {
    return { RESULT: "error", CODE: "bad-output", MSG: "the unit returned an unexpected answer" };
  }
  return res;
}

/**
 * A paste-into-a-terminal command that runs the apply/reset program on the unit by hand:
 * the same program the dashboard runs, with plain `sudo` (prompts for the password) and
 * readable output, written to a private temp file first so `sudo` can read the terminal.
 * @param {"apply" | "reset"} action
 * @param {{ maxMHz?: number, persist?: boolean }} [req]
 */
export function buildManualCommand(action, req = {}, overrides = {}) {
  const manual = { ...overrides, manual: true };
  let program;
  if (action === "apply") {
    program = buildApplyProgram(parseCapRequest(req), manual);
  } else if (action === "reset") {
    program = buildResetProgram(manual);
  } else {
    throw Object.assign(new Error("action must be apply or reset"), { status: 400 });
  }
  const what = action === "apply"
    ? `cap the CPU clock at ${req.maxMHz} MHz${req.persist === true ? " and keep it after reboot" : ""}`
    : "remove the CPU clock cap and its boot service";
  return [
    "# sparkDash: run this on the Spark itself. It will ask for your sudo password.",
    `# It will ${what}. Read it first; nothing is sent anywhere.`,
    'f=$(mktemp) && cat > "$f" <<\'SPARKDASH_SCRIPT_EOF\'',
    program.replace(/\n$/, ""),
    "SPARKDASH_SCRIPT_EOF",
    'sh "$f"; rc=$?; rm -f "$f"; [ "$rc" = 0 ]',
    "",
  ].join("\n");
}
