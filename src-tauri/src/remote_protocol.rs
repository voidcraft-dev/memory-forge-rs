use serde::{Deserialize, Serialize};

pub const REMOTE_PROTOCOL_VERSION: u16 = 1;
pub const REMOTE_API_PREFIX: &str = "/api/v1";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCapabilities {
    pub session_snapshots: bool,
    pub session_search: bool,
    pub audit_log: bool,
    pub session_edit: bool,
    pub terminal: bool,
    pub realtime_events: bool,
}

impl RemoteCapabilities {
    pub fn read_only() -> Self {
        Self {
            session_snapshots: true,
            session_search: true,
            audit_log: true,
            session_edit: false,
            terminal: false,
            realtime_events: false,
        }
    }

    pub fn read_write() -> Self {
        Self {
            session_edit: true,
            ..Self::read_only()
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAuthInfo {
    pub required: bool,
    pub pairing_supported: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemotePlatformInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBootstrap {
    pub protocol_version: u16,
    pub server_id: String,
    pub server_name: String,
    pub server_version: String,
    pub server_time: String,
    pub capabilities: RemoteCapabilities,
    pub auth: RemoteAuthInfo,
    pub platforms: Vec<RemotePlatformInfo>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApiSuccess<T> {
    pub protocol_version: u16,
    pub request_id: String,
    pub data: T,
}

impl<T> ApiSuccess<T> {
    pub fn new(request_id: String, data: T) -> Self {
        Self {
            protocol_version: REMOTE_PROTOCOL_VERSION,
            request_id,
            data,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorDetail {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub protocol_version: u16,
    pub request_id: String,
    pub error: ApiErrorDetail,
}

impl ApiError {
    pub fn new(
        request_id: String,
        code: impl Into<String>,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            protocol_version: REMOTE_PROTOCOL_VERSION,
            request_id,
            error: ApiErrorDetail {
                code: code.into(),
                message: message.into(),
                retryable,
                current_revision: None,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditMessageMutation {
    pub device_id: String,
    pub mutation_id: String,
    pub platform: String,
    pub session_key: String,
    pub message_id: String,
    pub content: String,
    pub expected_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreMessageMutation {
    pub device_id: String,
    pub mutation_id: String,
    pub platform: String,
    pub session_key: String,
    pub edit_log_id: i64,
    pub expected_revision: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_capabilities_do_not_advertise_mutations_or_streams() {
        let capabilities = RemoteCapabilities::read_only();
        assert!(capabilities.session_snapshots);
        assert!(capabilities.session_search);
        assert!(capabilities.audit_log);
        assert!(!capabilities.session_edit);
        assert!(!capabilities.terminal);
        assert!(!capabilities.realtime_events);
    }

    #[test]
    fn read_write_capabilities_only_enable_audited_session_edits() {
        let capabilities = RemoteCapabilities::read_write();
        assert!(capabilities.session_snapshots);
        assert!(capabilities.audit_log);
        assert!(capabilities.session_edit);
        assert!(!capabilities.terminal);
        assert!(!capabilities.realtime_events);
    }

    #[test]
    fn success_envelope_uses_camel_case_and_protocol_version() {
        let value = serde_json::to_value(ApiSuccess::new(
            "request-1".to_string(),
            serde_json::json!({ "ok": true }),
        ))
        .expect("serialize success envelope");

        assert_eq!(value["protocolVersion"], REMOTE_PROTOCOL_VERSION);
        assert_eq!(value["requestId"], "request-1");
        assert_eq!(value["data"]["ok"], true);
    }

    #[test]
    fn mutation_contract_requires_revision_and_idempotency_fields() {
        let mutation: EditMessageMutation = serde_json::from_value(serde_json::json!({
            "deviceId": "phone-1",
            "mutationId": "mutation-1",
            "platform": "claude",
            "sessionKey": "session-1",
            "messageId": "message-1",
            "content": "updated",
            "expectedRevision": "revision-1"
        }))
        .expect("parse mutation");

        assert_eq!(mutation.device_id, "phone-1");
        assert_eq!(mutation.mutation_id, "mutation-1");
        assert_eq!(mutation.expected_revision, "revision-1");
    }
}
