# Memory Forge Remote Protocol v1

Status: implemented experimental contract for the LAN-first remote companion.

## Principles

- The daemon is the only remote authority for session files, metadata and audit logs.
- Desktop and phone clients consume the same DTOs and mutation rules.
- Snapshot responses are authoritative. Realtime events may accelerate refreshes later, but never replace snapshots.
- Protocol fields are append-only within v1. New clients must ignore unknown response fields.
- Every mutation carries `deviceId`, `mutationId` and `expectedRevision`.

## Runtime Settings

The desktop app owns the daemon lifecycle. Changing any remote setting restarts the daemon.

| Setting | Default | Behavior |
| --- | --- | --- |
| `remoteBindMode` | `loopback` | `loopback` binds `127.0.0.1`; `lan` binds all interfaces and requires authentication. |
| `remotePort` | `7331` | Accepted range is `1024..=65535`. |
| `remoteMutationsEnabled` | `false` | Enables audited message edits, erases and restores when true. |
| `remoteTerminalEnabled` | `false` | Enables host-owned resume/fork terminals and phone input when true. |

Loopback mode is the safe default and does not expose the daemon to another device. LAN mode
generates and persists a random 64-character access token in the application data directory.
The settings screen renders a QR code for the fragment-based token handoff described below. An
explicit token revocation/rotation UI is not implemented in v1.

## Envelope

Successful responses use:

```json
{
  "protocolVersion": 1,
  "requestId": "request-id",
  "data": {}
}
```

Errors use:

```json
{
  "protocolVersion": 1,
  "requestId": "request-id",
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message",
    "retryable": false
  }
}
```

`SESSION_REVISION_CONFLICT` may additionally include `currentRevision`. Clients must reload the authoritative detail before offering another write.

## Routes

All protocol routes except `/health` live under `/api/v1`.

| Method | Route | LAN authentication | Capability |
| --- | --- | --- | --- |
| `GET` | `/health` | Public | Liveness only |
| `GET` | `/api/v1/bootstrap` | Public | Server identity, authentication policy and capabilities |
| `GET` | `/api/v1/dashboard` | Bearer token | Dashboard snapshot |
| `GET` | `/api/v1/sessions` | Bearer token | Platform session list/search |
| `GET` | `/api/v1/session-detail` | Bearer token | Authoritative detail with `revision` |
| `GET` | `/api/v1/edit-log` | Bearer token | Read-only audit history |
| `POST` | `/api/v1/mutations/session-edit` | Bearer token | Edit or erase one message |
| `POST` | `/api/v1/mutations/session-restore` | Bearer token | Restore one audit-log entry |
| `GET` | `/api/v1/terminals?deviceId=...` | Bearer token | List terminals owned by one phone identity |
| `POST` | `/api/v1/terminals` | Bearer token | Start or reconnect to an approved resume/fork command |
| `GET` | `/api/v1/terminals/{id}?deviceId=...` | Bearer token | Read terminal state |
| `GET` | `/api/v1/terminals/{id}/output?deviceId=...&cursor=...` | Bearer token | Read bounded PTY output chunks |
| `POST` | `/api/v1/terminals/{id}/input` | Bearer token | Write text or base64 bytes to the PTY |
| `POST` | `/api/v1/terminals/{id}/resize` | Bearer token | Resize the PTY |
| `POST` | `/api/v1/terminals/{id}/stop` | Bearer token | Gracefully interrupt or force-stop the process |
| `DELETE` | `/api/v1/terminals/{id}?deviceId=...` | Bearer token | Remove terminal history and stop it if needed |

Session keys remain opaque query values. Clients must not parse filesystem paths from them.

## Mutations

Mutation routes are implemented but return `REMOTE_CAPABILITY_UNAVAILABLE` while the daemon
advertises `sessionEdit: false`. They are disabled by default.

`session-edit` accepts `deviceId`, `mutationId`, `platform`, `sessionKey`, `messageId`, `content`
and `expectedRevision`. Empty `content` erases the message through the same audited edit path.
The request body is limited to 4 MiB.

`session-restore` accepts `deviceId`, `mutationId`, `platform`, `sessionKey`, `editLogId` and
`expectedRevision`.

