# Tool Call Export Analysis

Date: 2026-05-04

## Summary

Memory Forge currently exports Markdown from `SessionDetail.blocks` only. `TimelineBlock` is a normalized text-centric shape with `role`, `content`, `editable`, `editTarget`, and `sourceMeta`; it has no first-class structure for tool calls, tool input, tool output, status, timestamps, or execution IDs.

Because of that, tool call history is not reliably exported today. This is not an intentional product restriction in the code. It is an implementation gap caused by the current detail/export abstraction.

Recommended direction: add an opt-in export checkbox, `包含工具调用历史`, default off. The first version should include bounded, sanitized tool summaries in Markdown export only, without changing message editing or normal conversation display.

Implementation status:

- 2026-05-04: first pass implemented for Claude, Codex, and OpenCode.
- Kiro IDE, Kiro CLI, and Gemini CLI are intentionally not included in the first pass.
- Export remains opt-in and default off.

## Decision

Add it, but keep it export-only and default off.

This is a small-to-medium feature if the first version targets the platforms that already expose tool data in code. It becomes a large/risky feature if it tries to normalize every platform perfectly or exports raw execution JSON.

Recommended first target set:

| Platform | Add Now? | Confidence | Reason |
| --- | --- | --- | --- |
| Claude | Yes | High | Raw `tool_use` and `tool_result` are already parsed by search. |
| OpenCode | Yes | High | SQLite `tool` parts are already handled by search/update paths. |
| Codex | Yes | Medium-High | Raw `function_call` and `function_call_output` are already recognized by search. |
| Kiro IDE | Yes, summarized only | Medium | Execution logs exist and are rich, but can be large/nested. |
| Kiro CLI | Not in first pass | Low | Current adapter does not show a stable tool-call schema. |
| Gemini CLI | Not in first pass | Low | Current adapter exposes messages/thoughts, not obvious tool calls. |

Bug risk:

- Low if the option only affects Markdown export and is off by default.
- Medium if platform parsers attach tool calls to nearby messages incorrectly.
- High if raw JSON/logs are exported without truncation, because that can create huge files, freeze the UI, or leak local secrets.

## Current Export Path

Frontend export lives in `src/features/session/session-detail.tsx`.

`handleExportMarkdown` builds Markdown by iterating:

```ts
for (const block of sessionDetail.blocks) {
  const roleLabel = block.role === 'user' ? 'User' : block.role === 'assistant' ? 'Assistant' : 'Thinking'
  lines.push(`## ${roleLabel}`)
  lines.push(block.content)
}
```

So export can only include what is already present in `sessionDetail.blocks`.

Backend `TimelineBlock` lives in `src-tauri/src/platforms/mod.rs`:

```rust
pub struct TimelineBlock {
    pub id: String,
    pub role: String,
    pub content: String,
    pub editable: bool,
    pub edit_target: String,
    pub source_meta: serde_json::Value,
}
```

There is no tool-specific field. `sourceMeta` carries parser metadata, but the frontend exporter does not use it.

## Platform Analysis

### Claude

Files:

- `src-tauri/src/platforms/claude.rs`

Raw data support:

- Claude messages can contain array content items.
- The current search logic explicitly recognizes `tool_use` and `tool_result`.
- So tool data exists in raw session JSONL and is already partially understood by the code.

Current detail/export behavior:

- `blocks()` only emits:
  - user text
  - assistant text
  - assistant thinking/reasoning
- `tool_use` and `tool_result` are ignored by `_ => {}`.

Conclusion:

- Claude is a good first target.
- Tool call export is straightforward: collect `tool_use.name`, `tool_use.input`, `tool_result.content`, and attach them to nearby assistant/user blocks or export them as separate non-editable tool sections.

Risk:

- Tool results can contain large file contents, command output, secrets, or copied source.

### Codex

Files:

- `src-tauri/src/platforms/codex.rs`

Raw data support:

- Search logic recognizes `function_call` and `function_call_output`.
- It searches `name`, `arguments`, and `output`.
- So Codex raw logs can contain tool/function data, and the code already knows some likely field names.

Current detail/export behavior:

- `blocks()` only emits:
  - `user_message`
  - `agent_message`
- Other payload types, including `function_call` and `function_call_output`, are ignored.

Conclusion:

- Codex support is feasible.
- Export can include function/tool name, arguments, output, and ordering based on the JSONL line order.

Risk:

- Function output may include local paths, command output, diffs, and file snippets.

### OpenCode

Files:

- `src-tauri/src/platforms/opencode.rs`

Raw data support:

- OpenCode stores parts in SQLite.
- `update_message()` has explicit support for `type == "tool"` and updates `state.output`.
- `content_search()` also searches tool `name`, `state.input`, and `state.output`.
- So tool data is definitely present and already used in search/edit internals.

Current detail/export behavior:

- `get_session_detail()` selects all parts from the database.
- `part_to_block()` only emits:
  - `text`
  - `reasoning`
- `tool` parts return `None`, so they are absent from detail/export.

Conclusion:

- OpenCode is also a good first target.
- Since tool parts are already in the same ordered query as text/reasoning parts, adding export-only tool sections should be low risk.

Risk:

- Tool parts may be editable today through `update_message()` if addressed directly, but they are not surfaced in detail. Export support should not make them normal editable conversation blocks by accident.

### Kiro CLI

Files:

- `src-tauri/src/platforms/kiro.rs`

Raw data support:

- The current adapter reads JSONL lines and emits only `Prompt` and `AssistantMessage`.
- `extract_content_text()` and `clean_hook_context()` focus on conversational text and hook cleanup.
- There is no visible parser path for structured tool calls in the current adapter.

Current detail/export behavior:

- Only user prompts and assistant messages are included.
- Unknown `kind` values are skipped.

Conclusion:

- Kiro CLI support needs sample raw logs before implementing confidently.
- It should be treated as unknown/limited until raw tool event shapes are confirmed.

Risk:

- Guessing field names here would likely create fragile behavior.

### Kiro IDE

Files:

- `src-tauri/src/platforms/kiro_ide.rs`

Raw data support:

- Kiro IDE has rich execution logs under workspace hash folders.
- Tool/execution history appears in:
  - `actions`
  - `context.messages`
  - `input.data.messagesFromExecutionId`
- The current implementation now uses those logs to resolve assistant `On it.` placeholders into real assistant output.

Current detail/export behavior:

- Session detail still emits only user/assistant text blocks from workspace session history.
- Execution logs are used as a lookup source for assistant output, not exported as tool history.
- Tool actions like `runCommand`, `taskStatus`, `specAgent`, model actions, and display errors are not represented as exportable tool sections.

Conclusion:

- Kiro IDE has the richest tool/execution history, but it is the riskiest platform because logs can be large and nested.
- First implementation should export a summarized action list, not raw full logs.

Suggested fields:

- `actionType`
- `actionState`
- `actionId`
- `executionId`
- `subExecutionId`
- command/name if present
- bounded output/error
- emitted/end timestamps if present

Risk:

- Large logs can freeze UI if loaded synchronously.
- Kiro action outputs can include command output, file contents, local paths, and internal execution metadata.
- Must keep this behind explicit opt-in and bounded output length.

### Gemini CLI

Files:

- `src-tauri/src/platforms/gemini.rs`

Raw data support:

- Current adapter models messages and thoughts.
- Detail emits user, assistant, and thinking blocks.
- No obvious tool call parser appears in the current detail path.

Current detail/export behavior:

- Exports only normalized conversation and thoughts.

Conclusion:

- Gemini support should be deferred until sample raw tool-call sessions are inspected.

Risk:

- Unknown raw shape; implementing without samples would be speculative.

## Proposed Data Model

Add an optional field to `TimelineBlock`:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallBlock {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub status: String,
    pub input: Option<String>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub source_meta: serde_json::Value,
}
```

