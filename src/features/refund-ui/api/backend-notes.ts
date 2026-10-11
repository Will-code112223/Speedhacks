/**
 * How the case server behaves in REFUND_MODE=simulated: its simulated voice
 * adapter picks the call result from the last four digits of the merchant
 * support phone. The UI can show this as a hint in http mode so a demo can
 * reach every outcome. Mirrors src/server/cases/simulated-voice.ts on the
 * backend branch; the fixture client implements only the 0001 refusal.
 */

export interface BackendSimulatedSuffix {
  /** Last four digits of merchant.supportPhone, or "any other". */
  suffix: string;
  description: string;
}

export const BACKEND_SIMULATED_SUFFIXES: readonly BackendSimulatedSuffix[] = [
  { suffix: "0001", description: "Rejected before dispatch (503 PROVIDER_UNAVAILABLE); nothing is dialed." },
  { suffix: "0002", description: "Dispatch result unknown; the attempt stays open and is never redialed." },
  { suffix: "0003", description: "Call completes and support denies the refund." },
  { suffix: "0004", description: "Call completes and support asks for more information." },
  { suffix: "0005", description: "Call fails with no answer." },
  { suffix: "0006", description: "Call is cancelled." },
  { suffix: "any other", description: "Call completes and support approves the refund with a reference number." },
];
