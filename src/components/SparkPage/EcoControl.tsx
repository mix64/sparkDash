import { useState } from "react";
import type { EcoState, SparkSnapshot } from "../../api/types";
import { setFleetEco, setSparkEco } from "../../api/client";
import { ECO_LEVELS, type EcoChannel } from "../../shared/ecoLevels.js";
import { BoltIcon } from "../ui/icons";

const CHANNELS: { key: EcoChannel; label: string; offLabel: string }[] = [
  { key: "gpu", label: "GPU", offLabel: "Off (uncap)" },
  { key: "cpu", label: "CPU", offLabel: "Off (stock)" },
];

interface EcoControlProps {
  /** One Spark (Spark page) or every Spark (Overview, with `fleet`). */
  sparks: SparkSnapshot[];
  fleet?: boolean;
  compact?: boolean;
}

/** The shared level across online Sparks, or "" when they differ. */
function currentLevel(sparks: SparkSnapshot[], channel: EcoChannel): string {
  const levels = new Set(sparks.filter((s) => s.online).map((s) => s.eco?.[channel] ?? "off"));
  return levels.size === 1 ? [...levels][0] : "";
}

/**
 * GPU/CPU clock caps. The applied levels arrive with the snapshot, so the
 * selects only hold a local draft until Apply succeeds.
 */
export function EcoControl({ sparks, fleet = false, compact = false }: EcoControlProps) {
  const [draft, setDraft] = useState<Partial<EcoState>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "err" } | null>(null);
  const online = sparks.some((s) => s.online);
  const pending = Object.keys(draft).length > 0;

  async function handleApply() {
    setBusy(true);
    setMsg(null);
    try {
      let errors: string[];
      if (fleet) {
        const { results } = await setFleetEco(draft);
        errors = results.filter((r) => !r.ok && !r.skipped).map((r) => `${r.id}: ${r.error}`);
      } else {
        await setSparkEco(sparks[0].id, draft);
        errors = [];
      }
      if (errors.length) {
        setMsg({ text: errors.join("; "), tone: "err" });
      } else {
        setMsg({ text: "Applied", tone: "ok" });
        setDraft({});
      }
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : "Failed to apply ECO", tone: "err" });
    } finally {
      setBusy(false);
    }
  }

  if (!online) return null;
  return (
    <div
      className={compact ? "flex items-center gap-1" : "panel flex flex-wrap items-center gap-x-3 gap-y-2"}
      style={compact ? undefined : { padding: "var(--density-panel-pad)" }}
    >
      <span className="flex items-center gap-1 text-[11px] text-muted">
        <BoltIcon className="h-3.5 w-3.5 text-accent" /> {!compact && "ECO"}
      </span>
      {CHANNELS.map(({ key, label, offLabel }) => (
        <select
          key={key}
          value={draft[key] ?? currentLevel(sparks, key)}
          onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
          disabled={busy}
          aria-label={`${label} clock cap`}
          title={`${label} clock cap`}
          className={`rounded border border-border bg-surface-elevated text-[11px] text-text outline-none focus:border-accent disabled:opacity-50 ${compact ? "px-1 py-1" : "px-2.5 py-1.5"}`}
        >
          <option value="" disabled>{label}: mixed</option>
          <option value="off">{label} {compact ? "Off" : offLabel}</option>
          {ECO_LEVELS[key].map((level) => <option key={level} value={level}>{label} {level} MHz</option>)}
        </select>
      ))}
      <button
        type="button"
        onClick={() => void handleApply()}
        disabled={busy || !pending}
        title={`Apply clock caps to ${fleet ? "all online Sparks" : "this Spark"}`}
        className={`rounded-md border border-border bg-surface-elevated text-[11px] text-muted transition-colors hover:bg-accent/15 hover:text-accent disabled:opacity-50 ${compact ? "px-1.5 py-1" : "px-3 py-1.5"}`}
      >
        {busy ? "Applying…" : "Apply"}
      </button>
      {msg && (
        <span role="status" className={`text-[11px] ${msg.tone === "ok" ? "text-success" : "text-danger"}`}>
          {msg.text}
        </span>
      )}
    </div>
  );
}
