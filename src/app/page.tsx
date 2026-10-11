/**
 * Composition root for the UI. Teammate 1's default RefundApp from
 * src/features/refund-ui/RefundApp.tsx is mounted here after their handoff.
 * Until then this placeholder keeps the app runnable.
 */
// Read REFUND_MODE at request time, not build time.
export const dynamic = "force-dynamic";

export default function Page() {
  const mode = process.env.REFUND_MODE === "live" ? "live" : "simulated";
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "32px 16px" }}>
      <h1>Refund Assistant</h1>
      <p style={{ color: "var(--muted)" }}>
        Mode: <strong>{mode}</strong>
      </p>
      <p>
        Scaffold placeholder. The refund UI (<code>RefundApp</code>) mounts here once teammate 1 hands it
        off. The HTTP API lives under <code>/api/cases</code>.
      </p>
    </main>
  );
}
