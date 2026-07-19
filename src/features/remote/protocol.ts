import type { DashboardSummary, EditLogEntry, SessionDetail, SessionListResult } from '@/features/desktop/types'

export const REMOTE_PROTOCOL_VERSION = 1 as const

export type RemoteCapabilities = {
  sessionSnapshots: boolean
  sessionSearch: boolean
  auditLog: boolean
  sessionEdit: boolean
  terminal: boolean
  realtimeEvents: boolean
}

export type RemoteAuthInfo = {
  required: boolean
  pairingSupported: boolean
}

export type RemotePlatformInfo = {
  id: string
  label: string
  available: boolean
}

export type RemoteBootstrap = {
  protocolVersion: number
  serverId: string
  serverName: string
  serverVersion: string
  serverTime: string
  capabilities: RemoteCapabilities
  auth: RemoteAuthInfo
  platforms: RemotePlatformInfo[]
}

export type ApiSuccess<T> = {
  protocolVersion: number
  requestId: string
  data: T
}

export type ApiError = {
  protocolVersion: number
  requestId: string
  error: {
    code: string
    message: string
    retryable: boolean
    currentRevision?: string
  }
}

export type RemoteSnapshotRoutes = {
  bootstrap: RemoteBootstrap
  dashboard: DashboardSummary
  sessions: SessionListResult
  sessionDetail: SessionDetail
  editLog: EditLogEntry[]
}

export type EditMessageMutation = {
  deviceId: string
  mutationId: string
  platform: string
  sessionKey: string
  messageId: string
  content: string
  expectedRevision: string
}

export type RestoreMessageMutation = {
  deviceId: string
  mutationId: string
  platform: string
  sessionKey: string
  editLogId: number
  expectedRevision: string
}

export type RemoteMutationResult = {
  mutationId: string
  applied: boolean
}

export type RemoteTerminalStatus = 'starting' | 'running' | 'stopping' | 'exited' | 'failed'

export type RemoteTerminalSnapshot = {
  terminalId: string
  sessionKey: string
  platform: string
  commandKind: 'resume' | 'fork'
  title: string
  cwd: string
  status: RemoteTerminalStatus
  processId?: number | null
  exitCode?: number | null
  errorMessage?: string | null
  createdAt: number
  nextCursor: number
}

export type RemoteTerminalOutputChunk = {
  cursor: number
  data: string
}

export type RemoteTerminalOutput = {
  terminal: RemoteTerminalSnapshot
  chunks: RemoteTerminalOutputChunk[]
  nextCursor: number
  truncated: boolean
}
