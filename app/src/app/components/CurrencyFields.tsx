/** Currency choice (Points / SOL) and the stake input shared by every bet composer. */
import { useEffect, useRef, useState } from "react";
import type { BetCurrency } from "../../lib/relayer";
import { currencyChoice } from "../../lib/stake";
import { useBaamData } from "../data";
import { Field, Segmented, TextInput } from "./primitives";

/** Server-allowed currencies; `currency` follows the server default until the person picks. */
export function useBetCurrency(open = true): {
  options: BetCurrency[];
  currency: BetCurrency;
  setCurrency: (currency: BetCurrency) => void;
} {
  const { currencies } = useBaamData();
  const { options, initial } = currencyChoice(currencies);
  const [currency, setCurrencyState] = useState<BetCurrency>(initial);
  const touched = useRef(false);

  useEffect(() => {
    if (!touched.current || !options.includes(currency)) setCurrencyState(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, options.join(",")]);

  useEffect(() => {
    if (open) return;
    touched.current = false;
    setCurrencyState(initial);
  }, [open, initial]);

  return {
    options,
    currency,
    setCurrency: (next) => { touched.current = true; setCurrencyState(next); },
  };
}

export function CurrencyPicker({ options, value, onChange, hint }: {
  options: BetCurrency[];
  value: BetCurrency;
  onChange: (currency: BetCurrency) => void;
  hint?: string;
}) {
  if (options.length < 2) return null;
  return (
    <Field
      label="Play for"
      hint={hint ?? (value === "PTS" ? "Points are play money. They can't be bought or cashed out." : "SOL is held on Solana until the bet settles.")}
    >
      <Segmented
        label="Play for"
        value={value}
        onChange={onChange}
        size="sm"
        options={options.map((option) => ({ value: option, label: option === "PTS" ? "Points" : "SOL" }))}
      />
    </Field>
  );
}

export function StakeInput({ id, currency, value, onChange, invalid }: {
  id: string;
  currency: BetCurrency;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}) {
  const points = currency === "PTS";
  return (
    <div className="relative max-w-56">
      <TextInput
        id={id}
        type="number"
        inputMode={points ? "numeric" : "decimal"}
        min={points ? "1" : "0"}
        step={points ? "1" : "0.01"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={points ? "500" : "0.25"}
        className="pr-14 text-[22px] font-extrabold wdth-condensed tabular-nums"
        aria-invalid={invalid}
      />
      <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-label font-semibold text-ink-soft">
        {points ? "pts" : "SOL"}
      </span>
    </div>
  );
}
