"use client";

import { Alert, Button, useMotionPreferences } from "@bea/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const NOTIFICATION_EXIT_MS = 240;

export function NotificationReadButton({ notificationId }: { notificationId: string }) {
  const router = useRouter();
  const { profile: motionProfile } = useMotionPreferences();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const rootRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const exitTimerRef = useRef<number | undefined>(undefined);
  const exitResolveRef = useRef<(() => void) | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      if (exitTimerRef.current !== undefined) window.clearTimeout(exitTimerRef.current);
      exitResolveRef.current?.();
    };
  }, []);

  function setRowState(state: "idle" | "pending" | "exiting") {
    const row = rootRef.current?.closest<HTMLElement>(".bea-list-presence-item");
    if (row) row.dataset.listState = state;
  }

  async function markRead() {
    setBusy(true);
    setError(undefined);
    setRowState("pending");
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const response = await fetch(
        `/api/notifications/${encodeURIComponent(notificationId)}/read`,
        { method: "POST", signal: controller.signal },
      );
      if (response.status === 401) {
        setRowState("idle");
        router.replace("/sign-in?reason=expired");
        return;
      }
      if (!response.ok) throw new Error("The notification could not be marked as read.");
      setRowState("exiting");
      if (motionProfile !== "reduced") {
        await new Promise<void>((resolve) => {
          exitResolveRef.current = () => {
            exitResolveRef.current = undefined;
            resolve();
          };
          exitTimerRef.current = window.setTimeout(
            () => exitResolveRef.current?.(),
            NOTIFICATION_EXIT_MS,
          );
        });
      }
      if (controller.signal.aborted) return;
      router.refresh();
    } catch (caught) {
      if (controller.signal.aborted) return;
      setRowState("idle");
      setError(caught instanceof Error ? caught.message : "The notification could not be updated.");
    } finally {
      controllerRef.current = undefined;
      exitTimerRef.current = undefined;
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <div ref={rootRef} className="bea-stack">
      <Button size="small" variant="ghost" busy={busy} onClick={() => void markRead()}>
        Mark read
      </Button>
      {busy ? (
        <span className="bea-visually-hidden" role="status">
          Updating notification.
        </span>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
