import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../claim-demo.mts", import.meta.url));
const TEST_DIRECTORY = fileURLToPath(new URL("./", import.meta.url));
const KEY = "SYNTHETIC_PRIVATE_KEY_NEVER_PRINT";
const PHONE = "+14155550102";
const CALL_ID = "synthetic_claim_demo_call_001";
const TRANSCRIPT = "PRIVATE_TRANSCRIPT_NEVER_PRINT: participant suggests the fictional repair estimate.";
const PRELOAD = `
import { appendFileSync, readFileSync } from "node:fs";
globalThis.fetch = async (input, init = {}) => {
  const attempt = JSON.parse(readFileSync(process.env.DIAL_CLAIM_DEMO_ATTEMPT_FILE, "utf8"));
  appendFileSync(process.env.TEST_FETCH_LOG, JSON.stringify({
    method: init.method || "GET", url: String(input), body: init.body || null, reservedState: attempt.state
  }) + "\\n", { mode: 0o600 });
  if (process.env.TEST_SCENARIO === "unknown") throw new Error("PRIVATE_TRANSPORT: " + process.env.DIAL_API_KEY);
  if (process.env.TEST_SCENARIO === "malformed") return Response.json({ private: "PRIVATE_PROVIDER_BODY" });
  if (init.method === "POST" && process.env.TEST_SCENARIO === "accepted") return Response.json({call:{id:"${CALL_ID}"}}, {status:201});
  if (init.method === "GET" && ["read-pending", "read-transcript"].includes(process.env.TEST_SCENARIO)) {
    return Response.json({call:{id:"${CALL_ID}",status:{state:"Terminated",terminationType:"completed"},
      duration:25,transcript: process.env.TEST_SCENARIO === "read-transcript" ? ${JSON.stringify(TRANSCRIPT)} : null}});
  }
  throw new Error("UNEXPECTED_NETWORK_ATTEMPT");
};
`;
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "dial-claim-demo-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const attempt = join(directory, "attempt.json");
  const log = join(directory, "requests.jsonl");
  const preload = join(directory, "mock-fetch.mjs");
  writeFileSync(preload, PRELOAD, { mode: 0o600 });
  const env = { DIAL_API_KEY: KEY, DIAL_FROM_NUMBER: "+14155550101", DIAL_TEST_TO: PHONE,
    DIAL_TEST_CONSENT_TO: PHONE, DIAL_CLAIM_DEMO_ATTEMPT_FILE: attempt };
  return { directory, attempt, env,
    run(args = ["--live", "--confirm-credits"], overrides: Record<string, string> = {}, scenario = "forbidden") {
      const result = spawnSync(process.execPath, ["--import", preload, SCRIPT, ...args], {
        cwd: directory, encoding: "utf8", timeout: 5000,
        env: { ...env, ...overrides, TEST_FETCH_LOG: log, TEST_SCENARIO: scenario },
      });
      assert.equal(result.error, undefined);
      assert.ok(![result.stdout, result.stderr].some(output =>
        [KEY, PHONE, TRANSCRIPT, "PRIVATE_TRANSPORT", "PRIVATE_PROVIDER_BODY"].some(secret => output.includes(secret))));
      return result;
    },
    requests(): { method: string; url: string; body: string | null; reservedState: string }[] {
      return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    },
    artifact() { return JSON.parse(readFileSync(attempt, "utf8")); },
  };
}

test("fictional demo refuses missing consent, credit opt-in and credentials before creating an attempt", async t => {
  const cases: { name: string; args?: string[]; env: Record<string, string> }[] = [
    { name: "no flags", args: [], env: {} },
    { name: "no credits confirmation", args: ["--live"], env: {} },
    { name: "no live opt-in", args: ["--confirm-credits"], env: {} },
    { name: "read mixed with dispatch", args: ["--read", "--live", "--confirm-credits"], env: {} },
    { name: "no consent", env: { DIAL_TEST_CONSENT_TO: "" } },
    { name: "consent for different person", env: { DIAL_TEST_CONSENT_TO: "+14155550103" } },
    { name: "invalid phone", env: { DIAL_TEST_TO: "911", DIAL_TEST_CONSENT_TO: "911" } },
    { name: "missing key", env: { DIAL_API_KEY: "" } },
    { name: "malformed key", env: { DIAL_API_KEY: "synthetic invalid key" } },
    { name: "missing sender", env: { DIAL_FROM_NUMBER: "" } },
    { name: "relative artifact path", env: { DIAL_CLAIM_DEMO_ATTEMPT_FILE: "relative.json" } },
  ];
  for (const item of cases) await t.test(item.name, sub => {
    const setup = fixture(sub);
    const result = setup.run(item.args, item.env);
    assert.notEqual(result.status, 0);
    assert.equal(setup.requests().length, 0);
    assert.equal(existsSync(setup.attempt), false);
  });
});

test("repository and symlink-to-repository artifacts cannot trigger a dispatch", async t => {
  for (const symlink of [false, true]) await t.test(String(symlink), sub => {
    const setup = fixture(sub);
    const name = `synthetic-rejected-${randomUUID()}.json`;
    const link = join(setup.directory, "repo-link");
    if (symlink) symlinkSync(TEST_DIRECTORY, link, "dir");
    const path = join(symlink ? link : TEST_DIRECTORY, name);
    const result = setup.run(undefined, { DIAL_CLAIM_DEMO_ATTEMPT_FILE: path });
    assert.notEqual(result.status, 0);
    assert.equal(setup.requests().length, 0);
    assert.equal(existsSync(path), false);
  });
});

