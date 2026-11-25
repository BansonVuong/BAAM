/** Stake input rules per currency. Mirrors relayer/points-logic.ts (parsePointsStake). */
import type { BetCurrency } from "./relayer";

/** Largest points stake the relayer accepts. */
export const POINTS_MAX_STAKE = 1_000_000_000;

/** Plain-word problem with a stake, or null when it's fine. */
export function stakeError(raw: string, currency: BetCurrency): string | null {
  const text = raw.trim();
  if (currency === "PTS") {
    if (!/^\d+$/.test(text) || Number(text) < 1) return "Points stakes are whole numbers, 1 or more.";
    if (Number(text) > POINTS_MAX_STAKE) return `Keep it at ${POINTS_MAX_STAKE.toLocaleString()} points or fewer.`;
    return null;
  }
  const value = Number(text);
  if (!text || !Number.isFinite(value) || value <= 0) return "Enter an amount above 0.";
  return null;
}

/** Normalised stake string to send ("0500" → "500"). */
export function normalizeStake(raw: string, currency: BetCurrency): string {
  const text = raw.trim();
  if (currency === "PTS" && /^\d+$/.test(text)) return String(Number(text));
  return text;
}

/** Which currencies to offer and which one starts selected. */
export function currencyChoice(
  config: { allowed: BetCurrency[]; default: BetCurrency } | null | undefined,
): { options: BetCurrency[]; initial: BetCurrency } {
  const allowed = (config?.allowed ?? []).filter((c): c is BetCurrency => c === "PTS" || c === "SOL");
  const options = allowed.length > 0 ? [...new Set(allowed)] : ["SOL" as const];
  const initial = config && options.includes(config.default) ? config.default : options[0]!;
  return { options, initial };
}

/** Default stake to prefill when switching currency. */
export function defaultStakeFor(currency: BetCurrency): string {
  return currency === "PTS" ? "100" : "0.1";
}
