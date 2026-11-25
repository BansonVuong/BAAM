import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Teach tailwind-merge our type scale so `text-meta` isn't mistaken for a color
// (and dropped when combined with `text-ink-soft`).
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["meta", "label", "body", "terms", "title", "stake", "stamp"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
