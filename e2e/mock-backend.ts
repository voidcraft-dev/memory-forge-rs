import type { Page } from "@playwright/test";

const NOW = Date.UTC(2026, 10, 22, 8, 0, 0);

type MockSession = {
  platform: string;
  sessionKey: string;
  sessionId: string;
  displayTitle: string;
  aliasTitle: string;
  preview: string;
  updatedAt: string;
  cwd: string;
  editable: boolean;
  favorite: boolean;
};

type MockBlock = {
  id: string;
  role: "user" | "assistant" | "thinking";
  content: string;
  editable: boolean;
  editTarget: string;
  sourceMeta: Record<string, unknown>;
  createdAt: string;
  toolCalls?: unknown[];
};

type MockDetail = {
  platform: string;
  sessionKey: string;
  sessionId: string;
  title: string;
  aliasTitle: string;
  cwd: string;
  commands: Record<string, string>;
  blocks: MockBlock[];
};

export type MockSeed = {
  snapshot: Record<string, unknown>;
  sessions: Record<string, MockSession[]>;
  details: Record<string, MockDetail>;
  dashboard: Record<string, unknown>;
  prompts: unknown[];
  detailDelayMs: Record<string, number>;
};

export type MockCall = { cmd: string; args: Record<string, unknown> };

function session(
  platform: string,
  key: string,
  order: number,
  cwd: string,
  title: string
): MockSession {
  return {
    platform,
    sessionKey: key,
    sessionId: key,
    displayTitle: title,
    aliasTitle: "",
    preview: title,
    updatedAt: String(Math.round(NOW - order * 60_000)),
    cwd,
    editable: true,
    favorite: false,
  };
}

function block(
  sessionKey: string,
  index: number,
  role: MockBlock["role"],
  content: string,
  extra: Partial<MockBlock> = {}
): MockBlock {
  return {
    id: `${sessionKey}-b${index}`,
    role,
    content,
    editable: true,
    editTarget: `${sessionKey}::${index}`,
    sourceMeta: {},
    createdAt: String(NOW - (10_000 - index) * 1000),
    ...extra,
  };
}

function detailFor(s: MockSession, blocks: MockBlock[]): MockDetail {
  return {
    platform: s.platform,
    sessionKey: s.sessionKey,
    sessionId: s.sessionId,
    title: s.displayTitle,
    aliasTitle: "",
    cwd: s.cwd,
    commands: { resume: `${s.platform} --resume ${s.sessionKey}` },
    blocks,
  };
}

function smallBlocks(s: MockSession): MockBlock[] {
  return [
    block(s.sessionKey, 0, "user", `Question for ${s.displayTitle}`),
    block(s.sessionKey, 1, "assistant", `Answer for ${s.displayTitle}`),
    block(s.sessionKey, 2, "user", `Follow-up for ${s.displayTitle}`),
  ];
}

function longBlocks(s: MockSession, count: number): MockBlock[] {
  const blocks: MockBlock[] = [
    block(s.sessionKey, 0, "thinking", "Deep thinking text about the plan"),
    block(s.sessionKey, 1, "assistant", "", {
      toolCalls: [
        {
          id: "tc-1",
          name: "Edit",
          kind: "edit",
          status: "completed",
          input: JSON.stringify({
            file_path: "src/app.ts",
            old_string: "const oldValue = 1;",
            new_string: "const newValue = 2;",
          }),
          output: "ok",
          sourceMeta: {},
        },
      ],
    }),
  ];
  for (let i = 2; i < count; i++) {
    blocks.push(
      block(
        s.sessionKey,
        i,
        i % 2 === 0 ? "user" : "assistant",
        `Message number ${i} in ${s.displayTitle}. `.repeat(4)
      )
    );
  }
  return blocks;
}

