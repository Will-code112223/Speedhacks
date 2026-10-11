import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const SMOKE_SCRIPT = fileURLToPath(new URL("../live-smoke.mts", import.meta.url));
const ACCOUNT_SCRIPT = fileURLToPath(new URL("../check-account.mts", import.meta.url));
const TEST_DIRECTORY = fileURLToPath(new URL("./", import.meta.url));
const SYNTHETIC_KEY = "synthetic-script-api-key-not-a-real-key";
const DESTINATION = "+14155550102";

// Every child starts with a scrubbed environment and an unconditional fetch
// replacement before importing production code. These tests cannot call Dial.
const PRELOAD = `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (input, init = {}) => {
  appendFileSync(process.env.TEST_FETCH_LOG, JSON.stringify({
    url: String(input), method: init.method || "GET", body: init.body || null
  }) + "\\n", { mode: 0o600 });
  const scenario = process.env.TEST_FETCH_SCENARIO;
  if (scenario === "unknown") throw new Error("Synthetic network failure containing " + process.env.DIAL_API_KEY);
  if (scenario === "account-transport-error") throw new Error("PRIVATE_TRANSPORT_FAILURE_MUST_NOT_PRINT");
  if (scenario === "account-invalid-json") return new Response("PRIVATE_PROVIDER_BODY_MUST_NOT_PRINT", { status: 200 });
  if (scenario === "account") return Response.json({
    maxCallDurationSeconds: null,
    limits: { maxCallDurationSeconds: 300, maxConcurrentCalls: 1 },
    email: "PRIVATE_IDENTITY_MUST_NOT_PRINT",
    keyPreview: "PRIVATE_KEY_PREVIEW_MUST_NOT_PRINT"
  });
  if (scenario === "malformed-account") return Response.json({ email: "PRIVATE_IDENTITY_MUST_NOT_PRINT" });
  if (scenario !== "accepted") throw new Error("UNEXPECTED_NETWORK_ATTEMPT");
  return Response.json({ call: { id: "call_synthetic_script_001" } }, { status: 201 });
};
`;

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "dial-script-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const preload = join(directory, "synthetic-fetch.mjs");
  const log = join(directory, "fetch.jsonl");
  const attempt = join(directory, "attempt.json");
  writeFileSync(preload, PRELOAD, { mode: 0o600 });
  return {
    directory, attempt,
    run(script: string, args: string[], env: Record<string, string> = {}, scenario = "forbidden") {
      return spawnSync(process.execPath, ["--import", preload, script, ...args], {
        cwd: directory,
        encoding: "utf8",
        timeout: 5000,
        env: { TEST_FETCH_LOG: log, TEST_FETCH_SCENARIO: scenario, ...env },
      });
    },
    requests(): { url: string; method: string; body: string | null }[] {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    },
  };
}

function consentedEnv(attempt: string): Record<string, string> {
  return {
    DIAL_API_KEY: SYNTHETIC_KEY,
    DIAL_FROM_NUMBER: "+14155550101",
    DIAL_TEST_TO: DESTINATION,
    DIAL_TEST_CONSENT_TO: DESTINATION,
    DIAL_SMOKE_ATTEMPT_FILE: attempt,
  };
}

test("smoke refuses missing opt-in, consent, credentials and invalid paths before any request", async (t) => {
  const cases: { name: string; args: string[]; override: Record<string, string> }[] = [
    { name: "no --live", args: [], override: {} },
    { name: "missing consent", args: ["--live"], override: { DIAL_TEST_CONSENT_TO: "" } },
    { name: "different consenting recipient", args: ["--live"], override: { DIAL_TEST_CONSENT_TO: "+14155550999" } },
    { name: "invalid destination", args: ["--live"], override: { DIAL_TEST_TO: "911", DIAL_TEST_CONSENT_TO: "911" } },
    { name: "missing API key", args: ["--live"], override: { DIAL_API_KEY: "" } },
    { name: "missing sending number", args: ["--live"], override: { DIAL_FROM_NUMBER: "" } },
    { name: "relative attempt path", args: ["--live"], override: { DIAL_SMOKE_ATTEMPT_FILE: "relative.json" } },
    { name: "non-ASCII API key", args: ["--live"], override: { DIAL_API_KEY: "synthetic-\u2603" } },
    { name: "whitespace API key", args: ["--live"], override: { DIAL_API_KEY: "synthetic key" } },
  ];
  for (const item of cases) {
    await t.test(item.name, (subtest) => {
      const setup = fixture(subtest);
      const result = setup.run(SMOKE_SCRIPT, item.args, { ...consentedEnv(setup.attempt), ...item.override });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.equal(setup.requests().length, 0);
      assert.equal(existsSync(setup.attempt), false);
      assert.ok(!result.stdout.includes(SYNTHETIC_KEY));
      assert.ok(!result.stderr.includes(SYNTHETIC_KEY));
    });
  }
});

