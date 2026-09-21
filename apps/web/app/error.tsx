"use client";

import { Button, ErrorState } from "@bea/ui";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="bea-main-content">
      <ErrorState
        title="This view could not be loaded"
        description="The failure was contained. Retry the view, or return to the Command Center if it continues."
        action={<Button onClick={reset}>Retry</Button>}
      />
    </div>
  );
}
