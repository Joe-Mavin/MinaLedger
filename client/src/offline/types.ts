export const COMMAND_SCHEMA_VERSION = 1 as const;

export type SyncState = 'draft' | 'pending_upload' | 'uploading' | 'server_received' | 'needs_review' | 'server_accepted' | 'conflict' | 'rejected';
export type CommandType = 'production.create' | 'production.measurement.add' | 'capture.acknowledgement.add';

export interface ActingContext {
  partyId: string;
  roleCode: string;
  scopeKind: string;
  scopeId: string;
}

export interface CommandEnvelope {
  clientMutationId: string;
  deviceId: string;
  recorderUserId: string;
  actualParticipant: { identityState: 'IDENTIFIED' | 'UNRESOLVED' | 'UNKNOWN'; partyId?: string };
  actingContext: ActingContext;
  commandType: CommandType;
  schemaVersion: typeof COMMAND_SCHEMA_VERSION;
  payload: unknown;
  clientCreatedAt: string;
  clientTimezone: string;
  occurredAtClaimed: string;
  expectedVersion?: { streamKind: 'mining_hole' | 'material_event'; streamId: string; sequence: number };
  parentCommandIds: string[];
  revisionOf?: string;
  captureProvenance?: unknown;
  evidence: Array<{ reference: string; sha256?: string }>;
  localState: 'pending_upload';
}

export interface ServerReceipt {
  clientMutationId: string;
  status: Exclude<SyncState, 'draft' | 'pending_upload' | 'uploading'>;
  receivedAt?: string;
  resolvedAt?: string | null;
  response?: unknown;
  error?: { code: string; message: string; details?: unknown } | null;
}

export interface QueuedCommand {
  envelope: CommandEnvelope;
  state: SyncState;
  recorderUserId: string;
  contextKey: string;
  createdAt: string;
  retryCount: number;
  nextAttemptAt?: number;
  receipt?: ServerReceipt;
  lastError?: string;
}

export interface LocalReferenceCache<T = unknown> {
  key: string;
  recorderUserId: string;
  contextKey: string;
  savedAt: string;
  value: T;
}
