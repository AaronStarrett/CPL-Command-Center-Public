"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "./workspace.module.css";
import css from "./commercial.module.css";

function UnsavedChangesDialog({ keep, discard }: { keep: () => void; discard: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const title = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    keepButton.current?.focus();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={css.dialog}
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        keep();
      }}
    >
      <p className={styles.eyebrow}>UNSAVED CHANGES</p>
      <h2 id={title}>Keep your work?</h2>
      <p>
        Your changes have not been saved. Keep editing, or discard them and continue to the selected
        destination.
      </p>
      <div className={styles.actions}>
        <button ref={keepButton} type="button" className={styles.primary} onClick={keep}>
          Keep editing
        </button>
        <button type="button" className={styles.secondary} onClick={discard}>
          Discard changes
        </button>
      </div>
    </dialog>
  );
}

/** Defer the actual navigation so cancelling never loses the current form or sends a request. */
export function useUnsavedNavigation(dirty: boolean) {
  const [pending, setPending] = useState<{ action: () => void } | null>(null);
  function navigate(action: () => void) {
    if (dirty) setPending({ action });
    else action();
  }
  return {
    navigate,
    dialog: pending ? (
      <UnsavedChangesDialog
        keep={() => setPending(null)}
        discard={() => {
          const action = pending.action;
          setPending(null);
          action();
        }}
      />
    ) : null,
  };
}
