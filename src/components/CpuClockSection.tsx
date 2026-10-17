import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchCpuClock, fetchCpuClockCommand, resetCpuClock, setCpuClock } from "../api/client";
import type { CpuClockStatus } from "../api/types";

/** Same floor as the server (server/cpuclock/commands.js). */
const MIN_CAP_MHZ = 1000;

/**
 * CPU clock cap for one Spark (Edit unit), laid out and styled like the GPU clock cap.
 * Acts immediately on the unit with the saved connection settings: it is not
 * part of the Save button.
 */
export function CpuClockSection({ sparkId }: { sparkId: string }) {
  const { t } = useTranslation("devices");
  const [status, setStatus] = useState<CpuClockStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [maxInput, setMaxInput] = useState("");
  const [persist, setPersist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  /** Command for running the change by hand on the unit (plain sudo, asks for the password). */
  const [manual, setManual] = useState<{ title: string; command: string } | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Typed sudo password: kept in this component's state only, sent with one request, then cleared. */
  const [sudoPw, setSudoPw] = useState("");
  /** Only the newest request may write state: a slow answer for an older unit must not win. */
  const latest = useRef(0);
  const sparkRef = useRef(sparkId);
  sparkRef.current = sparkId;

  const syncInputs = (s: CpuClockStatus) => {
    if (!s.supported) return;
    const cap = s.capMHz ?? s.service.capMHz;
    setMaxInput(cap != null ? String(cap) : "");
    setPersist(s.service.installed);
  };

  const load = useCallback(
    async (opts: { sync: boolean }) => {
      const mine = ++latest.current;
      try {
        const s = await fetchCpuClock(sparkId);
        if (mine !== latest.current) return;
        setStatus(s);
        setLoadError(null);
        if (opts.sync) syncInputs(s);
      } catch (err) {
        if (mine !== latest.current) return;
        // Keep what is on screen after a failed refresh; the message says what went wrong.
        setLoadError(err instanceof Error ? err.message : "load");
      }
    },
    [sparkId]
  );

  useEffect(() => {
    setStatus(null);
    setLoadError(null);
    setMessage(null);
    setMaxInput("");
    setPersist(false);
    setManual(null);
    setManualError(null);
    setSudoPw("");
    setBusy(false);
    void load({ sync: true });
    return () => {
      latest.current += 1;
    };
  }, [load]);

  if (!status) {
    return (
      <div className="gpu-clock">
        <span className="field-label">{t("cpu.cap")}</span>
        <p className={`field-hint${loadError ? " is-warn" : ""}`} role="status">
          {loadError === "load" ? t("cpu.loadError") : loadError ?? t("gpu.reading")}
        </p>
      </div>
    );
  }
  if (!status.supported) {
    return (
      <div className="gpu-clock">
        <span className="field-label">{t("cpu.cap")}</span>
        <p className="field-hint">{status.reason || t("gpu.unavailable")}</p>
      </div>
    );
  }

  const hwMax = status.hwMaxMHz;
  const minCap = Math.max(MIN_CAP_MHZ, status.hwMinMHz ?? 0);
  const maxMHz = Number(maxInput);
  const valid =
    maxInput.trim() !== "" &&
    Number.isInteger(maxMHz) &&
    maxMHz >= minCap &&
    (hwMax == null || maxMHz <= hwMax);
  const sudoMissing = status.sudo === "no";
  /** A password typed here crosses the network: only over https or from the machine itself. */
  const secure =
    (typeof window === "undefined" || window.isSecureContext !== false) && status.passwordAllowed !== false;
  const needPw = sudoMissing && secure;
  const pwOk = !needPw || sudoPw.length > 0;
  const pwArg = needPw ? sudoPw : undefined;

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ ok: true, text: done });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "refused" });
    } finally {
      // A slow answer for the unit you just left must not wipe what you type for this one.
      if (sparkRef.current === sparkId) {
        setBusy(false);
        setSudoPw("");
        await load({ sync: true });
      }
    }
  };

  const apply = () => {
    if (persist && !confirm(t("cpu.persistConfirm"))) return;
    void run(
      () => setCpuClock(sparkId, { maxMHz, persist, ...(pwArg ? { sudoPassword: pwArg } : {}) }),
      persist ? t("cpu.cappedPersistent", { max: maxMHz }) : t("gpu.cappedUntilReboot", { max: maxMHz })
    );
  };

  const remove = () => {
    if (!confirm(t("cpu.removeConfirm"))) return;
    void run(() => resetCpuClock(sparkId, pwArg), t("gpu.removed"));
  };

  const showCommand = async (kind: "apply" | "reset") => {
    setManualError(null);
    setCopied(false);
    try {
      const q = kind === "apply" ? ({ action: "apply", maxMHz, persist } as const) : ({ action: "reset" } as const);
      const { command } = await fetchCpuClockCommand(sparkId, q);
      setManual({
        title: kind === "apply" ? t("gpu.manualApplyTitle", { max: maxMHz, suffix: persist ? t("gpu.manualPersistent") : "" }) : t("gpu.manualRemoveTitle"),
        command,
      });
    } catch (err) {
      setManual(null);
      setManualError(err instanceof Error ? err.message : "commandError");
    }
  };

  const copyCommand = async () => {
    if (!manual) return;
    try {
      await navigator.clipboard.writeText(manual.command);
      setCopied(true);
    } catch {
      // Plain-http dashboards have no clipboard API: the text box below is selectable.
      setCopied(false);
    }
  };

  return (
    <div className="gpu-clock">
      <label className="field-label" htmlFor="cpu-clock-max">
        {t("cpu.cap")}
      </label>
      <p className="gpu-clock__now" data-testid="cpu-clock-now">
        {status.capMHz != null ? (
          <>
            {t("gpu.cappedAt")} <b>{status.capMHz} MHz</b>
            {hwMax != null ? t("cpu.maximum", { max: hwMax }) : ""}
          </>
        ) : (
          <>{t("gpu.noCap")}{hwMax != null ? t("cpu.maximum", { max: hwMax }) : ""}</>
        )}
        {status.service.installed
          ? t("gpu.bootService", {
              state: status.service.enabled === "enabled" ? t("gpu.enabled") : status.service.enabled || t("gpu.installed"),
              clocks: status.service.capMHz != null ? ` (${status.service.capMHz} MHz)` : "",
            })
          : t("gpu.notKept")}
      </p>
      <div className="gpu-clock__row">
        <input
          id="cpu-clock-max"
          type="number"
          min={minCap}
          max={hwMax ?? undefined}
          inputMode="numeric"
          placeholder={hwMax != null ? `${minCap}–${hwMax}` : t("gpu.mhz")}
          value={maxInput}
          onChange={(e) => setMaxInput(e.target.value)}
          disabled={busy}
        />
        <span className="gpu-clock__unit">{t("gpu.mhzMax")}</span>
        <button type="button" className="btn btn--sm" onClick={apply} disabled={busy || !valid || !pwOk || (sudoMissing && !secure)}>
          {busy ? t("gpu.working") : t("gpu.apply")}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={remove} disabled={busy || !pwOk || (sudoMissing && !secure)}>
          {t("gpu.removeLimit")}
        </button>
      </div>
      <label className="gpu-clock__check">
        <input
          type="checkbox"
          checked={persist}
          onChange={(e) => setPersist(e.target.checked)}
          disabled={busy}
        />
        {t("gpu.keepAfterReboot")} ({t("cpu.installsService")})
      </label>
      {needPw && (
        <div>
          <label className="field-label" htmlFor="cpu-clock-sudo-pw">
            {t("gpu.sudoPassword")}
          </label>
          <input
            id="cpu-clock-sudo-pw"
            type="password"
            autoComplete="new-password"
            data-1p-ignore
            data-lpignore="true"
            value={sudoPw}
            onChange={(e) => setSudoPw(e.target.value)}
            disabled={busy}
            placeholder={t("gpu.passwordPlaceholder")}
          />
          <p className="field-hint">{t("gpu.passwordHelp")}</p>
        </div>
      )}
      {sudoMissing && !secure && (
        <p className="field-hint is-warn">{t("cpu.insecure")}</p>
      )}
      {!sudoMissing && (
        <p className="field-hint">
          {t("cpu.writesBefore")} <code>cpufreq/max_perf</code> {t("cpu.writesAfter")}
          {status.sudo === "root" ? t("gpu.asRoot") : t("gpu.throughSudo")}
          {t("gpu.runsAfter")}
        </p>
      )}
      {maxInput.trim() !== "" && !valid && (
        <p className="field-hint is-warn">
          {t("gpu.range", { min: minCap, max: hwMax != null ? `–${hwMax}` : "" })}
        </p>
      )}
      <details className="gpu-clock__manual" open={(sudoMissing && !secure) || manual != null}>
        <summary>{t("gpu.manual")}</summary>
        <p className="field-hint">
          {t("gpu.manualBefore")} <code>sudo</code> {t("gpu.manualAfter")}
        </p>
        <div className="gpu-clock__row">
          <button type="button" className="btn btn--sm" onClick={() => void showCommand("apply")} disabled={!valid}>
            {t("gpu.showApply")}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => void showCommand("reset")}>
            {t("gpu.showRemove")}
          </button>
        </div>
        {manualError && <p className="field-hint is-warn" role="status">{manualError === "commandError" ? t("gpu.commandError") : manualError}</p>}
        {manual && (
          <>
            <p className="gpu-clock__now">{manual.title}</p>
            <textarea className="gpu-clock__command" readOnly rows={8} value={manual.command} aria-label={t("gpu.commandAria")} onFocus={(e) => e.currentTarget.select()} />
            <div className="gpu-clock__row">
              <button type="button" className="btn btn--sm" onClick={() => void copyCommand()}>
                {copied ? t("gpu.copied") : t("gpu.copy")}
              </button>
            </div>
          </>
        )}
      </details>
      {loadError && <p className="field-hint is-warn" role="status">{loadError === "load" ? t("cpu.loadError") : `${t("gpu.refreshError")}: ${loadError}`}</p>}
      {message && (
        <p className={`field-hint ${message.ok ? "is-ok" : "is-warn"}`} role="status">
          {message.text === "refused" ? t("gpu.refused") : message.text}
        </p>
      )}
    </div>
  );
}
