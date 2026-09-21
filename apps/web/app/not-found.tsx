import { ErrorState, Link } from "@bea/ui";

export default function NotFound() {
  return (
    <main className="bea-main-content">
      <ErrorState
        title="Page not found"
        description="The requested Command Center route does not exist in the Phase 0 foundation."
        action={<Link href="/">Return to Command Center</Link>}
      />
    </main>
  );
}
