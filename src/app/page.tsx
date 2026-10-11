// Read REFUND_MODE at request time, not build time.
export const dynamic = "force-dynamic";

import RefundApp from "@/features/refund-ui/RefundApp";

export default function Page() {
  const mode = process.env.REFUND_MODE === "live" ? "live" : "simulated";
  return <RefundApp serverMode={mode} />;
}
