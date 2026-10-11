import type { ChargeRecord, CustomerRef, TransactionHistory } from "@/server/cases/history";
import { normalizeMerchant } from "@/server/cases/history";
import { buildChargesSql, chargesFromRows } from "./charges";
import { customerEntityIds } from "./events";
import type { KeewanoMcpClient } from "./mcp";
import fixture from "./seed/transactions.json";

/** Live: the customer's charges read from Keewano over MCP. */
export class KeewanoTransactionHistory implements TransactionHistory {
  readonly kind = "keewano";
  private readonly mcp: Pick<KeewanoMcpClient, "runSql">;
  private readonly limit: number;

  constructor(mcp: Pick<KeewanoMcpClient, "runSql">, opts: { limit?: number } = {}) {
    this.mcp = mcp;
    this.limit = opts.limit ?? 500;
  }

  /** Email-derived entity first; a name-only case falls back to the name-derived entity. */
  async listCharges(customer: CustomerRef): Promise<ChargeRecord[]> {
    for (const entityId of customerEntityIds(customer)) {
      const charges = chargesFromRows(await this.mcp.runSql(buildChargesSql(entityId, this.limit)));
      if (charges.length > 0) return charges;
    }
    return [];
  }
}

export interface FixtureCustomer {
  name: string;
  email: string;
  charges: ChargeRecord[];
}

export interface TransactionFixture {
  customers: FixtureCustomer[];
}

/**
 * Stand-in when Keewano is not configured: the same synthetic customers the seed CLI
 * sends to Keewano, read locally. Labeled "fixture" everywhere it appears.
 */
export class FixtureTransactionHistory implements TransactionHistory {
  readonly kind = "fixture";
  private readonly customers: FixtureCustomer[];

  constructor(data: TransactionFixture = fixture as TransactionFixture) {
    this.customers = data.customers;
  }

  async listCharges(customer: CustomerRef): Promise<ChargeRecord[]> {
    const email = customer.email?.trim().toLowerCase();
    const name = customer.name ? normalizeMerchant(customer.name) : "";
    const found =
      (email ? this.customers.find((c) => c.email.toLowerCase() === email) : undefined) ??
      (name ? this.customers.find((c) => normalizeMerchant(c.name) === name) : undefined);
    return found ? found.charges.map((c) => ({ ...c })) : [];
  }
}