Both operations use the same atomic session writer and audit log as desktop edits. Metadata
mutations, audit-log deletion and realtime events are not remote capabilities in v1. Terminal
access is a separate opt-in capability. Kiro IDE remains read-only and does not expose remote
terminals in v1 because one execution output may be mirrored across multiple files and cannot yet
share the same revision guarantee.

### Revision and idempotency

- `expectedRevision` is the SHA-256 revision returned by the last authoritative session detail.
- A stale write returns HTTP `409` with `SESSION_REVISION_CONFLICT` and `currentRevision`. The
  client reloads the detail before allowing another attempt.
- Successful mutation results are persisted in SQLite by `(deviceId, mutationId)` in the
  `remote_mutations` table.
- Repeating the same mutation returns its stored result. Reusing the identifier for a different
  operation or request body returns HTTP `409` with `MUTATION_ID_REUSED`.

## Remote Terminals

Remote terminals reuse the desktop app's embedded PTY manager. The process, working directory and
AI CLI all run on the host computer; the phone is a browser-based viewport and input surface. No
phone app is required.

Starting a terminal accepts `deviceId`, `terminalId`, `platform`, `sessionKey`, `commandKind`,
`cols` and `rows`. `commandKind` is restricted to `resume` or `fork`. The daemon resolves the
authoritative session and chooses its own platform command; a remote request cannot provide an
executable or arbitrary shell command. Repeating a start request for the same owned `terminalId`
returns the existing snapshot, which makes retries safe.

Each output chunk has a monotonic cursor. The browser polls from its last cursor, so a page refresh
can list the same terminal, restore buffered output and continue polling while the desktop process
is still running. If the requested cursor has fallen out of the bounded history, the response sets
`truncated: true` and the UI tells the user that earlier output is unavailable.

Lifecycle operations are distinct:

- A graceful stop sends Ctrl+C and force-kills the process after 1.5 seconds if it is still alive.
- A force stop kills the host process immediately.
- Close removes the terminal record and also kills the process if it is still running.
- Finished records are retained for up to 30 minutes while the desktop app remains running.

Resource limits are enforced by the host: at most 3 active terminals per device identity and 8
records in total; buffered output is capped at 4 MiB or 2,048 chunks; one output response returns at
most 256 chunks; and one input request is capped at 64 KiB. Terminal size is restricted to
20–500 columns and 3–300 rows.

## LAN Token Flow

The desktop settings screen exposes a phone URL whose fragment is `#token=<token>`. URL fragments
are not sent in the HTTP request. The phone client moves the token into local storage, removes the
fragment from the visible URL, and sends `Authorization: Bearer <token>` for protected API calls.

Static assets, `/health` and `/api/v1/bootstrap` remain public so a phone can load the access gate
and discover whether authentication is required. Session snapshots and all mutations are protected.

## Security Boundary

- Default listen address is `127.0.0.1`; LAN binding is never implicit.
- Host validation and DNS-rebinding protection apply before routing. LAN requests currently use
  numeric private, loopback or link-local IP addresses on the configured port.
- Static UI assets may be public, but protected API traffic requires the Bearer token in LAN mode.
- CORS is only a browser policy and is never treated as authentication.
- Read, edit and terminal permissions are separate capabilities.
- Terminal access is disabled by default and only starts host-derived `resume` or `fork` commands.
- The daemon never accepts arbitrary shell commands from a remote client.
- `deviceId` scopes terminal records to a browser identity, but it is not a second credential. Any
  client holding the shared Bearer token is trusted and could claim another device identifier.

### Transport limitation

The current LAN transport is plain HTTP. The token prevents unauthenticated use but does not encrypt
traffic or protect the token and session content from passive LAN sniffing. Use it only on a trusted
local network. This implementation is not E2EE.

Browsers only allow Service Workers on secure contexts. `http://127.0.0.1` qualifies, but a phone
opening `http://<private-ip>:7331` does not. The mobile web UI still works in the browser, but offline
caching and reliable installable-PWA behavior require a future HTTPS delivery mode. An E2EE relay,
internet exposure and automatic router port forwarding are outside this LAN v1 contract.