test("smoke refuses repository-contained or symlink-to-repository attempt files", async (t) => {
  for (const viaSymlink of [false, true]) {
    await t.test(viaSymlink ? "symlink parent" : "direct path", (subtest) => {
      const setup = fixture(subtest);
      const filename = `.synthetic-rejected-smoke-${randomUUID()}.json`;
      const repoTarget = join(TEST_DIRECTORY, filename);
      subtest.after(() => rmSync(repoTarget, { force: true }));
      const link = join(setup.directory, "repo-link");
      if (viaSymlink) symlinkSync(TEST_DIRECTORY, link, "dir");
      const attemptPath = viaSymlink ? join(link, filename) : repoTarget;
      const result = setup.run(SMOKE_SCRIPT, ["--live"], consentedEnv(attemptPath));
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.equal(setup.requests().length, 0);
      assert.equal(existsSync(repoTarget), false);
    });
  }
});

test("smoke preserves an existing attempt file and refuses a second dispatch", (t) => {
  const setup = fixture(t);
  const pending = '{"state":"dispatch_unknown","attemptId":"synthetic-prior-attempt"}';
  writeFileSync(setup.attempt, pending, { mode: 0o600 });
  const result = setup.run(SMOKE_SCRIPT, ["--live"], consentedEnv(setup.attempt));
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.equal(setup.requests().length, 0);
  assert.equal(readFileSync(setup.attempt, "utf8"), pending);
});

test("synthetic accepted smoke persists one private attempt and refuses rerunning it", (t) => {
  const setup = fixture(t);
  const env = consentedEnv(setup.attempt);
  const result = setup.run(SMOKE_SCRIPT, ["--live"], env, "accepted");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const requests = setup.requests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.url, "https://api.getdial.ai/api/v1/calls");
  assert.equal(JSON.parse(requests[0]?.body ?? "{}").maxCallDurationSeconds, 60);
  const stored = JSON.parse(readFileSync(setup.attempt, "utf8"));
  assert.equal(stored.result.state, "accepted");
  assert.equal(stored.state, stored.result.state);
  assert.equal(stored.result.providerCallId, "call_synthetic_script_001");
  assert.equal(statSync(setup.attempt).mode & 0o777, 0o600);
  assert.ok(!result.stdout.includes(SYNTHETIC_KEY));
  assert.ok(!readFileSync(setup.attempt, "utf8").includes(SYNTHETIC_KEY));
  const repeated = setup.run(SMOKE_SCRIPT, ["--live"], env, "accepted");
  assert.notEqual(repeated.status, 0);
  assert.equal(setup.requests().length, 1);
});

test("synthetic ambiguous smoke stores uncertainty once and never retries", (t) => {
  const setup = fixture(t);
  const env = consentedEnv(setup.attempt);
  const result = setup.run(SMOKE_SCRIPT, ["--live"], env, "unknown");
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.equal(setup.requests().length, 1);
  const stored = JSON.parse(readFileSync(setup.attempt, "utf8"));
  assert.equal(stored.result.state, "dispatch_unknown");
  assert.equal(stored.state, stored.result.state);
  assert.ok(!result.stdout.includes(SYNTHETIC_KEY));
  assert.ok(!result.stderr.includes(SYNTHETIC_KEY));
  const repeated = setup.run(SMOKE_SCRIPT, ["--live"], env, "unknown");
  assert.notEqual(repeated.status, 0);
  assert.equal(setup.requests().length, 1);
});

test("account check cannot fetch with missing or malformed credentials", async (t) => {
  for (const key of ["", "synthetic key", "synthetic-\u2603"]) {
    await t.test(key ? "malformed synthetic key" : "missing key", (subtest) => {
      const setup = fixture(subtest);
      const result = setup.run(ACCOUNT_SCRIPT, [], { DIAL_API_KEY: key });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.equal(setup.requests().length, 0);
    });
  }
});

test("account check emits only validated limits from a synthetic response", (t) => {
  const setup = fixture(t);
  const result = setup.run(ACCOUNT_SCRIPT, [], { DIAL_API_KEY: SYNTHETIC_KEY }, "account");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(setup.requests().length, 1);
  assert.equal(setup.requests()[0]?.method, "GET");
  assert.equal(setup.requests()[0]?.url, "https://api.getdial.ai/api/v1/account");
  const printed = JSON.parse(result.stdout);
  assert.deepEqual(printed.freeGuardrails, { maxCallDurationSeconds: 300, maxConcurrentCalls: 1 });
  assert.ok(!result.stdout.includes("PRIVATE_"));
  assert.ok(!result.stdout.includes(SYNTHETIC_KEY));
});

test("account check does not treat a malformed limits response as unlimited", (t) => {
  const setup = fixture(t);
  const result = setup.run(ACCOUNT_SCRIPT, [], { DIAL_API_KEY: SYNTHETIC_KEY }, "malformed-account");
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.equal(setup.requests().length, 1);
  assert.ok(!result.stdout.includes("PRIVATE_"));
  assert.ok(!result.stderr.includes("PRIVATE_"));
});

test("account lookup cannot expose provider or transport error text", async (t) => {
  for (const scenario of ["account-invalid-json", "account-transport-error"]) {
    await t.test(scenario, (subtest) => {
      const setup = fixture(subtest);
      const result = setup.run(ACCOUNT_SCRIPT, [], { DIAL_API_KEY: SYNTHETIC_KEY }, scenario);
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.equal(setup.requests().length, 1);
      assert.ok(!result.stdout.includes("PRIVATE_"));
      assert.ok(!result.stderr.includes("PRIVATE_"));
      assert.ok(!result.stdout.includes(SYNTHETIC_KEY));
      assert.ok(!result.stderr.includes(SYNTHETIC_KEY));
    });
  }
});
