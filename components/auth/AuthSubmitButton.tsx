"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

type AuthSubmitButtonProps = {
  children: ReactNode;
  pendingLabel: string;
  pendingDescription?: string;
  className?: string;
  iconOnly?: boolean;
  label?: string;
  title?: string;
  align?: "center" | "start";
  showOverlay?: boolean;
};

function Spinner({ className = "size-4" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`${className} shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none`}
    />
  );
}

function AuthPendingDialog({
  id,
  label,
  description,
}: {
  id: string;
  label: string;
  description: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    dialog.showModal();
    dialog.focus();

    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => event.preventDefault()}
      className="m-auto w-[calc(100%-2rem)] max-w-sm border-0 bg-transparent p-0 text-[var(--ink-primary)] backdrop:bg-black/30 backdrop:backdrop-blur-[1px]"
    >
      <div
        className="card p-6 text-center shadow-[var(--shadow-float)]"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <Spinner className="mx-auto size-9 text-[var(--brand)]" />
        <p id={titleId} className="mt-4 text-base font-semibold text-[var(--ink-primary)]">
          {label}
        </p>
        <p id={descriptionId} className="mt-2 text-sm leading-relaxed text-[var(--ink-secondary)]">
          {description}
        </p>
      </div>
    </dialog>
  );
}

/**
 * Submission feedback for the security-sensitive authentication actions.
 *
 * It must be rendered inside the form whose status it represents. While the
 * Server Action is running, the button prevents duplicate taps and the fixed
 * status panel makes the wait unambiguous on both small and large screens.
 */
export function AuthSubmitButton({
  children,
  pendingLabel,
  pendingDescription = "Please wait. This can take a few seconds on a mobile connection.",
  className = "",
  iconOnly = false,
  label,
  title,
  align = "center",
  showOverlay = true,
}: AuthSubmitButtonProps) {
  const { pending } = useFormStatus();
  const progressId = useId();
  const accessibleLabel = pending ? pendingLabel : label;

  return (
    <>
      <button
        type="submit"
        disabled={pending}
        aria-disabled={pending}
        aria-label={accessibleLabel}
        aria-describedby={pending && showOverlay ? `${progressId}-description` : undefined}
        title={title}
        className={`disabled:cursor-wait disabled:opacity-70 ${className}`}
      >
        {iconOnly ? (
          pending ? <Spinner /> : children
        ) : (
          <span className={`inline-flex items-center gap-2 ${align === "start" ? "justify-start" : "justify-center"}`}>
            {pending && <Spinner />}
            <span>{pending ? pendingLabel : children}</span>
          </span>
        )}
      </button>

      {pending && showOverlay && (
        <AuthPendingDialog
          id={progressId}
          label={pendingLabel}
          description={pendingDescription}
        />
      )}
    </>
  );
}
