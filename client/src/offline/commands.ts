import { addCommand, getDeviceId, listCommands, updateCommand } from './database';
import { COMMAND_SCHEMA_VERSION, type ActingContext, type CommandEnvelope, type CommandType, type QueuedCommand } from './types';

export function assertSupportedSchemaVersion(version: number): asserts version is typeof COMMAND_SCHEMA_VERSION {
  if (version !== COMMAND_SCHEMA_VERSION) throw new Error(`Command schema version ${version} is not supported by this app.`);
}

export async function createEnvelope(input: {
  recorderUserId: string;
  actingContext: ActingContext;
  commandType: CommandType;
  payload: unknown;
  occurredAtClaimed: string;
  actualParticipant: CommandEnvelope['actualParticipant'];
  captureProvenance?: unknown;
  evidence?: CommandEnvelope['evidence'];
  expectedVersion?: CommandEnvelope['expectedVersion'];
  parentCommandIds?: string[];
  revisionOf?: string;
}): Promise<CommandEnvelope> {
  assertSupportedSchemaVersion(COMMAND_SCHEMA_VERSION);
  const createdAt = new Date();
  if (Number.isNaN(new Date(input.occurredAtClaimed).getTime())) throw new Error('Enter a valid claimed occurrence date and time.');
  return {
    clientMutationId: crypto.randomUUID(),
    deviceId: await getDeviceId(),
    recorderUserId: input.recorderUserId,
    actualParticipant: input.actualParticipant,
    actingContext: input.actingContext,
    commandType: input.commandType,
    schemaVersion: COMMAND_SCHEMA_VERSION,
    payload: input.payload,
    clientCreatedAt: createdAt.toISOString(),
    clientTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    occurredAtClaimed: new Date(input.occurredAtClaimed).toISOString(),
    ...(input.expectedVersion ? { expectedVersion: input.expectedVersion } : {}),
    parentCommandIds: input.parentCommandIds ?? [],
    ...(input.revisionOf ? { revisionOf: input.revisionOf } : {}),
    ...(input.captureProvenance !== undefined ? { captureProvenance: input.captureProvenance } : {}),
    evidence: input.evidence ?? [],
    localState: 'pending_upload',
  };
}

export async function createLinkedRevision(input: {
  original: QueuedCommand;
  recorderUserId: string;
  actingContext: ActingContext;
  payload: unknown;
  expectedVersion?: CommandEnvelope['expectedVersion'];
  parentCommandIds?: string[];
}): Promise<CommandEnvelope> {
  const originalEnvelope = input.original.envelope;
  if (input.original.state !== 'conflict' && input.original.state !== 'rejected') {
    throw new Error('Only a conflicted or rejected command can be corrected.');
  }
  return createEnvelope({
    recorderUserId: input.recorderUserId,
    actingContext: input.actingContext,
    commandType: originalEnvelope.commandType,
    payload: input.payload,
    occurredAtClaimed: originalEnvelope.occurredAtClaimed,
    actualParticipant: originalEnvelope.actualParticipant,
    captureProvenance: originalEnvelope.captureProvenance,
    evidence: originalEnvelope.evidence,
    expectedVersion: input.expectedVersion,
    parentCommandIds: [...new Set([...originalEnvelope.parentCommandIds, ...(input.parentCommandIds ?? []), originalEnvelope.clientMutationId])],
    revisionOf: originalEnvelope.clientMutationId,
  });
}

export async function saveDraft(envelope: CommandEnvelope, contextKey: string): Promise<void> {
  const command: QueuedCommand = {
    envelope, state: 'draft', recorderUserId: envelope.recorderUserId, contextKey,
    createdAt: envelope.clientCreatedAt, retryCount: 0,
  };
  await addCommand(command);
}

export async function queueCommand(envelope: CommandEnvelope, contextKey: string): Promise<void> {
  const command: QueuedCommand = {
    envelope, state: 'pending_upload', recorderUserId: envelope.recorderUserId, contextKey,
    createdAt: envelope.clientCreatedAt, retryCount: 0,
  };
  await addCommand(command);
}

export async function recoverInterruptedUploads(recorderUserId: string): Promise<void> {
  const commands = await listCommands(recorderUserId);
  for (const command of commands) {
    if (command.state === 'uploading') {
      await updateCommand(command.envelope.clientMutationId, (current) => ({ ...current, state: 'pending_upload', lastError: 'Upload was interrupted. The same command ID will be retried.' }));
    }
  }
}
