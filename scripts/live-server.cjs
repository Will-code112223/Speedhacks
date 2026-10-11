// Load private Dial configuration without --env-file in execArgv: Next forwards
// those flags to NODE_OPTIONS, where Node rejects --env-file on worker startup.
const { loadEnvFile } = require("node:process");
const { join } = require("node:path");
const { homedir } = require("node:os");
try { loadEnvFile(join(homedir(), ".config", "speedhacks", "dial.env")); }
catch { console.error("Configure ~/.config/speedhacks/dial.env before starting live voice."); process.exit(1); }
const next = require.resolve("next/dist/bin/next");
process.argv = [process.execPath, next, ...process.argv.slice(2)];
require(next);
