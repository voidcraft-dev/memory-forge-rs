#!/usr/bin/env node
// Generate test Codex sessions at a custom path for testing custom platform paths
// Usage: node scripts/gen-testcodex.mjs [outputDir] [count]
//   Defaults: outputDir = F:/workspace/vk-study-v4/1001-mvp/testcodex, count = 10

import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";

const outputDir = process.argv[2] || "F:/workspace/vk-study-v4/1001-mvp/testcodex";
const count = parseInt(process.argv[3]) || 10;
const clean = process.argv.includes("--clean");
const sessionsDir = join(outputDir, "sessions");

if (clean) {
  if (existsSync(sessionsDir)) {
    rmSync(sessionsDir, { recursive: true });
    console.log(`Removed ${sessionsDir}`);
  } else {
    console.log("Nothing to clean.");
  }
  process.exit(0);
}

const projects = [
  "memory-forge-rs", "vk-study-v4", "my-portfolio", "api-server",
  "data-pipeline", "mobile-app", "cli-tool", "web-scraper",
  "ml-trainer", "chat-bot",
];

const userMessages = [
  "Help me refactor this authentication module to use JWT tokens instead of session cookies.",
  "Can you add error handling to this API endpoint? It crashes when the input is empty.",
  "What's the most efficient way to batch-process 10k records in Rust?",
  "Please write unit tests for the UserService class.",
  "How do I set up GitHub Actions CI for a Tauri v2 project?",
  "Debug this: the WebSocket connection drops after exactly 60 seconds.",
  "Implement a rate limiter middleware with a sliding window algorithm.",
  "Convert this Python script to Rust, keeping the same CLI interface.",
  "Add dark mode support to the settings page.",
  "Fix the memory leak in the session cache — it grows unbounded.",
];

const assistantMessages = [
  "I'll refactor the auth module to JWT. Here's the plan:\n1. Replace express-session with jsonwebtoken\n2. Add refresh token rotation\n3. Store tokens in httpOnly cookies\n\nLet me start with the token generation...",
  "The crash happens because `req.body.input` is undefined when no body is sent. I'll add validation using zod:\n\n```typescript\nconst schema = z.object({ input: z.string().min(1) });\n```\n\nThis returns a 400 with a clear error message instead of crashing.",
  "For batch processing 10k records in Rust, use `rayon` for CPU-bound work or `tokio` with semaphore for I/O-bound. Here's a pattern with chunked processing...",
  "Here are the unit tests for UserService. I'm covering:\n- createUser (happy path + duplicate email)\n- getUser (found + not found)\n- updateUser (partial update + validation error)\n- deleteUser (soft delete behavior)\n\nUsing mockall for the repository layer.",
  "For Tauri v2 + GitHub Actions CI, you need:\n1. A matrix build for Windows/macOS/Linux\n2. Install Rust toolchain + system deps\n3. Cache cargo registry + target dir\n4. Run `pnpm tauri build`\n\nHere's the complete workflow file...",
  "The 60-second drop is caused by a proxy timeout. Your nginx config has `proxy_read_timeout 60s` (default). Fix:\n```nginx\nproxy_read_timeout 3600s;\nproxy_send_timeout 3600s;\n```\nAlso add WebSocket ping/pong every 30s on the server side.",
  "Implementing a sliding window rate limiter. Using a sorted set in Redis:\n- Key: `rate:{ip}`\n- Score: timestamp in ms\n- On each request: ZREMRANGEBYSCORE to trim old entries, ZCARD to count, ZADD if under limit\n- TTL on the key = window size\n\nHere's the middleware...",
  "Converting the Python CLI to Rust using `clap` for argument parsing. Key differences:\n- `argparse` → `clap derive`\n- `requests` → `reqwest`\n- `json` → `serde_json`\n- `pathlib` → `std::path`\n\nThe interface stays identical.",
  "Adding dark mode to the settings page. I'll use CSS custom properties with a `data-theme` attribute on the root element. The toggle persists to localStorage and syncs with system preference via `prefers-color-scheme`.",
  "Found the memory leak: the session cache uses a HashMap but never evicts entries. Adding an LRU cache with a max size of 10,000 entries and a 30-minute TTL. Using the `moka` crate which handles concurrent access efficiently.",
];

mkdirSync(sessionsDir, { recursive: true });

for (let i = 0; i < count; i++) {
  const sessionId = `test-custom-${String(i).padStart(3, "0")}`;
  const sessionDir = join(sessionsDir, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  const baseTime = Date.now() - i * 60_000 * 60; // 1 hour apart
  const msgCount = 4 + Math.floor(Math.random() * 12); // 4-15 messages per session
  const lines = [];

  // session_start
  lines.push(JSON.stringify({
    timestamp: new Date(baseTime).toISOString(),
    payload: {
      id: sessionId,
      cwd: `C:/projects/${projects[i % projects.length]}`,
      type: "session_start",
    },
  }));

  // alternating messages
  for (let j = 0; j < msgCount; j++) {
    const ts = new Date(baseTime + (j + 1) * 30_000).toISOString();
    if (j % 2 === 0) {
      lines.push(JSON.stringify({
        timestamp: ts,
        payload: {
          type: "user_message",
          message: userMessages[(i + j) % userMessages.length],
        },
      }));
    } else {
      lines.push(JSON.stringify({
        timestamp: ts,
        payload: {
          type: "agent_message",
          message: assistantMessages[(i + j) % assistantMessages.length],
        },
      }));
    }
  }

  writeFileSync(join(sessionDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

console.log(`Created ${count} test Codex sessions in ${sessionsDir}`);
console.log(`Set Codex path to: ${outputDir}`);
console.log(`Run with --clean to remove.`);
