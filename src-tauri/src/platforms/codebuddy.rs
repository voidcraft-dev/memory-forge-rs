use std::collections::HashMap;
use std::path::PathBuf;

use crate::database::{SessionContentIndex, SessionSummaryCache};

use super::{
    build_commands, claude::ClaudeDialect, claude::ClaudePlatform, ContentMatch, PlatformAdapter,
    SessionDetail, SessionKey, SessionListItem, SessionListResult, TimelineBlock,
};

/// CodeBuddy Code (Tencent) stores sessions as JSONL under
/// `<home>/projects/<encoded-cwd>/<session-id>.jsonl`. The container is close
/// enough to Claude Code that [`ClaudePlatform`] can parse it after a small
/// per-line normalization (see `ClaudeDialect::CodeBuddy`); this adapter only
/// rebrands the platform and derives a readable title from the first prompt.
pub struct CodeBuddyPlatform {
    inner: ClaudePlatform,
}

impl CodeBuddyPlatform {
    pub fn new(home: PathBuf) -> Self {
        Self {
            inner: ClaudePlatform::with_dialect(home, ClaudeDialect::CodeBuddy),
        }
    }

    fn title_from_preview(preview: &str, fallback: &str) -> String {
        let first_line = preview.lines().next().unwrap_or_default().trim();
        if first_line.is_empty() {
            fallback.to_string()
        } else {
            first_line.chars().take(60).collect()
        }
    }

    fn remap_item(&self, item: &mut SessionListItem) {
        item.platform = "codebuddy".to_string();
        if item.alias_title.is_empty() {
            item.display_title = Self::title_from_preview(&item.preview, &item.session_id);
        }
    }

    fn remap_list(&self, mut result: SessionListResult) -> SessionListResult {
        for item in &mut result.items {
            self.remap_item(item);
        }
        result
    }
}

fn is_command_noise(block: &TimelineBlock) -> bool {
    if block.role != "user" {
        return false;
    }
    let text = block.content.trim_start();
    text.starts_with("<system-reminder")
        || text.starts_with("<command-name>")
        || text.starts_with("<local-command-stdout>")
}

impl PlatformAdapter for CodeBuddyPlatform {
    fn list_sessions(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
    ) -> SessionListResult {
        self.remap_list(self.inner.list_sessions(alias_map, limit, offset))
    }

    fn list_sessions_with_cache(
        &self,
        alias_map: &HashMap<String, String>,
        limit: Option<usize>,
        offset: usize,
        cache: Option<&SessionSummaryCache<'_>>,
    ) -> SessionListResult {
        self.remap_list(
            self.inner
                .list_sessions_with_cache(alias_map, limit, offset, cache),
        )
    }

    fn list_session_keys(&self) -> Option<Vec<SessionKey>> {
        self.inner.list_session_keys()
    }

    fn session_list_item(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
        cache: Option<&SessionSummaryCache<'_>>,
    ) -> Option<SessionListItem> {
        self.inner
            .session_list_item(session_key, alias_map, cache)
            .map(|mut item| {
                self.remap_item(&mut item);
                item
            })
    }

    fn get_session_detail(
        &self,
        session_key: &str,
        alias_map: &HashMap<String, String>,
    ) -> Result<SessionDetail, String> {
        let mut detail = self.inner.get_session_detail(session_key, alias_map)?;
        detail.platform = "codebuddy".to_string();
        detail.commands = build_commands("codebuddy", session_key);
        // CodeBuddy stores slash-command echoes and injected reminders as
        // standalone user messages; hide them from the timeline.
        detail.blocks.retain(|block| !is_command_noise(block));
        if detail.alias_title.is_empty() {
            let first_user = detail
                .blocks
                .iter()
                .find(|block| block.role == "user" && !block.content.trim().is_empty())
                .map(|block| block.content.as_str())
                .unwrap_or_default();
            detail.title = Self::title_from_preview(first_user, &detail.session_id);
        }
        Ok(detail)
    }

    fn update_message(&self, edit_target: &str, new_content: &str) -> Result<String, String> {
        self.inner.update_message(edit_target, new_content)
    }

    fn matches_query(&self, session_key: &str, query: &str) -> bool {
        self.inner.matches_query(session_key, query)
    }

    fn warm_content_index(
        &self,
        session_key: &str,
        index: Option<&SessionContentIndex<'_>>,
    ) -> bool {
        self.inner.warm_content_index(session_key, index)
    }

    fn has_current_content_index(
        &self,
        session_key: &str,
        index: Option<&SessionContentIndex<'_>>,
    ) -> bool {
        self.inner.has_current_content_index(session_key, index)
    }

    fn content_search(&self, session_key: &str, query: &str) -> Vec<ContentMatch> {
        self.inner.content_search(session_key, query)
    }

    fn content_search_with_index(
        &self,
        session_key: &str,
        query: &str,
        index: Option<&SessionContentIndex<'_>>,
    ) -> Vec<ContentMatch> {
        self.inner
            .content_search_with_index(session_key, query, index)
    }

    fn resolve_execution_output(
        &self,
        session_key: &str,
        edit_target: &str,
    ) -> Result<String, String> {
        self.inner
            .resolve_execution_output(session_key, edit_target)
    }

