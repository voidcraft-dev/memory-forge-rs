#!/usr/bin/env node
// Generate dummy Codex sessions for performance testing
// Usage: node scripts/gen-test-sessions.mjs [count]
//   Creates <count> fake .jsonl files in ~/.codex/sessions/test-perf/
//   Run with --clean to remove them

import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const count = parseInt(process.argv[2]) || 300;
const clean = process.argv.includes("--clean");
const testDir = join(homedir(), ".codex", "sessions", "test-perf");

if (clean) {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
    console.log(`Removed ${testDir}`);
  } else {
    console.log("Nothing to clean.");
  }
  process.exit(0);
}

mkdirSync(testDir, { recursive: true });

for (let i = 0; i < count; i++) {
  const id = `perf-test-${String(i).padStart(4, "0")}`;
  const ts = new Date(Date.now() - i * 60_000 * 30).toISOString();
  const lines = [
    JSON.stringify({ timestamp: ts, payload: { id, cwd: `C:/projects/test-${i}`, type: "session_start" } }),
    JSON.stringify({ timestamp: ts, payload: { type: "user_message", message: `This is test session ${i}. Lorem ipsum dolor sit amet.` } }),
    JSON.stringify({ timestamp: ts, payload: { type: "agent_message", message: `Response for session ${i}. The quick brown fox jumps over the lazy dog.` } }),
  ];
  writeFileSync(join(testDir, `${id}.jsonl`), lines.join("\n") + "\n");
}

console.log(`Created ${count} test sessions in ${testDir}`);
console.log(`Run with --clean to remove them.`);
