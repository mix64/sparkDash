/**
 * ECO clock caps — lower the CPU ceiling (CPPC `max_perf`) on a Spark to trade
 * peak speed for heat and power.
 *
 * GPU clocks are not set here. Upstream's GPU clock cap
 * (`PUT /api/sparks/:id/gpu-clock`, Edit unit) already owns `nvidia-smi -lgc`,
 * the boot service, and the marker the dashboard displays. A second writer
 * would fight that lock and its "keep after reboot" service.
 *
 * Writes go through the dashboard's normal auth (mutating routes need
 * SPARKDASH_TOKEN when one is configured), like shutdown / wake.
 *
 * CPU "off" writes each core's `cpuinfo_max_freq` back into `max_perf`. On
 * GB10 both are kHz and `cpuinfo_max_freq` keeps the per-cluster stock ceiling
 * (2808000 / 3900000) while capped, so no snapshot of the stock values is kept.
 * `scaling_max_freq` is not used: on GB10 it follows the cap in reporting only.
 *
 * The cap cannot be read back from sysfs once applied (max_perf is the cap),
 * so the registry keeps the last-applied level (`spark.eco`) and the snapshot
 * shows it. A reboot clears the cap on the hardware.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { HOST_PATHS } from "./config.js";
import { sshExec } from "./collectors/ssh.js";
import { isEcoLevel } from "../src/shared/ecoLevels.js";

const CHANNELS = /** @type {const} */ (["cpu"]);
const TIMEOUT_MS = 8000;
const CPUFREQ_DIRS = "/sys/devices/system/cpu/cpu[0-9]*/cpufreq";

/** A boot time more than this far from the recorded one means a reboot. */
const REBOOT_TOLERANCE_MS = 60_000;

/**
 * Persisted shape: cpu always present, unknown values → "off". A leftover
 * `gpu` from older forks is dropped — GPU caps live on the gpu-clock marker.
 * `bootAt` is the host boot time (ms) when the cap was applied.
 */
export function normalizeEco(eco) {
  const out = Object.fromEntries(
    CHANNELS.map((ch) => [ch, isEcoLevel(ch, eco?.[ch]) ? eco[ch] : "off"])
  );
  if (Number.isFinite(eco?.bootAt)) out.bootAt = eco.bootAt;
  return out;
}

/** True when a CPU cap is recorded but the host has rebooted since, clearing it. */
export function ecoClearedByReboot(eco, bootAt) {
  if (!eco || eco.cpu === "off") return false;
  if (!Number.isFinite(eco.bootAt) || !Number.isFinite(bootAt)) return false;
  return Math.abs(bootAt - eco.bootAt) > REBOOT_TOLERANCE_MS;
}

/** Shell script that applies the CPU cap. GPU locks are the gpu-clock API. */
export function ecoScript(channel, level) {
  if (!isEcoLevel(channel, level)) throw new Error(`Invalid ${channel} ECO level`);
  const write = level === "off"
    ? `cat "$d/cpuinfo_max_freq" > "$d/max_perf"`
    : `echo ${Number(level) * 1000} > "$d/max_perf"`;
  return `set -e; for d in ${CPUFREQ_DIRS}; do ${write}; done`;
}

/**
 * Run a root script on the Spark's host: nsenter into the host mount
 * namespace from the privileged container, sudo on a bare-metal dev host,
 * and passwordless sudo over SSH for remote units.
 */
function runAsRoot(spark, script) {
  if (!spark.isLocal) {
    const quoted = script.replace(/'/g, "'\\''");
    return sshExec(spark, `sudo -n sh -c '${quoted}'`, { timeoutMs: TIMEOUT_MS });
  }
  const mntNs = path.join(HOST_PATHS.PROC, "1", "ns", "mnt");
  const [file, args] = fs.existsSync(mntNs)
    ? ["nsenter", [`--mount=${mntNs}`, "--", "sh", "-c", script]]
    : process.getuid?.() === 0
      ? ["sh", ["-c", script]]
      : ["sudo", ["-n", "sh", "-c", script]];
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message));
      else resolve(String(stdout).trim());
    });
  });
}

/**
 * Apply the requested channels to one Spark.
 * @returns {Promise<{applied: Record<string, string>, errors: string[]}>}
 */
export async function applyEco(spark, levels, run = runAsRoot) {
  const applied = {};
  const errors = [];
  for (const ch of CHANNELS) {
    if (levels[ch] === undefined) continue;
    try {
      await run(spark, ecoScript(ch, levels[ch]));
      applied[ch] = levels[ch];
    } catch (err) {
      errors.push(`${ch.toUpperCase()}: ${err.message || err}`);
    }
  }
  return { applied, errors };
}

/** Pick the requested CPU level from a request body, or return an error text. */
export function parseEcoBody(body) {
  if (body?.gpu !== undefined) {
    return { error: "GPU clock caps use PUT /api/sparks/:id/gpu-clock" };
  }
  const levels = {};
  for (const ch of CHANNELS) {
    const value = body?.[ch];
    if (value === undefined) continue;
    if (!isEcoLevel(ch, value)) return { error: `Invalid ${ch.toUpperCase()} ECO level` };
    levels[ch] = value;
  }
  if (!Object.keys(levels).length) return { error: "Specify cpu" };
  return { levels };
}

/**
 * POST /api/sparks/:id/eco and /api/sparks/eco-all with body {cpu}.
 * @param {import("express").Express} app
 * @param {{registry: any, isOnline: (id: string) => boolean,
 *   bootAt: (id: string) => number | null,
 *   onChange: (id: string) => void, run?: typeof runAsRoot}} deps
 */
export function registerEcoRoutes(app, { registry, isOnline, bootAt, onChange, run = runAsRoot }) {
  async function applyTo(spark, levels) {
    const { applied, errors } = await applyEco(spark, levels, run);
    if (Object.keys(applied).length
      && registry.noteEco(spark.id, { ...applied, bootAt: bootAt(spark.id) })) onChange(spark.id);
    return { id: spark.id, ok: errors.length === 0, ...(errors.length && { error: errors.join("; ") }) };
  }

  app.post("/api/sparks/eco-all", async (req, res) => {
    const { levels, error } = parseEcoBody(req.body);
    if (error) return res.status(400).json({ error });
    const results = await Promise.all(registry.sparks.map((spark) =>
      isOnline(spark.id)
        ? applyTo(spark, levels)
        : { id: spark.id, ok: false, skipped: true, error: "Offline — skipped" }));
    res.json({ success: true, results });
  });

  app.post("/api/sparks/:id/eco", async (req, res) => {
    const spark = registry.getSpark(req.params.id);
    if (!spark) return res.status(404).json({ error: "Spark not found" });
    const { levels, error } = parseEcoBody(req.body);
    if (error) return res.status(400).json({ error });
    const result = await applyTo(spark, levels);
    if (!result.ok) return res.status(500).json({ error: result.error });
    res.json({ success: true });
  });
}
