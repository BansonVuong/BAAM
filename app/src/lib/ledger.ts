/** Points ledger entries in plain words ("Won Gym rats bet +500"). */
import type { PointsLedgerEntry } from "./relayer";

export interface LedgerBetInfo {
  terms?: string;
  groupName?: string;
}

export interface LedgerLine {
  title: string;
  /** Signed amount, e.g. "+500", "−250", or "" when nothing moved. */
  amount: string;
  /** Optional second line: the bet's terms. */
  detail?: string;
}

export function signedPoints(delta: number): string {
  if (delta === 0) return "0";
  const abs = Math.abs(Math.round(delta)).toLocaleString("en-US");
  return delta > 0 ? `+${abs}` : `−${abs}`;
}

function betName(info: LedgerBetInfo | undefined): string {
  return info?.groupName ? `${info.groupName} bet` : "a bet";
}

export function describeLedgerEntry(entry: PointsLedgerEntry, info?: LedgerBetInfo): LedgerLine {
  const amount = signedPoints(entry.delta);
  const detail = info?.terms;
  switch (entry.kind) {
    case "grant":
      return { title: "Welcome points", amount };
    case "topup":
      return { title: "Daily top-up", amount };
    case "hold":
      return { title: "Stake held", amount, detail };
    case "payout":
      return { title: `Won ${betName(info)}`, amount, detail };
    case "refund":
      return { title: "Stake returned", amount, detail };
    case "burn":
      // The stake already left the balance when it was held, so nothing moves here.
      return { title: `Pot burned on ${betName(info)}`, amount: entry.delta ? amount : "", detail };
    default:
      return { title: "Points change", amount, detail };
  }
}