export function buildSeed(overrides: Partial<MockSeed> = {}): MockSeed {
  const claude = Array.from({ length: 8 }, (_, i) =>
    session("claude", `claude-${i}`, i, "F:/work/alpha", `Claude task ${i}`)
  );
  const codex = Array.from({ length: 70 }, (_, i) =>
    session("codex", `codex-${i}`, i + 0.5, "F:/work/beta", `Codex job ${i}`)
  );
  const details: Record<string, MockDetail> = {};
  for (const s of [...claude, ...codex]) {
    details[`${s.platform}::${s.sessionKey}`] = detailFor(s, smallBlocks(s));
  }
  details["claude::claude-0"] = detailFor(claude[0], longBlocks(claude[0], 240));

  const settings = {
    theme: "chrono",
    locale: "en",
    closeToTrayOnClose: true,
    launchOnStartup: false,
    reduceMotion: true,
    claudeHome: null,
    codexHome: null,
    codexProjectRoot: null,
    cursorHome: null,
    opencodePath: null,
    kiroHome: null,
    kiroIdeHome: null,
    geminiHome: null,
    grokHome: null,
    piHome: null,
    zcodeHome: null,
    workbuddyHome: null,
    cindyHome: null,
    cindyGlobalHome: null,
    zedHome: null,
    dshHome: null,
    qoderCnHome: null,
    qwenHome: null,
    clineHome: null,
    antigravityHome: null,
    codebuddyHome: null,
    devinHome: null,
    preferredTerminal: null,
    visiblePlatforms: ["claude", "codex"],
    navigationItems: ["claude", "codex"],
  };

  return {
    snapshot: {
      appName: "Memory Forge",
      version: "3.9.0-e2e",
      runtime: "tauri",
      configDir: "C:/mock/config",
      configFile: "C:/mock/config/settings.json",
      dataDir: "C:/mock/data",
      dbPath: "C:/mock/data/memory-forge.db",
      trayAvailable: true,
      autostartSupported: false,
      backupWritePlatforms: ["claude"],
      settings,
    },
    sessions: { claude, codex },
    details,
    dashboard: {
      platforms: [
        { platform: "claude", count: claude.length, items: claude },
        { platform: "codex", count: codex.length, items: codex.slice(0, 20) },
      ],
      trend: [],
      recentSessions: [...claude.slice(0, 3), ...codex.slice(0, 3)],
    },
    prompts: [
      {
        id: 1,
        name: "Review checklist",
        content: "Review the diff carefully.",
        tags: "review",
        useCount: 2,
        createdAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
      },
    ],
    detailDelayMs: {},
    ...overrides,
  };
}

