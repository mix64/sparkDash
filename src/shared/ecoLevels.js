/** ECO CPU clock cap levels in MHz, highest first. "off" is always valid too.
 *  GPU clocks are the gpu-clock API, not an ECO level. */
export const ECO_LEVELS = Object.freeze({
  cpu: Object.freeze(["2500", "2250", "2000", "1750", "1500"]),
});

export function isEcoLevel(channel, level) {
  return level === "off" || ECO_LEVELS[channel]?.includes(level) === true;
}
