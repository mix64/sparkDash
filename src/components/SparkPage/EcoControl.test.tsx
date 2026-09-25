import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupRenders, flush, render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { EcoControl } from "./EcoControl";
import { setFleetEco, setSparkEco } from "../../api/client";

vi.mock("../../api/client", async (original) => ({
  ...await original<typeof import("../../api/client")>(),
  setSparkEco: vi.fn(), setFleetEco: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(setSparkEco).mockResolvedValue({ success: true });
  vi.mocked(setFleetEco).mockResolvedValue({ success: true, results: [] });
});
afterEach(cleanupRenders);

function spark(id: string, eco = { gpu: "off", cpu: "off" }, online = true) {
  return { ...makeSpark(id, online), eco };
}

function choose(container: HTMLElement, label: string, value: string) {
  const el = container.querySelector<HTMLSelectElement>(`[aria-label="${label} clock cap"]`)!;
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return el;
}

const applyButton = (c: HTMLElement) => c.querySelector("button")!;

it("shows the applied levels and sends only the changed channel", async () => {
  const { container } = render(<EcoControl sparks={[spark("a", { gpu: "2200", cpu: "off" })]} />);
  expect(container.querySelector<HTMLSelectElement>('[aria-label="GPU clock cap"]')!.value).toBe("2200");
  expect(applyButton(container).disabled).toBe(true);
  choose(container, "CPU", "1750");
  act(() => applyButton(container).click());
  await flush();
  expect(setSparkEco).toHaveBeenCalledWith("a", { cpu: "1750" });
  expect(container.textContent).toContain("Applied");
});

it("keeps the draft and shows the server error when applying fails", async () => {
  vi.mocked(setSparkEco).mockRejectedValue(new Error("CPU: sudo: a password is required"));
  const { container } = render(<EcoControl sparks={[spark("a")]} />);
  const cpu = choose(container, "CPU", "2000");
  act(() => applyButton(container).click());
  await flush();
  expect(container.textContent).toContain("CPU: sudo: a password is required");
  expect(cpu.value).toBe("2000");
});

it("fleet: mixed levels show as mixed, offline units are ignored, failures are listed", async () => {
  vi.mocked(setFleetEco).mockResolvedValue({ success: true, results: [
    { id: "a", ok: true }, { id: "b", ok: false, error: "GPU: timed out" },
    { id: "c", ok: false, skipped: true, error: "Offline — skipped" },
  ] });
  const sparks = [
    spark("a", { gpu: "2000", cpu: "off" }),
    spark("b", { gpu: "1800", cpu: "off" }),
    spark("c", { gpu: "2300", cpu: "2500" }, false),
  ];
  const { container } = render(<EcoControl sparks={sparks} fleet compact />);
  expect(container.querySelector<HTMLSelectElement>('[aria-label="GPU clock cap"]')!.value).toBe("");
  expect(container.querySelector<HTMLSelectElement>('[aria-label="CPU clock cap"]')!.value).toBe("off");
  choose(container, "GPU", "2000");
  act(() => applyButton(container).click());
  await flush();
  expect(setFleetEco).toHaveBeenCalledWith({ gpu: "2000" });
  expect(container.textContent).toContain("b: GPU: timed out");
  expect(container.textContent).not.toContain("Offline");
});

it("renders nothing when no Spark is online", () => {
  const { container } = render(<EcoControl sparks={[spark("a", undefined, false)]} />);
  expect(container.innerHTML).toBe("");
});
