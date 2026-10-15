export type EcoChannel = "cpu";

export const ECO_LEVELS: Readonly<Record<EcoChannel, readonly string[]>>;

export function isEcoLevel(channel: EcoChannel, level: unknown): level is string;
