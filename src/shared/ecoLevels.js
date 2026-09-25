/** ECO clock cap levels in MHz, highest first. "off" is always valid too. */
export const ECO_LEVELS = Object.freeze({
  gpu: Object.freeze(["2300", "2200", "2000", "1800"]),
  cpu: Object.freeze(["2500", "2250", "2000", "1750", "1500"]),
});

export function isEcoLevel(channel, level) {
  return level === "off" || ECO_LEVELS[channel]?.includes(level) === true;
}
