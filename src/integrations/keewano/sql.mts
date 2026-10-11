// Run one SQL statement against Keewano over MCP, or list its tools. Needs KEEWANO_ACCESS_TOKEN.
//   npm run keewano:sql -- --tools
//   npm run keewano:sql -- "SELECT count(DISTINCT user_id) AS users, count(*) AS events FROM events"
//   npm run keewano:sql -- --charges sam@example.com      (the exact query the duplicate check runs)
//   npm run keewano:sql -- --projects                     (projects this token can read)
//   npm run keewano:sql -- --tool list_event_types '{"nameFilter":"Charge"}'   (any tool; projectId filled in)
//   add --raw to print the untouched tool result when parsing fails.
import { buildChargesSql, chargesFromRows } from "./charges.ts";
import { customerEntityId } from "./events.ts";
import { DEFAULT_MCP_URL, KeewanoMcpClient, parseRows, projectIdFromApiKey, textOf } from "./mcp.ts";

const token = process.env.KEEWANO_ACCESS_TOKEN;
if (!token) throw new Error("Set KEEWANO_ACCESS_TOKEN (Keewano → Settings → Personal → Security).");

const args = process.argv.slice(2);
const raw = args.includes("--raw");
const rest = args.filter((a) => a !== "--raw");
const client = new KeewanoMcpClient({
  token,
  url: process.env.KEEWANO_MCP_URL ?? DEFAULT_MCP_URL,
  sqlTool: process.env.KEEWANO_SQL_TOOL ?? null,
  sqlArg: process.env.KEEWANO_SQL_ARG ?? null,
  projectId: process.env.KEEWANO_PROJECT_ID ?? projectIdFromApiKey(process.env.KEEWANO_API_KEY),
});

if (rest.length === 0 || rest[0] === "--tools") {
  console.log(JSON.stringify(await client.listTools(), null, 2));
} else if (rest[0] === "--projects") {
  console.log(JSON.stringify(await client.listProjects(), null, 2));
} else if (rest[0] === "--tool") {
  const name = rest[1];
  if (!name) throw new Error("--tool needs a tool name");
  const args = rest[2] ? (JSON.parse(rest[2]) as Record<string, unknown>) : {};
  const result = await client.callTool(name, args);
  if (raw) console.log(JSON.stringify(result, null, 2));
  else {
    const text = textOf(result);
    try {
      console.log(JSON.stringify(result.structuredContent ?? JSON.parse(text), null, 2));
    } catch {
      console.log(text);
    }
  }
} else if (rest[0] === "--charges") {
  const email = rest[1];
  if (!email) throw new Error("--charges needs a customer email");
  const entityId = customerEntityId({ email, name: null });
  const sql = buildChargesSql(entityId!);
  console.log(sql);
  const out = await client.runSqlRaw(sql);
  if (raw) console.log(JSON.stringify(out, null, 2));
  const rows = parseRows(out.result);
  console.log(`${rows.length} rows via ${out.tool}(${out.arg})`);
  console.log(JSON.stringify(chargesFromRows(rows), null, 2));
} else {
  const sql = rest.join(" ");
  const out = await client.runSqlRaw(sql);
  if (raw) console.log(JSON.stringify(out, null, 2));
  else console.log(JSON.stringify(parseRows(out.result), null, 2));
}
