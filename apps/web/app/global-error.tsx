"use client";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main
          style={{
            fontFamily: "Segoe UI, sans-serif",
            maxWidth: 720,
            margin: "10vh auto",
            padding: 24,
          }}
        >
          <h1>BEA Command Center is temporarily unavailable</h1>
          <p>The application shell could not start. No external action was taken.</p>
          <button onClick={reset} style={{ minHeight: 44, padding: "8px 16px" }}>
            Retry application
          </button>
        </main>
      </body>
    </html>
  );
}