Then:

```rust
pub struct TimelineBlock {
    ...
    #[serde(default)]
    pub tool_calls: Vec<ToolCallBlock>,
}
```

Alternative: create separate `role: "tool"` timeline blocks. This is simpler for export, but riskier because it affects detail rendering, search navigation, edit behavior, and message counts. Prefer `tool_calls` first.

## Export UI Proposal

In the export flow:

- Add a checkbox or toggle: `包含工具调用历史`
- Default: off
- When on, Markdown includes tool sections below the related message:

~~~md
### Tool Call

- Type: runCommand
- Name: npm test
- Status: Success
- Execution ID: ...

Input:
```json
...
```

Output:
```text
...
```
~~~

Use truncation:

- input max: 8 KiB
- output max: 16-32 KiB
- mark truncation explicitly

## Security And Privacy

Tool exports must be opt-in because tool history can include:

- local absolute paths
- command output
- environment variables
- file contents
- diffs
- terminal output
- API errors
- potentially secrets/tokens if tools printed them

Do not include raw JSON by default. Prefer summarized fields with bounded input/output.

## Implementation Plan

Phase 1: export-only support

1. Add `ToolCallBlock` and optional `toolCalls` to `TimelineBlock`.
2. Keep UI display unchanged except export option.
3. Add export checkbox state in `SessionDetail`.
4. Update Markdown exporter to include tool calls only when enabled.
5. Add truncation helper in frontend export path.

Phase 2: platform adapters

1. Claude: parse `tool_use` and `tool_result`.
2. OpenCode: parse `type == "tool"` parts.
3. Codex: parse `function_call` and `function_call_output`.
4. Kiro IDE: parse execution `actions` into summarized tool calls.
5. Kiro CLI/Gemini: defer until raw samples confirm schema.

Phase 3: tests

1. Backend parser unit tests per supported platform.
2. Frontend export unit/snapshot test for with/without tool history.
3. Manual test with large Kiro IDE logs to verify UI remains responsive.

## Estimated Risk

Low risk if export-only and default off.

Medium risk if tool calls are inserted as normal timeline blocks.

High risk if raw JSON is exported without truncation/sanitization.

## Recommended Reply To User Feedback

Suggested public response:

> 不是故意设计成不能导出工具调用历史，是当前导出实现还没覆盖这部分。现在 Markdown 导出只基于标准化后的对话文本块，所以工具调用、工具结果和执行动作没有完整进入导出内容。我们会加一个默认关闭的“包含工具调用历史”选项；开启后导出工具名称、输入、输出、状态和时间等摘要，并对长输出做截断，避免导出文件过大或泄露敏感信息。
