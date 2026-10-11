/**
 * Real time is the injected clock in ms. Script time ("virtual" time) is real
 * time since a call started, multiplied by the fixture speed, so every scripted
 * duration shrinks together when the demo runs faster.
 */

export function toVirtual(startedAtMs: number, nowMs: number, speed: number): number {
  return (nowMs - startedAtMs) * speed;
}

export function toReal(startedAtMs: number, virtualMs: number, speed: number): number {
  return startedAtMs + virtualMs / speed;
}

export function iso(ms: number): string {
  return new Date(Math.floor(ms)).toISOString();
}
