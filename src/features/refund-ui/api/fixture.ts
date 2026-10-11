/**
 * Fixture mode: a deterministic in-browser scenario engine behind the CaseApi
 * interface. Selected explicitly (see client.ts); never a fallback for http.
 *
 * Scenarios come from FixtureOptions.scenario or inferScenario(summary). The
 * engine computes call progress from the injected clock on every read, so
 * tests drive it by moving `now`, with no timers involved.
 *
 * Provider refusal: a support phone ending in 0001 is refused before dispatch
 * (503 PROVIDER_UNAVAILABLE), matching the server's simulated adapter.
 */

export { BACKEND_SIMULATED_SUFFIXES, type BackendSimulatedSuffix } from "./backend-notes";
export { createFixtureCaseApi } from "./fixture-engine/engine";
export { inferScenario } from "./fixture-engine/scenarios";
