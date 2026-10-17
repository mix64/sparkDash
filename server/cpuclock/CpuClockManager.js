/**
 * Runs the CPU clock cap programs on a unit. Transport, the per-unit lock, the
 * hold after a dropped connection and the sudo password lock are the GPU clock
 * manager's; only the programs and their answers differ.
 */
import { GpuClockManager } from "../gpuclock/GpuClockManager.js";
import { parseSudoPassword } from "../gpuclock/commands.js";
import {
  buildApplyProgram,
  buildManualCommand,
  buildResetProgram,
  buildStatusProgram,
  parseCapRequest,
  parseProgramOutput,
} from "./commands.js";

const STATUS_TIMEOUT_MS = 15_000;

/** Error codes a program can report, with the HTTP status the route answers with. */
const CODE_STATUS = {
  "no-sudo": 409,
  "no-cppc": 409,
  "no-systemd": 409,
  range: 400,
  "bad-output": 502,
  "bad-password": 403,
  // The action reached the unit and failed there (sysfs write, systemd).
  "write-failed": 422,
  "service-failed": 422,
};

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

/** @param {object} spark registry entry */
export function assertSupported(spark) {
  if (!spark) throw httpError(404, "Spark not found");
  if (spark.kind === "host") throw httpError(400, "CPU clock caps are only supported on Spark units");
  if (spark.platform === "windows" || spark.platform === "darwin") {
    throw httpError(400, "CPU clock caps are only supported on Linux Spark units");
  }
}

const khzToMHz = (v) => (/^\d+$/.test(v ?? "") && Number(v) > 0 ? Math.round(Number(v) / 1000) : null);

export class CpuClockManager extends GpuClockManager {
  /** The parent's, parsed with this program's keys (HWMIN, SVC_CAP). */
  async _exec(spark, program, timeoutMs, input = null) {
    let out;
    try {
      out = await this._run(spark, program, { timeoutMs, input });
    } catch (err) {
      let detail = String(err.message || err).slice(0, 200);
      if (input && input.length >= 4) detail = detail.split(input).join("***");
      const e = httpError(502, `Could not reach ${spark.name || spark.id}: ${detail}`);
      e.holdBusy = true;
      throw e;
    }
    return parseProgramOutput(out);
  }

  _fail(res) {
    const status = CODE_STATUS[res.CODE] ?? 500;
    return httpError(status, res.MSG || "The unit refused the request", res.CODE);
  }

  async _exclusive(spark, fn) {
    if (this._busy.has(spark.id)) throw httpError(409, "Another CPU clock action is still running on this unit");
    return super._exclusive(spark, fn);
  }

  /** Read-only: hardware range, current cap, sudo availability, service state. */
  async status(spark) {
    assertSupported(spark);
    const res = await this._exec(spark, buildStatusProgram(this._paths), STATUS_TIMEOUT_MS);
    if (res.RESULT !== "ok") {
      // A unit without CPPC is a normal answer for the dialog, not a server error.
      if (res.CODE === "no-cppc") return { supported: false, reason: res.MSG };
      throw this._fail(res);
    }
    return {
      supported: true,
      hwMaxMHz: khzToMHz(res.HWMAX),
      hwMinMHz: khzToMHz(res.HWMIN),
      capMHz: khzToMHz(res.CAP),
      sudo: ["root", "yes", "no"].includes(res.SUDO) ? res.SUDO : "no",
      service: {
        installed: res.SVC_INSTALLED === "1",
        capMHz: khzToMHz(res.SVC_CAP),
        enabled: res.SVC_ENABLED || null,
        active: res.SVC_ACTIVE || null,
      },
    };
  }

  /**
   * The paste-into-a-terminal command for running apply/reset on the unit by hand.
   * Needs no access to the unit.
   * @param {object} spark
   * @param {{ action?: unknown, maxMHz?: unknown, persist?: unknown }} query
   */
  command(spark, query = {}) {
    assertSupported(spark);
    const action = query.action;
    if (action === "reset") return { command: buildManualCommand("reset", {}, this._paths) };
    if (action !== "apply") throw httpError(400, "action must be apply or reset");
    // Query strings: only plain digits count as numbers.
    const num = (v) => (typeof v === "string" && /^\d{1,6}$/.test(v) ? Number(v) : NaN);
    const req = parseCapRequest({
      maxMHz: num(query.maxMHz),
      persist: query.persist === "1" || query.persist === "true",
    });
    return { command: buildManualCommand("apply", req, this._paths) };
  }

  /** Apply a cap; `persist` installs the boot service. `body.sudoPassword` is used for this one call only. */
  async apply(spark, body) {
    assertSupported(spark);
    const req = parseCapRequest(body);
    const password = parseSudoPassword(body?.sudoPassword);
    return this._exclusive(spark, async () => {
      const program = buildApplyProgram(req, { ...this._paths, password: password != null });
      const res = await this._privileged(spark, program, password);
      return { capMHz: Number(res.CAP) || req.maxMHz, persist: res.PERSIST === "1" };
    });
  }

  /** Remove the cap and the service. */
  async reset(spark, body = {}) {
    assertSupported(spark);
    const password = parseSudoPassword(body?.sudoPassword);
    return this._exclusive(spark, async () => {
      const program = buildResetProgram({ ...this._paths, password: password != null });
      await this._privileged(spark, program, password);
      return {};
    });
  }
}