function mockBackendScript(seed: MockSeed) {
  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  const store = {
    ...clone(seed),
    archived: {} as Record<string, boolean>,
    favorites: {} as Record<string, boolean>,
    editLogs: {} as Record<string, Array<Record<string, unknown>>>,
    failNextEdit: false,
  };
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  let nextLogId = 1;
  const keyOf = (platform: unknown, sessionKey: unknown) => `${platform}::${sessionKey}`;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const findBlock = (args: Record<string, unknown>, editTarget: unknown) => {
    const detail = store.details[keyOf(args.platform, args.sessionKey)];
    const target = detail?.blocks.find((b) => b.editTarget === editTarget);
    if (!target) throw new Error(`message ${String(editTarget)} not found`);
    return target;
  };

  const pushLog = (args: Record<string, unknown>, editTarget: string, oldContent: string, newContent: string) => {
    const key = keyOf(args.platform, args.sessionKey);
    store.editLogs[key] = [
      {
        id: nextLogId++,
        editTarget,
        oldContent,
        newContent,
        createdAt: new Date().toISOString(),
      },
      ...(store.editLogs[key] ?? []),
    ];
  };

  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    app_bootstrap: () => store.snapshot,
    app_settings_set: (args) => {
      const settings = store.snapshot.settings as Record<string, unknown>;
      store.snapshot = {
        ...store.snapshot,
        settings: { ...settings, ...(args.patch as Record<string, unknown>) },
      };
      return store.snapshot;
    },
    check_update: () => ({
      hasUpdate: false,
      currentVersion: store.snapshot.version,
      latestVersion: store.snapshot.version,
      releaseUrl: "",
      releaseNotes: "",
      publishedAt: "",
    }),
    dashboard_summary: () => store.dashboard,
    list_editor_targets: () => [],
    session_list: (args) => {
      const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
      const list = (store.sessions[String(args.platform)] ?? [])
        .filter((s) => Boolean(store.archived[keyOf(s.platform, s.sessionKey)]) === Boolean(args.showArchived))
        .filter((s) => !query || `${s.displayTitle} ${s.preview}`.toLowerCase().includes(query));
      const offset = Number(args.offset ?? 0);
      const limit = Number(args.limit ?? 60);
      return {
        total: list.length,
        items: list.slice(offset, offset + limit).map((s) => ({
          ...s,
          favorite: Boolean(store.favorites[keyOf(s.platform, s.sessionKey)]),
        })),
        searchIndex: { supported: false, running: false, indexed: 0, total: 0 },
      };
    },
    session_detail: async (args) => {
      const key = keyOf(args.platform, args.sessionKey);
      const delay = store.detailDelayMs[key];
      if (delay) await wait(delay);
      const detail = store.details[key];
      if (!detail) throw new Error(`session ${key} not found`);
      return clone(detail);
    },
    session_edit_log: (args) => clone(store.editLogs[keyOf(args.platform, args.sessionKey)] ?? []),
    session_edit_message: (args) => {
      if (store.failNextEdit) {
        store.failNextEdit = false;
        throw new Error("This message changed on disk after it was loaded. Reload the session and try again.");
      }
      const target = findBlock(args, args.messageId);
      const oldContent = target.content;
      target.content = String(args.content);
      pushLog(args, target.editTarget, oldContent, target.content);
      return null;
    },
    session_erase_messages: (args) => {
      const targets = args.targets as Array<{ editTarget: string }>;
      for (const item of targets) {
        const target = findBlock(args, item.editTarget);
        pushLog(args, target.editTarget, target.content, "");
        target.content = "";
      }
      return { erased: targets.length, total: targets.length, error: null };
    },
    session_restore_message: (args) => {
      const logs = store.editLogs[keyOf(args.platform, args.sessionKey)] ?? [];
      const entry = logs.find((log) => log.id === args.editLogId);
      if (!entry) throw new Error("edit log not found");
      const target = findBlock(args, entry.editTarget);
      pushLog(args, target.editTarget, target.content, String(entry.oldContent));
      target.content = String(entry.oldContent);
      return null;
    },
    session_toggle_flag: (args) => {
      const key = keyOf(args.platform, args.sessionKey);
      const bucket = args.flag === "archived" ? store.archived : store.favorites;
      bucket[key] = !bucket[key];
      return bucket[key];
    },
    session_set_alias: (args) => {
      const detail = store.details[keyOf(args.platform, args.sessionKey)];
      if (detail) detail.aliasTitle = String(args.title ?? "");
      return { platform: args.platform, sessionKey: args.sessionKey, title: args.title };
    },
    prompt_list: () => clone(store.prompts),
    launch_session_terminal: () => {
      throw new Error("no external terminal in tests");
    },
  };

  (window as unknown as Record<string, unknown>).__mock = { calls, store };
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      calls.push({ cmd, args: clone(args ?? {}) });
      const handler = handlers[cmd];
      return handler ? handler(args ?? {}) : null;
    },
    transformCallback: () => 0,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
    convertFileSrc: (path: string) => path,
  };
}

export async function installMockBackend(page: Page, seed: MockSeed = buildSeed()) {
  await page.addInitScript(mockBackendScript, seed);
}

export function mockCalls(page: Page, cmd?: string): Promise<MockCall[]> {
  return page.evaluate((name) => {
    const all = (window as unknown as { __mock: { calls: MockCall[] } }).__mock.calls;
    return name ? all.filter((call) => call.cmd === name) : all;
  }, cmd);
}

export function setMockFlag(page: Page, flag: "failNextEdit", value: boolean) {
  return page.evaluate(
    ([name, next]) => {
      const store = (window as unknown as { __mock: { store: Record<string, unknown> } }).__mock.store;
      store[name as string] = next;
    },
    [flag, value] as const
  );
}
