/**
 * GET/PUT/DELETE /api/sparks/:id/cpu-clock, the CPU counterpart of
 * /gpu-clock with the same auth, limiters and sudo password rules.
 */
import { isSecureRequest } from "../gpuclock/routes.js";

export function registerCpuClockRoutes(app, { manager, registry, recordEvent, allowRead, allowChange, rejectLimited }) {
  const handle = (fn) => async (req, res) => {
    try {
      const spark = registry.getSpark(req.params.id);
      if (!spark) return res.status(404).json({ error: "Spark not found" });
      await fn(spark, req, res);
    } catch (err) {
      // Errors from the manager carry a status and a curated message; anything else stays generic.
      const known = Number.isInteger(err?.status);
      res.status(known ? err.status : 500).json({ error: known ? err.message : "CPU clock action failed", code: err?.code });
    }
  };

  app.get(
    "/api/sparks/:id/cpu-clock",
    handle(async (spark, req, res) => {
      if (!allowRead(req)) return rejectLimited(res, "Too many requests");
      res.json({ ...(await manager.status(spark)), passwordAllowed: isSecureRequest(req) });
    })
  );

  app.get(
    "/api/sparks/:id/cpu-clock/command",
    handle(async (spark, req, res) => {
      if (!allowRead(req)) return rejectLimited(res, "Too many requests");
      res.json(manager.command(spark, req.query));
    })
  );

  const refuseInsecurePassword = (req, res) => {
    if (!req.body?.sudoPassword || isSecureRequest(req)) return false;
    res.status(400).json({
      error: "Open the dashboard over https or from the Spark itself to type a sudo password here, or use the command to run on the Spark.",
      code: "insecure-transport",
    });
    return true;
  };

  app.put(
    "/api/sparks/:id/cpu-clock",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many CPU clock changes, try again in a minute");
      if (refuseInsecurePassword(req, res)) return;
      const out = await manager.apply(spark, req.body);
      recordEvent({
        type: "cpu.clock.set",
        severity: "info",
        sparkId: spark.id,
        message: `CPU clock capped at ${out.capMHz} MHz${out.persist ? " (kept after reboot)" : ""}`,
      });
      res.json({ success: true, ...out });
    })
  );

  app.delete(
    "/api/sparks/:id/cpu-clock",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many CPU clock changes, try again in a minute");
      if (refuseInsecurePassword(req, res)) return;
      await manager.reset(spark, req.body);
      recordEvent({ type: "cpu.clock.reset", severity: "info", sparkId: spark.id, message: "CPU clock cap removed" });
      res.json({ success: true });
    })
  );
}
