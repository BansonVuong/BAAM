/** Quiet, paper-and-ink building blocks. Color lives on tickets, not here. */
import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";

/* ── Buttons ───────────────────────────────────────────────────────────── */

type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
type ButtonSize = "md" | "sm" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", extra?: string): string {
  return cn(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-semibold transition-colors select-none",
    "disabled:cursor-not-allowed disabled:opacity-50",
    size === "md" && "min-h-11 px-5 text-label",
    size === "sm" && "min-h-11 px-3.5 text-label md:min-h-9",
    size === "icon" && "size-11 md:size-10",
    variant === "primary" && "bg-ink text-paper hover:bg-ink/88",
    variant === "secondary" && "border border-rule bg-transparent text-ink hover:bg-hover",
    variant === "ghost" && "bg-transparent text-ink hover:bg-hover",
    variant === "destructive" && "bg-transparent text-danger hover:bg-danger/10",
    extra,
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, type = "button", ...props },
  ref,
) {
  return <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...props} />;
});

/* ── Form fields ───────────────────────────────────────────────────────── */

export const inputClass = cn(
  "block w-full rounded-xl border border-rule bg-paper px-3.5 text-body text-ink",
  "min-h-12 py-2.5 transition-colors hover:border-ink-soft",
  "focus-visible:border-ink disabled:opacity-60",
  "aria-invalid:border-danger",
);

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-label font-semibold">{label}</label>
      {children}
      {error ? (
        <p className="text-meta text-danger" role="alert">{error}</p>
      ) : hint ? (
        <p className="text-meta text-ink-soft">{hint}</p>
      ) : null}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...props }, ref) {
    return <input ref={ref} className={cn(inputClass, className)} {...props} />;
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(inputClass, "resize-none leading-6", className)} {...props} />;
  },
);

/** Accessible single-choice control rendered as a row of pills. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  size = "md",
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode; disabled?: boolean }[];
  onChange: (value: T) => void;
  className?: string;
  size?: "md" | "sm";
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex flex-wrap gap-2", className)}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              const enabled = options.filter((o) => !o.disabled);
              const index = enabled.findIndex((o) => o.value === value);
              const step = event.key === "ArrowRight" ? 1 : -1;
              const next = enabled[(index + step + enabled.length) % enabled.length];
              if (next) {
                onChange(next.value);
                const siblings = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]");
                siblings?.[options.indexOf(next)]?.focus();
              }
            }}
            tabIndex={selected || (!options.some((o) => o.value === value) && option === options[0]) ? 0 : -1}
            className={cn(
              "inline-flex items-center gap-2 rounded-full border font-semibold transition-colors",
              size === "md" ? "min-h-11 px-4 text-label" : "min-h-11 px-3.5 text-label md:min-h-9",
              selected ? "border-ink bg-ink text-paper" : "border-rule text-ink hover:bg-hover",
              "disabled:cursor-not-allowed disabled:opacity-45",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Sheet: slides up on mobile, centered panel on desktop ─────────────── */

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  dismissible = true,
  initialFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  dismissible?: boolean;
  /** Stop Radix from focusing the first control (e.g. to focus a specific field). */
  initialFocus?: "none";
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (next || dismissible) onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim fixed inset-0 z-40 bg-scrim" />
        <div className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-6">
          <Dialog.Content
            onOpenAutoFocus={initialFocus === "none" ? (event) => event.preventDefault() : undefined}
            onEscapeKeyDown={(event) => { if (!dismissible) event.preventDefault(); }}
            onPointerDownOutside={(event) => { if (!dismissible) event.preventDefault(); }}
            className={cn(
              "sheet pointer-events-auto flex max-h-[92dvh] w-full flex-col overflow-hidden bg-paper text-ink",
              "rounded-t-[22px] shadow-[0_-8px_40px_-12px_rgba(0,0,0,0.35)]",
              "md:max-h-[min(860px,calc(100dvh-48px))] md:rounded-[20px] md:shadow-[0_24px_60px_-20px_rgba(0,0,0,0.45)]",
              size === "sm" && "md:max-w-[440px]",
              size === "md" && "md:max-w-[560px]",
              size === "lg" && "md:max-w-[960px]",
            )}
          >
            <div className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-rule md:hidden" aria-hidden />
            <div className="flex shrink-0 items-start justify-between gap-4 px-5 pb-3 pt-4 md:px-7 md:pt-6">
              <div className="min-w-0">
                <Dialog.Title className="text-title font-bold wdth-title">{title}</Dialog.Title>
                {description ? (
                  <Dialog.Description className="mt-1 text-label text-ink-soft">{description}</Dialog.Description>
                ) : (
                  <Dialog.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</Dialog.Description>
                )}
              </div>
              {dismissible && (
                <Dialog.Close className={buttonClass("ghost", "icon", "-mr-2 -mt-1")} aria-label="Close">
                  <X size={20} aria-hidden />
                </Dialog.Close>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 md:px-7 md:pb-7">{children}</div>
            {footer && (
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-rule px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-7 md:py-4">
                {footer}
              </div>
            )}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ── Menus ─────────────────────────────────────────────────────────────── */

export const MenuRoot = Menu.Root;
export const MenuTrigger = Menu.Trigger;

export function MenuContent({
  children,
  align = "end",
  side,
  className,
}: {
  children: ReactNode;
  align?: "start" | "end" | "center";
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}) {
  return (
    <Menu.Portal>
      <Menu.Content
        align={align}
        side={side}
        sideOffset={8}
        collisionPadding={12}
        className={cn(
          "menu z-50 min-w-60 max-w-[calc(100vw-24px)] rounded-2xl border border-rule bg-paper p-1.5 text-ink",
          "shadow-[0_18px_40px_-18px_rgba(0,0,0,0.45)]",
          className,
        )}
      >
        {children}
      </Menu.Content>
    </Menu.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  destructive,
  disabled,
}: {
  children: ReactNode;
  onSelect?: (event: Event) => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <Menu.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        "flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-3 text-label font-medium outline-none",
        "data-[highlighted]:bg-hover data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        destructive && "text-danger",
      )}
    >
      {children}
    </Menu.Item>
  );
}

export function MenuSeparator() {
  return <Menu.Separator className="my-1.5 h-px bg-rule" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <Menu.Label className="px-3 pb-1 pt-2 text-meta text-ink-soft">{children}</Menu.Label>;
}

/* ── Misc ──────────────────────────────────────────────────────────────── */

export function Initials({ name, initials, size = "md", className }: {
  name: string;
  initials?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const text = (initials || name.slice(0, 2)).toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-rule bg-counter font-bold text-ink",
        size === "sm" ? "size-8 text-[13px]" : "size-10 text-label",
        className,
      )}
    >
      {text}
    </span>
  );
}

export function CountBadge({ count, label }: { count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span
      className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-ink px-1.5 text-[13px] font-bold leading-none text-paper tabular-nums"
      aria-label={label}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="max-w-[46ch] py-10">
      <p className="text-body font-semibold">{title}</p>
      {body && <p className="mt-1 text-label text-ink-soft">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ScreenTitle({ children, id }: { children: ReactNode; id?: string }) {
  return <h1 id={id} className="text-title font-bold wdth-title">{children}</h1>;
}

export function InlineError({ children }: { children: ReactNode }) {
  return <p className="text-label text-danger" role="alert">{children}</p>;
}

/** Stable id helper for label/input pairs. */
export function useFieldId(prefix: string): string {
  return `${prefix}-${useId().replace(/:/g, "")}`;
}