test("one accepted live request is reserved first, limited to 60 seconds and cannot be redialed", t => {
  const setup = fixture(t);
  const result = setup.run(undefined, {}, "accepted");
  assert.equal(result.status, 0, result.stderr);
  const requests = setup.requests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.reservedState, "dispatch_pending");
  assert.equal(requests[0]?.method, "POST");
  const body = JSON.parse(requests[0]!.body!);
  assert.equal(body.maxCallDurationSeconds, 60);
  assert.equal(body.to, PHONE);
  assert.match(body.outboundInstruction, /Request a refund only when the approved brief explicitly authorizes/);
  assert.match(body.outboundInstruction, /Ask only the questions authorized by the brief/);
  assert.doesNotMatch(body.outboundInstruction, /Conclude once you have a reference and next step/);
  assert.match(body.outboundInstruction, /I am an AI assistant calling for a fictional insurance claim demo/);
  assert.match(body.outboundInstruction, /Which missing document would you suggest/);
  assert.match(body.outboundInstruction, /No actual insurance claim, refund, policy, customer, or account exists/);
  assert.match(body.outboundInstruction, /Do not request any personal information, verify identity, file or submit anything/);
  assert.equal(setup.artifact().state, "accepted");
  assert.equal(statSync(setup.attempt).mode & 0o777, 0o600);
  assert.ok(!readFileSync(setup.attempt, "utf8").includes(KEY));
  const rerun = setup.run(undefined, {}, "accepted");
  assert.notEqual(rerun.status, 0);
  assert.equal(setup.requests().length, 1);
});

test("ambiguous dispatch is retained once and neither rerun nor --read can send another call", t => {
  const setup = fixture(t);
  assert.notEqual(setup.run(undefined, {}, "unknown").status, 0);
  assert.equal(setup.artifact().state, "dispatch_unknown");
  const saved = readFileSync(setup.attempt, "utf8");
  assert.notEqual(setup.run(undefined, {}, "accepted").status, 0);
  assert.notEqual(setup.run(["--read"], {}, "read-transcript").status, 0);
  assert.equal(setup.requests().length, 1);
  assert.equal(readFileSync(setup.attempt, "utf8"), saved);
});

test("safe reads collect late transcripts privately without requiring recipient dispatch variables", t => {
  const setup = fixture(t);
  assert.equal(setup.run(undefined, {}, "accepted").status, 0);
  const readEnv = { DIAL_TEST_TO: "", DIAL_TEST_CONSENT_TO: "", DIAL_FROM_NUMBER: "" };
  const initial = setup.run(["--read"], readEnv, "read-pending");
  assert.equal(initial.status, 0, initial.stderr);
  assert.equal(JSON.parse(initial.stdout).transcriptAvailable, false);
  assert.equal(setup.artifact().snapshot.transcript, null);
  const late = setup.run(["--read"], readEnv, "read-transcript");
  assert.equal(late.status, 0, late.stderr);
  assert.equal(JSON.parse(late.stdout).transcriptAvailable, true);
  assert.equal(setup.artifact().snapshot.transcript, TRANSCRIPT);
  assert.equal(setup.run(["--read"], readEnv, "read-pending").status, 0);
  assert.equal(setup.artifact().snapshot.transcript, TRANSCRIPT);
  assert.deepEqual(setup.requests().map(request => request.method), ["POST", "GET", "GET", "GET"]);
});

test("malformed read responses preserve the accepted artifact and never expose provider content", t => {
  const setup = fixture(t);
  assert.equal(setup.run(undefined, {}, "accepted").status, 0);
  const saved = readFileSync(setup.attempt, "utf8");
  assert.notEqual(setup.run(["--read"], {}, "malformed").status, 0);
  assert.equal(readFileSync(setup.attempt, "utf8"), saved);
  assert.deepEqual(setup.requests().map(request => request.method), ["POST", "GET"]);
});

test("--read refuses public-readable, symlinked and simulated artifacts before fetching", async t => {
  for (const scenario of ["public", "symlink", "simulated"]) await t.test(scenario, sub => {
    const setup = fixture(sub);
    assert.equal(setup.run(undefined, {}, "accepted").status, 0);
    let attempt = setup.attempt;
    if (scenario === "public") chmodSync(attempt, 0o644);
    if (scenario === "symlink") {
      attempt = join(setup.directory, "alias.json");
      symlinkSync(setup.attempt, attempt);
    }
    if (scenario === "simulated") {
      const artifact = setup.artifact();
      artifact.result.providerCallId = "sim_dial_" + "a".repeat(64);
      writeFileSync(attempt, JSON.stringify(artifact), { mode: 0o600 });
    }
    assert.notEqual(setup.run(["--read"], { DIAL_CLAIM_DEMO_ATTEMPT_FILE: attempt }, "read-transcript").status, 0);
    assert.equal(setup.requests().length, 1);
  });
});
