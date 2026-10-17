import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCpuClock, fetchCpuClockCommand, resetCpuClock, setCpuClock } from "../api/client";
import type { CpuClockStatus } from "../api/types";
import { CpuClockSection } from "./CpuClockSection";
import { flush, render } from "../testing/render";

vi.mock("../api/client", () => ({
  fetchCpuClock: vi.fn(),
  fetchCpuClockCommand: vi.fn(),
  setCpuClock: vi.fn(),
  resetCpuClock: vi.fn(),
}));

const base: CpuClockStatus = {
  supported: true,
  hwMaxMHz: 3900,
  hwMinMHz: 338,
  capMHz: null,
  sudo: "yes",
  service: { installed: false, capMHz: null, enabled: null, active: null },
};

const buttons = (c: HTMLElement) => [...c.querySelectorAll("button")];
const byText = (c: HTMLElement, t: string) => buttons(c).find((b) => b.textContent?.includes(t)) as HTMLButtonElement;
const maxInput = (c: HTMLElement) => c.querySelector("#cpu-clock-max") as HTMLInputElement;

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CpuClockSection", () => {
  beforeEach(() => {
    vi.mocked(fetchCpuClock).mockResolvedValue(base);
    vi.mocked(setCpuClock).mockResolvedValue({ success: true, capMHz: 2000, persist: true });
    vi.mocked(resetCpuClock).mockResolvedValue({ success: true });
    vi.stubGlobal("confirm", vi.fn(() => true));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows the current cap, the CPU maximum and the boot service state", async () => {
    vi.mocked(fetchCpuClock).mockResolvedValue({
      ...base,
      capMHz: 2000,
      service: { installed: true, capMHz: 2000, enabled: "enabled", active: "active" },
    });
    const { container } = render(<CpuClockSection sparkId="lab" />);
    await flush();
    const now = container.querySelector('[data-testid="cpu-clock-now"]')?.textContent ?? "";
    expect(now).toContain("Capped at 2000 MHz");
    expect(now).toContain("CPU maximum 3900 MHz");
    expect(now).toContain("boot service enabled (2000 MHz)");
    expect(maxInput(container).value).toBe("2000");
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
  });

  it("applies the cap with the keep-after-reboot choice, then reloads", async () => {
    const { container } = render(<CpuClockSection sparkId="lab" />);
    await flush();
    setInput(maxInput(container), "2000");
    act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    act(() => byText(container, "Apply").click());
    await flush();
    expect(setCpuClock).toHaveBeenCalledWith("lab", { maxMHz: 2000, persist: true });
    expect(fetchCpuClock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Capped at 2000 MHz and kept after reboot.");
  });

  it("refuses caps below the 1000 MHz floor or above the CPU maximum", async () => {
    const { container } = render(<CpuClockSection sparkId="lab" />);
    await flush();
    for (const bad of ["900", "3901", "2000.5"]) {
      setInput(maxInput(container), bad);
      expect(byText(container, "Apply").disabled).toBe(true);
      expect(container.textContent).toContain("Enter a whole number from 1000 to 3900.");
    }
  });

  it("removes the cap and its service", async () => {
    const { container } = render(<CpuClockSection sparkId="lab" />);
    await flush();
    act(() => byText(container, "Remove limit").click());
    await flush();
    expect(resetCpuClock).toHaveBeenCalledWith("lab", undefined);
    expect(container.textContent).toContain("Cap removed.");
  });

  it("asks for the sudo password when the unit has no passwordless sudo, and sends it once", async () => {
    vi.mocked(fetchCpuClock).mockResolvedValue({ ...base, sudo: "no", passwordAllowed: true });
    const { container } = render(<CpuClockSection sparkId="lab" />);
    await flush();
    setInput(maxInput(container), "2500");
    expect(byText(container, "Apply").disabled).toBe(true);
    setInput(container.querySelector("#cpu-clock-sudo-pw") as HTMLInputElement, "s3cret pw");
    act(() => byText(container, "Apply").click());
    await flush();
    expect(setCpuClock).toHaveBeenCalledWith("lab", { maxMHz: 2500, persist: false, sudoPassword: "s3cret pw" });
    expect((container.querySelector("#cpu-clock-sudo-pw") as HTMLInputElement).value).toBe("");
  });

  it("shows the command to run on the Spark", async () => {
    vi.mocked(fetchCpuClockCommand).mockResolvedValue({ command: "# sparkDash: run this on the Spark itself." });
    const { container } = render(<CpuClockSection sparkId="lab" />);
    await flush();
    setInput(maxInput(container), "2000");
    act(() => byText(container, "Show command: apply").click());
    await flush();
    expect(fetchCpuClockCommand).toHaveBeenCalledWith("lab", { action: "apply", maxMHz: 2000, persist: false });
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toContain("run this on the Spark itself");
  });

  it("says why on a unit without CPPC", async () => {
    vi.mocked(fetchCpuClock).mockResolvedValue({ supported: false, reason: "this unit has no CPPC max_perf control (cppc_cpufreq)" });
    const { container } = render(<CpuClockSection sparkId="lab" />);
    await flush();
    expect(container.textContent).toContain("no CPPC max_perf control");
    expect(maxInput(container)).toBeNull();
  });
});
