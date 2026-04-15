#!/usr/bin/env node
// Generate a single Codex session with 2000+ messages for detail-view perf testing
// Usage: node scripts/gen-test-detail.mjs [messageCount]
//   Creates one .jsonl file in ~/.codex/sessions/test-perf-detail/
//   Run with --clean to remove it

import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const msgCount = parseInt(process.argv[2]) || 2200;
const clean = process.argv.includes("--clean");
const testDir = join(homedir(), ".codex", "sessions", "test-perf-detail");

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

const id = "perf-detail-2k";
const baseTime = Date.now();
const lines = [];

// session_start
lines.push(JSON.stringify({
  timestamp: new Date(baseTime).toISOString(),
  payload: {
    id,
    cwd: "C:/projects/big-session-test",
    type: "session_start",
  },
}));

// alternating user/assistant messages
const loremUser = [
  "Can you help me refactor this authentication module?",
  "What's the best way to handle error boundaries in React?",
  "How do I optimize this SQL query for large datasets?",
  "Can you explain the difference between mutex and rwlock?",
  "Please review this code for security vulnerabilities.",
  "How should I structure the project directory?",
  "What testing strategy would you recommend here?",
  "Can you add pagination to this API endpoint?",
];

const loremAssistant = [
  "I'll help you refactor the authentication module. Here's my approach: First, we should separate the token validation logic from the session management. This gives us better testability and follows the single responsibility principle. Let me show you the implementation...",
  "For error boundaries in React, I recommend creating a reusable ErrorBoundary component that catches rendering errors. You can use componentDidCatch for logging and getDerivedStateFromError for fallback UI. Here's a production-ready pattern...",
  "To optimize this SQL query, we should add a composite index on (user_id, created_at), rewrite the subquery as a JOIN, and consider partitioning the table by date range. The EXPLAIN plan shows a full table scan which we can eliminate...",
  "Mutex provides exclusive access — only one thread can hold the lock at a time. RwLock allows multiple concurrent readers OR one exclusive writer. Use RwLock when reads vastly outnumber writes. For your case with frequent reads and rare updates, RwLock is the better choice...",
  "I found several issues in the code review: 1) SQL injection vulnerability in the search handler — use parameterized queries. 2) Missing CSRF token validation on the form submission endpoint. 3) The JWT secret is hardcoded — move it to environment variables...",
  "I recommend a feature-based directory structure: src/features/auth/, src/features/dashboard/, etc. Each feature contains its own components, hooks, and API layer. Shared utilities go in src/lib/. This scales well as the project grows...",
  "For this project, I'd recommend a testing pyramid: unit tests for pure logic (utils, reducers), integration tests for API endpoints with a test database, and a few E2E tests for critical user flows (login, checkout). Use vitest for speed...",
  "Here's the paginated endpoint implementation with cursor-based pagination. I'm using the created_at timestamp as the cursor since it's indexed and monotonically increasing. The response includes a next_cursor field for the client to request the next page...",
];

for (let i = 0; i < msgCount; i++) {
  const ts = new Date(baseTime + i * 15_000).toISOString(); // 15s apart
  const isUser = i % 2 === 0;

  if (isUser) {
    lines.push(JSON.stringify({
      timestamp: ts,
      payload: {
        type: "user_message",
        message: `[#${i + 1}] ${loremUser[i % loremUser.length]}`,
      },
    }));
  } else {
    lines.push(JSON.stringify({
      timestamp: ts,
      payload: {
        type: "agent_message",
        message: `[#${i + 1}] ${loremAssistant[i % loremAssistant.length]}`,
      },
    }));
  }
}

writeFileSync(join(testDir, `${id}.jsonl`), lines.join("\n") + "\n");

console.log(`Created 1 session with ${msgCount} messages in ${testDir}`);
console.log(`Session ID: ${id}`);
console.log(`Run with --clean to remove.`);
