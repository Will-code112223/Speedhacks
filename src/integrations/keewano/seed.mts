// Backfill the SYNTHETIC transaction history (seed/transactions.json) into Keewano.
// Opt-in: needs KEEWANO_API_KEY. Re-running is a no-op per customer until the fixture changes
// (the dataSessionId is derived from the customer's charges, and Keewano ingestion is idempotent
// per dataSessionId + batch). Run: npm run keewano:seed
import { readFileSync } from "node:fs";
import { EVENTS_HASH, EVENT_TYPES, canonicalJson, customerEntityId, event, uuidV5 } from "./events.ts";
import { DEFAULT_INGEST_URL, KeewanoIngestClient } from "./ingest.ts";

const apiKey = process.env.KEEWANO_API_KEY;
if (!apiKey) throw new Error("Set KEEWANO_API_KEY (Keewano → Settings → Project → API Keys).");

interface Charge { chargeId: string; merchant: string; amountMinor: number; currency: string; at: string }
interface Customer { name: string; email: string; charges: Charge[] }
const fixture = JSON.parse(readFileSync(new URL("./seed/transactions.json", import.meta.url), "utf8")) as { customers: Customer[] };

const client = new KeewanoIngestClient({
  apiKey,
  baseUrl: process.env.KEEWANO_INGEST_URL ?? DEFAULT_INGEST_URL,
  eventTypes: EVENT_TYPES,
  eventsHash: EVENTS_HASH,
});

console.log(`registering ${EVENT_TYPES.length} custom events (hash ${EVENTS_HASH}) at ${client.baseUrl}`);
console.log("  →", JSON.stringify(await client.registerEventTypes()));

for (const customer of fixture.customers) {
  const entityId = customerEntityId(customer);
  if (!entityId) continue;
  const charges = [...customer.charges].sort((a, b) => a.at.localeCompare(b.at));
  const events = charges.flatMap((c) => [
    event("ChargeMerchant", c.merchant, c.at),
    event("ChargeAmount", c.amountMinor, c.at),
    event("ChargeCurrency", c.currency, c.at),
    event("ChargeId", c.chargeId, c.at), // last: the row that describes the charge
  ]);
  const dataSessionId = uuidV5(`speedhacks-refund:seed:${entityId}:${canonicalJson(charges)}`);
  const result = await client.sendBatch(entityId, events, { dataSessionId, batch: 1, testUserName: customer.name });
  console.log(`${customer.email} → entity ${entityId}: ${charges.length} charges, ${events.length} events, received ${result.received}, accepted ${result.accepted}${result.accepted === 0 ? " (already seeded or rejected)" : ""}`);
}
console.log("done; events become queryable a few minutes after a 202.");
