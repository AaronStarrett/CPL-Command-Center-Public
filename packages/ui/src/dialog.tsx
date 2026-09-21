"use client";

import { useCallback, useEffect, useId, useRef, type AnimationEvent, type ReactNode } from "react";

import { Button } from "./button";
import { useMotionPreferences } from "./motion";

const DIALOG_EXIT_MS = 180;

function syncDocumentModalState() {
  document.documentElement.dataset.motionModal = document.querySelector("dialog.bea-dialog[open]")
    ? "open"
    : "closed";
}

export interface ConfirmationDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  children,
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const titleId = useId();
  const descriptionId = useId();
  const { profile: motionProfile } = useMotionPreferences();
  const closing = !open && motionProfile !== "reduced" && Boolean(dialogRef.current?.open);

  const closeDialog = useCallback(() => {
    if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = undefined;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialog.open) dialog.close();
    dialog.inert = false;
    dialog.dataset.state = "closed";
    syncDocumentModalState();
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = undefined;

    if (open) {
      dialog.dataset.state = "open";
      dialog.inert = false;
      if (!dialog.open) dialog.showModal();
      syncDocumentModalState();
      return;
    }
    if (!dialog.open) {
      dialog.dataset.state = "closed";
      return;
    }
    if (motionProfile === "reduced") {
      closeDialog();
      return;
    }

    dialog.dataset.state = "closing";
    dialog.inert = true;
    closeTimerRef.current = window.setTimeout(closeDialog, DIALOG_EXIT_MS);
    return () => {
      if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    };
  }, [closeDialog, motionProfile, open]);

  function finishAnimatedClose(event: AnimationEvent<HTMLDivElement>) {
    if (
      event.animationName === "bea-dialog-exit" &&
      dialogRef.current?.dataset.state === "closing"
    ) {
      closeDialog();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="bea-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy && !closing) onCancel();
      }}
      onClose={() => {
        if (open) onCancel();
      }}
    >
      <div className="bea-dialog__content" onAnimationEnd={finishAnimatedClose}>
        <h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{description}</p>
        {children}
        <div className="bea-dialog__actions">
          <Button
            variant="ghost"
            onClick={() => {
              if (dialogRef.current?.dataset.state !== "closing") onCancel();
            }}
            disabled={busy || closing}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onClick={() => {
              if (dialogRef.current?.dataset.state !== "closing") onConfirm();
            }}
            busy={busy}
            disabled={closing}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
