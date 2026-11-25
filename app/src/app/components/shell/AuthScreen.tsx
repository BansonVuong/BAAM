import { useState, type FormEvent, type ReactNode } from "react";
import { loginWithEmail, signupWithEmail, type AuthResult } from "../../../lib/relayer";
import { friendlyError } from "../../../lib/bets";
import { Button, Field, InlineError, TextInput, useFieldId } from "../primitives";
import { Ticket } from "../ticket/Ticket";

export function Wordmark({ className }: { className?: string }) {
  return <span className={`font-black uppercase wdth-wide tracking-[0.02em] ${className ?? ""}`}>BAAM</span>;
}

export const BAAM_ONE_LINER = "Bet your friends in the group chat. Friends witness it, the winner gets paid.";

/** Full-screen centered layout shared by sign-in and the Discord link screens. */
export function AuthLayout({ children, aside = true }: { children: ReactNode; aside?: boolean }) {
  return (
    <main className="min-h-dvh bg-counter px-4 py-8 md:flex md:items-center md:justify-center md:py-12">
      <div className="mx-auto grid w-full max-w-[960px] items-center gap-8 md:grid-cols-[minmax(0,1fr)_400px] md:gap-14">
        <div>
          <Wordmark className="text-[44px] leading-none md:text-[64px]" />
          <p className="mt-3 max-w-[34ch] text-body text-ink-soft md:text-[19px] md:leading-[28px]">{BAAM_ONE_LINER}</p>
          {aside && (
            <div className="mt-6 hidden max-w-[460px] md:block" aria-hidden>
              <Ticket
                id="welcome-ticket"
                stock="done"
                settledFrom="verdict"
                terms="Jordan makes every 5am lift, Monday to Friday"
                stake="0.25"
                currency="SOL"
                parties="jordan vs maya"
                details={["2 witnesses, decided Friday"]}
                status="Paid to jordan"
                stamp={{ text: "Paid to jordan", tone: "win" }}
              />
            </div>
          )}
        </div>
        <div>{children}</div>
      </div>
    </main>
  );
}

export function AuthScreen({
  onAuthed,
  discordLinking,
  initialMode = "signup",
}: {
  onAuthed: (result: AuthResult) => void;
  discordLinking: boolean;
  initialMode?: "signup" | "login";
}) {
  const [mode, setMode] = useState<"signup" | "login">(initialMode);
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { email: useFieldId("email"), username: useFieldId("username"), password: useFieldId("password") };

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = mode === "signup"
        ? await signupWithEmail({ email, username, password })
        : await loginWithEmail({ email, password });
      onAuthed(result);
    } catch (err) {
      setError(friendlyError(err, mode === "signup" ? "Couldn't create your account. Try again." : "Couldn't sign you in. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <form onSubmit={(event) => { void submit(event); }} className="rounded-[20px] bg-paper p-6 md:p-8" noValidate={false}>
        {discordLinking && (
          <p className="mb-5 rounded-xl border border-rule px-4 py-3 text-label">
            <span className="font-semibold">Linking your Discord account.</span>{" "}
            <span className="text-ink-soft">
              {mode === "signup" ? "Create an account or sign in" : "Sign in or create an account"} and we'll connect it automatically.
            </span>
          </p>
        )}
        <h1 className="text-title font-bold wdth-title">{mode === "signup" ? "Create your account" : "Sign in"}</h1>
        <p className="mt-1 text-label text-ink-soft">
          {mode === "signup" ? "Pick the username your friends will challenge." : "Welcome back."}
        </p>

        <div className="mt-6 space-y-4">
          <Field label="Email" htmlFor={ids.email}>
            <TextInput
              id={ids.email}
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@email.com"
            />
          </Field>
          {mode === "signup" && (
            <Field label="Username" htmlFor={ids.username} hint="Letters, numbers and underscores.">
              <TextInput
                id={ids.username}
                required
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="maya"
              />
            </Field>
          )}
          <Field label="Password" htmlFor={ids.password} hint={mode === "signup" ? "At least 8 characters." : undefined}>
            <TextInput
              id={ids.password}
              type="password"
              required
              minLength={mode === "signup" ? 8 : undefined}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        </div>

        {error && <div className="mt-4"><InlineError>{error}</InlineError></div>}

        <Button type="submit" variant="primary" className="mt-6 w-full" disabled={busy}>
          {busy ? (mode === "signup" ? "Creating account…" : "Signing in…") : mode === "signup" ? "Create account" : "Sign in"}
        </Button>
        <p className="mt-4 text-center text-label text-ink-soft">
          {mode === "signup" ? "Already have an account?" : "New to BAAM?"}{" "}
          <button
            type="button"
            className="min-h-11 rounded-md px-1 font-semibold text-ink underline underline-offset-4"
            onClick={() => { setError(null); setMode((m) => (m === "signup" ? "login" : "signup")); }}
          >
            {mode === "signup" ? "Sign in" : "Create an account"}
          </button>
        </p>
      </form>
    </AuthLayout>
  );
}
