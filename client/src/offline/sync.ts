import { applyReceipt, getCommand, listCommands, updateCommand } from './database';
import type { QueuedCommand, ServerReceipt, SyncState } from './types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';
const FINAL_STATES = new Set<SyncState>(['needs_review', 'server_accepted', 'conflict', 'rejected']);

function retryDelay(retryCount: number): number {
  const ceiling = Math.min(300_000, 1_000 * (2 ** Math.min(retryCount, 8)));
  return Math.floor(Math.random() * ceiling);
}

async function parseReceipt(response: Response): Promise<ServerReceipt | undefined> {
  try {
    const body = await response.json() as { receipt?: ServerReceipt };
    return body.receipt;
  } catch {
    return undefined;
  }
}

async function lookupReceipt(clientMutationId: string, token: string): Promise<ServerReceipt | undefined> {
  const response = await fetch(`${API_BASE_URL}/api/v1/sync/receipts/${clientMutationId}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit',
  });
  if (!response.ok) return undefined;
  return parseReceipt(response);
}

async function dependencyReady(command: QueuedCommand, all: QueuedCommand[]): Promise<boolean> {
  for (const parentId of command.envelope.parentCommandIds) {
    const parent = all.find((row) => row.envelope.clientMutationId === parentId) ?? await getCommand(parentId);
    if (!parent) return false;
    if (command.envelope.revisionOf === parentId && (parent.state === 'conflict' || parent.state === 'rejected')) continue;
    if (parent.state !== 'server_accepted' && parent.state !== 'needs_review') return false;
  }
  return true;
}

async function recordFailure(command: QueuedCommand, message: string): Promise<void> {
  const retryCount = command.retryCount + 1;
  await updateCommand(command.envelope.clientMutationId, (current) => ({
    ...current, state: 'pending_upload', retryCount,
    nextAttemptAt: Date.now() + retryDelay(retryCount), lastError: message,
  }));
}

async function upload(command: QueuedCommand, token: string): Promise<void> {
  await updateCommand(command.envelope.clientMutationId, (current) => ({ ...current, state: 'uploading', lastError: undefined }));
  try {
    const response = await fetch(`${API_BASE_URL}/api/v1/sync/commands`, {
      method: 'POST', cache: 'no-store', credentials: 'omit',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': command.envelope.clientMutationId,
      },
      body: JSON.stringify({ ...command.envelope, localState: 'pending_upload' }),
    });
    const receipt = await parseReceipt(response);
    if (receipt) {
      await applyReceipt(command.envelope.clientMutationId, receipt);
      return;
    }
    if (response.status === 401 || response.status === 403) {
      await recordFailure(command, 'The session or server authorization is no longer valid. Sign in again before retrying.');
      return;
    }
    throw new Error(`Sync returned HTTP ${response.status} without a receipt.`);
  } catch (error) {
    const receipt = await lookupReceipt(command.envelope.clientMutationId, token).catch(() => undefined);
    if (receipt) {
      await applyReceipt(command.envelope.clientMutationId, receipt);
      if (receipt.status === 'server_received') {
        await recordFailure(command, 'The server has a durable receipt and will be queried again with the same command ID.');
      }
      return;
    }
    await recordFailure(command, error instanceof Error ? `Upload outcome is unknown. Retrying the same command ID. ${error.message}` : 'Upload outcome is unknown. Retrying the same command ID.');
  }
}

export async function synchronizeCommands(recorderUserId: string, token: string): Promise<void> {
  let commands = await listCommands(recorderUserId);
  const now = Date.now();
  for (const command of commands) {
    if (command.state === 'draft' || FINAL_STATES.has(command.state) || (command.nextAttemptAt && command.nextAttemptAt > now)) continue;
    if (!(await dependencyReady(command, commands))) continue;
    await upload(command, token);
    commands = await listCommands(recorderUserId);
  }
}
