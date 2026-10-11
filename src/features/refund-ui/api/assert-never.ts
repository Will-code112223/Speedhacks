/** Compile-time exhaustiveness check for switches over unions. */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