    fn resolve_execution_outputs(
        &self,
        session_key: &str,
        edit_targets: &[String],
    ) -> Result<HashMap<String, String>, String> {
        self.inner
            .resolve_execution_outputs(session_key, edit_targets)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platforms::PlatformAdapter;
    use serde_json::json;
    use std::fs;
    use uuid::Uuid;

    fn test_home(label: &str) -> PathBuf {
        let base = std::env::var_os("MEMORY_FORGE_TEST_TMP")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let home = base.join(format!("codebuddy-{label}-{}", Uuid::new_v4()));
        let dir = home.join("projects").join("e-workspace-20260402-vk-work");
        fs::create_dir_all(&dir).expect("create project dir");

        let lines = vec![
            json!({"type":"session-meta","id":"meta-1","sessionId":"session-1","timestamp":1794452471937i64}),
            json!({"type":"message","id":"user-1","timestamp":1794452471679i64,"role":"user",
                "content":[{"type":"input_text","text":"帮我看看这个项目"}],
                "sessionId":"session-1","cwd":"E:\\workspace\\20260402\\vk-work"}),
            json!({"type":"reasoning","id":"reason-1","timestamp":1794452478231i64,
                "content":[],
                "rawContent":[{"type":"reasoning_text","text":"先读文件"}],
                "sessionId":"session-1","cwd":"E:\\workspace\\20260402\\vk-work"}),
            json!({"type":"message","id":"assistant-1","timestamp":1794452478265i64,
                "role":"assistant",
                "content":[
                    {"type":"output_text","text":"好的，我先看看。"},
                    {"type":"tool_use","id":"call-1","name":"Read","input":{"file_path":"a.md"}}
                ],
                "sessionId":"session-1","cwd":"E:\\workspace\\20260402\\vk-work"}),
            json!({"type":"message","id":"user-2","timestamp":1794452478300i64,"role":"user",
                "content":[{"type":"tool_result","tool_use_id":"call-1","content":"file body"}],
                "sessionId":"session-1","cwd":"E:\\workspace\\20260402\\vk-work"}),
            json!({"type":"message","id":"user-3","timestamp":1794452478400i64,"role":"user",
                "content":[{"type":"input_text","text":"<system-reminder data-role=\"command-caveat\">Caveat: local commands</system-reminder>"}],
                "sessionId":"session-1","cwd":"E:\\workspace\\20260402\\vk-work"}),
        ];
        let mut text = String::new();
        for line in lines {
            text.push_str(&serde_json::to_string(&line).unwrap());
            text.push('\n');
        }
        fs::write(dir.join("session-1.jsonl"), text).expect("write session");
        home
    }

    #[test]
    fn lists_and_parses_codebuddy_sessions() {
        let home = test_home("list");
        let platform = CodeBuddyPlatform::new(home.clone());

        let listed = platform.list_sessions(&HashMap::new(), None, 0);
        assert_eq!(listed.total, 1);
        assert_eq!(listed.items[0].platform, "codebuddy");
        assert_eq!(listed.items[0].display_title, "帮我看看这个项目");
        assert_eq!(listed.items[0].cwd, "E:\\workspace\\20260402\\vk-work");

        let detail = platform
            .get_session_detail(&listed.items[0].session_key, &HashMap::new())
            .expect("detail");
        assert_eq!(detail.platform, "codebuddy");
        assert_eq!(detail.title, "帮我看看这个项目");
        assert_eq!(detail.blocks[0].role, "user");
        assert_eq!(detail.blocks[0].content, "帮我看看这个项目");
        assert_eq!(detail.blocks[1].role, "thinking");
        assert_eq!(detail.blocks[1].content, "先读文件");
        assert_eq!(detail.blocks[2].role, "assistant");
        assert_eq!(detail.blocks[2].tool_calls.len(), 1);
        assert_eq!(
            detail.blocks[2].tool_calls[0].output.as_deref(),
            Some("file body")
        );
        assert_eq!(detail.blocks.len(), 3);

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn edits_codebuddy_messages_in_place() {
        let home = test_home("edit");
        let platform = CodeBuddyPlatform::new(home.clone());
        let listed = platform.list_sessions(&HashMap::new(), None, 0);
        let detail = platform
            .get_session_detail(&listed.items[0].session_key, &HashMap::new())
            .expect("detail");

        let user_target = detail.blocks[0].edit_target.clone();
        let old = platform
            .update_message(&user_target, "换个问题")
            .expect("update user");
        assert_eq!(old, "帮我看看这个项目");

        let thinking_target = detail.blocks[1].edit_target.clone();
        let old = platform
            .update_message(&thinking_target, "先读 README")
            .expect("update thinking");
        assert_eq!(old, "先读文件");

        // The file must keep its CodeBuddy shape after the edit.
        let raw = fs::read_to_string(
            home.join("projects")
                .join("e-workspace-20260402-vk-work")
                .join("session-1.jsonl"),
        )
        .expect("read session");
        assert!(raw.contains("\"input_text\""));
        assert!(raw.contains("\"rawContent\""));
        assert!(!raw.contains("\"type\":\"user\""));

        let detail = platform
            .get_session_detail(&listed.items[0].session_key, &HashMap::new())
            .expect("reread");
        assert!(detail
            .blocks
            .iter()
            .any(|block| block.content == "换个问题"));
        assert!(detail
            .blocks
            .iter()
            .any(|block| block.content == "先读 README"));

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn searches_codebuddy_sessions() {
        let home = test_home("search");
        let platform = CodeBuddyPlatform::new(home.clone());
        let key = platform.list_sessions(&HashMap::new(), None, 0).items[0]
            .session_key
            .clone();

        assert!(platform.matches_query(&key, "项目"));
        assert!(platform.matches_query(&key, "file body"));
        assert!(!platform.matches_query(&key, "不存在的词"));
        assert!(platform.content_search(&key, "不存在的词").is_empty());

        fs::remove_dir_all(&home).ok();
    }
}
