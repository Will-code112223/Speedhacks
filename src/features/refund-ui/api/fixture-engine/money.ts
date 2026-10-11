/** Formats integer minor units using the currency's own number of decimal places. */
export function formatMoney(amountMinor: number, currency: string): string {
  try {
    const format = new Intl.NumberFormat("en-US", { style: "currency", currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(amountMinor / 10 ** digits);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency}`;
  }
}
