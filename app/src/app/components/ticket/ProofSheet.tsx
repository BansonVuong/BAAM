import { useEffect, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { submitCheckin, uploadProof, type Bet } from "../../../lib/relayer";
import { formatTimeOfDay, friendlyError } from "../../../lib/bets";
import { prepareProofImage, PROOF_ACCEPT, type PreparedImage } from "../../../lib/image";
import { Button, Field, InlineError, Sheet, TextArea, TextInput, buttonClass, useFieldId } from "../primitives";

export const CAPTION_MAX = 280;

export type ProofSheetMode = "proof" | "checkin";

function validLink(value: string): boolean {
  if (!value.trim()) return true;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Photo / link / caption picker, used for "Add proof" and "Check in". */
export function ProofSheet({
  bet,
  mode,
  onClose,
  onDone,
}: {
  bet: Bet | null;
  mode: ProofSheetMode;
  onClose: () => void;
  onDone: () => void;
}) {
  const open = Boolean(bet);
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [link, setLink] = useState("");
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ids = { link: useFieldId("proof-link"), caption: useFieldId("proof-caption"), file: useFieldId("proof-file") };

  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => {
      setImage((current) => { if (current) URL.revokeObjectURL(current.previewUrl); return null; });
      setLink(""); setCaption(""); setError(null); setAttempted(false); setBusy(false); setPreparing(false);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [open]);

  async function pick(file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    setPreparing(true);
    try {
      const prepared = await prepareProofImage(file);
      setImage((current) => { if (current) URL.revokeObjectURL(current.previewUrl); return prepared; });
    } catch (err) {
      setError(friendlyError(err, "This photo couldn't be opened. Try a JPEG or PNG."));
    } finally {
      setPreparing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const checkin = mode === "checkin";
  const linkError = validLink(link) ? null : "Paste a full link that starts with https://";
  const captionError = caption.length > CAPTION_MAX ? `Keep it to ${CAPTION_MAX} characters.` : null;
  const missing = checkin
    ? (!image && !link.trim() ? "Add a photo or a link so witnesses can check it." : null)
    : (!image && !link.trim() && !caption.trim() ? "Add a photo, a link, or a few words." : null);

  async function submit(): Promise<void> {
    if (!bet) return;
    setAttempted(true);
    setError(null);
    if (linkError || captionError || missing) return;
    setBusy(true);
    try {
      const input = {
        image: image?.blob,
        link: link.trim() || undefined,
        caption: caption.trim() || undefined,
      };
      if (checkin) await submitCheckin(bet.id, input);
      else await uploadProof(bet.id, input);
      onDone();
    } catch (err) {
      setError(friendlyError(err, checkin ? "Couldn't check in. Try again." : "Couldn't upload this proof. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const openWindow = bet?.checkinProgress?.currentWindow;
  const description = checkin
    ? `Show the witnesses you did it${openWindow ? ` today. Check-ins close at ${formatTimeOfDay(openWindow.end)}` : ""}.`
    : "Attach something that shows what happened. Everyone in the chat can see it.";

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      dismissible={!busy}
      size="sm"
      title={checkin ? "Check in" : "Add proof"}
      description={description}
      footer={(
        <>
          {(error || (attempted && missing)) && (
            <div className="mr-auto basis-full"><InlineError>{error ?? missing}</InlineError></div>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => { void submit(); }} disabled={busy || preparing}>
            {busy ? (checkin ? "Checking in…" : "Uploading…") : checkin ? "Check in" : "Upload"}
          </Button>
        </>
      )}
    >
      {bet && <p className="mb-5 text-body font-semibold">{bet.terms}</p>}
      <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
        <div>
          <p className="mb-1.5 text-label font-semibold">Photo</p>
          <input
            ref={fileRef}
            id={ids.file}
            type="file"
            accept={PROOF_ACCEPT}
            className="sr-only"
            onChange={(event) => { void pick(event.target.files?.[0]); }}
            disabled={busy}
          />
          {image ? (
            <div className="flex items-start gap-3">
              <img
                src={image.previewUrl}
                alt={caption.trim() || "Your proof photo"}
                className="h-28 w-28 rounded-xl border border-rule object-cover"
              />
              <div className="flex flex-col gap-1">
                <label htmlFor={ids.file} className={buttonClass("secondary", "sm", "cursor-pointer")}>Choose another</label>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setImage((current) => { if (current) URL.revokeObjectURL(current.previewUrl); return null; })}
                  disabled={busy}
                >
                  <X size={16} aria-hidden />
                  Remove
                </Button>
              </div>
            </div>
          ) : (
            <label
              htmlFor={ids.file}
              className="flex min-h-24 cursor-pointer items-center gap-3 rounded-xl border border-dashed border-rule px-4 py-4 text-label hover:bg-hover"
            >
              <ImagePlus size={22} aria-hidden />
              <span>
                <span className="block font-semibold">{preparing ? "Getting the photo ready…" : "Choose a photo"}</span>
                <span className="block text-meta text-ink-soft">JPEG, PNG, WebP or HEIC. Big photos are shrunk before upload.</span>
              </span>
            </label>
          )}
        </div>

        <Field label="Link" htmlFor={ids.link} error={attempted ? linkError : null} hint="Optional. A Strava activity, a post, a receipt.">
          <TextInput
            id={ids.link}
            type="url"
            inputMode="url"
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="https://"
            autoComplete="off"
            disabled={busy}
            aria-invalid={Boolean(attempted && linkError)}
          />
        </Field>

        <Field
          label="Caption"
          htmlFor={ids.caption}
          error={captionError}
          hint={`Optional. ${caption.length} of ${CAPTION_MAX} characters.`}
        >
          <TextArea
            id={ids.caption}
            rows={2}
            maxLength={CAPTION_MAX + 20}
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder={checkin ? "5:58 at the gym" : "What this shows"}
            disabled={busy}
            aria-invalid={Boolean(captionError)}
          />
        </Field>
      </form>
    </Sheet>
  );
}
