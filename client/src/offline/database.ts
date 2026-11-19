import type { LocalReferenceCache, QueuedCommand, ServerReceipt } from './types';

const DB_NAME = 'minaledger-field-v1';
const DB_VERSION = 1;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
  });
}

export function openFieldDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('This browser does not provide IndexedDB storage.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const commands = database.objectStoreNames.contains('commands')
        ? request.transaction!.objectStore('commands')
        : database.createObjectStore('commands', { keyPath: 'envelope.clientMutationId' });
      if (!commands.indexNames.contains('recorderUserId')) commands.createIndex('recorderUserId', 'recorderUserId', { unique: false });
      if (!commands.indexNames.contains('state')) commands.createIndex('state', 'state', { unique: false });
      if (!commands.indexNames.contains('contextKey')) commands.createIndex('contextKey', 'contextKey', { unique: false });
      if (!commands.indexNames.contains('createdAt')) commands.createIndex('createdAt', 'createdAt', { unique: false });
      if (!database.objectStoreNames.contains('receipts')) database.createObjectStore('receipts', { keyPath: 'clientMutationId' });
      if (!database.objectStoreNames.contains('referenceData')) database.createObjectStore('referenceData', { keyPath: 'key' });
      if (!database.objectStoreNames.contains('metadata')) database.createObjectStore('metadata', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local command storage.'));
    request.onblocked = () => reject(new Error('Local storage upgrade is blocked by another open MinaLedger tab.'));
  });
}

export async function getDeviceId(): Promise<string> {
  const database = await openFieldDatabase();
  try {
    const transaction = database.transaction('metadata', 'readwrite');
    const done = transactionDone(transaction);
    const store = transaction.objectStore('metadata');
    const saved = await requestResult<{ key: string; value: string } | undefined>(store.get('deviceId'));
    const randomUUID = globalThis.crypto?.randomUUID;
    if (!saved && !randomUUID) throw new Error('This browser does not provide a secure random UUID generator.');
    const deviceId = saved?.value ?? randomUUID!.call(globalThis.crypto);
    if (!saved) store.put({ key: 'deviceId', value: deviceId });
    await done;
    return deviceId;
  } finally { database.close(); }
}

export async function addCommand(command: QueuedCommand): Promise<void> {
  const database = await openFieldDatabase();
  const transaction = database.transaction('commands', 'readwrite');
  const done = transactionDone(transaction);
  try {
    await requestResult(transaction.objectStore('commands').add(command));
    await done;
  } catch (error) {
    await done.catch(() => undefined);
    throw error;
  } finally { database.close(); }
}

export async function updateCommand(clientMutationId: string, update: (command: QueuedCommand) => QueuedCommand): Promise<QueuedCommand> {
  const database = await openFieldDatabase();
  const transaction = database.transaction('commands', 'readwrite');
  const done = transactionDone(transaction);
  const store = transaction.objectStore('commands');
  const command = await requestResult<QueuedCommand | undefined>(store.get(clientMutationId));
  if (!command) {
    transaction.abort();
    await done.catch(() => undefined);
    database.close();
    throw new Error('Queued command was not found.');
  }
  const updated = update(command);
  store.put(updated);
  await done;
  database.close();
  return updated;
}

export async function listCommands(recorderUserId: string): Promise<QueuedCommand[]> {
  const database = await openFieldDatabase();
  const transaction = database.transaction('commands', 'readonly');
  const done = transactionDone(transaction);
  const rows = await requestResult<QueuedCommand[]>(transaction.objectStore('commands').index('recorderUserId').getAll(recorderUserId));
  await done;
  database.close();
  return rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function getCommand(clientMutationId: string): Promise<QueuedCommand | undefined> {
  const database = await openFieldDatabase();
  const transaction = database.transaction('commands', 'readonly');
  const done = transactionDone(transaction);
  const row = await requestResult<QueuedCommand | undefined>(transaction.objectStore('commands').get(clientMutationId));
  await done;
  database.close();
  return row;
}

export async function applyReceipt(clientMutationId: string, receipt: ServerReceipt): Promise<void> {
  const database = await openFieldDatabase();
  const transaction = database.transaction(['commands', 'receipts'], 'readwrite');
  const done = transactionDone(transaction);
  const receipts = transaction.objectStore('receipts');
  const commands = transaction.objectStore('commands');
  receipts.put(receipt);
  const command = await requestResult<QueuedCommand | undefined>(commands.get(clientMutationId));
  if (command) commands.put({ ...command, receipt, state: receipt.status, lastError: receipt.error?.message });
  await done;
  database.close();
}

export async function getReceipt(clientMutationId: string): Promise<ServerReceipt | undefined> {
  const database = await openFieldDatabase();
  const transaction = database.transaction('receipts', 'readonly');
  const done = transactionDone(transaction);
  const receipt = await requestResult<ServerReceipt | undefined>(transaction.objectStore('receipts').get(clientMutationId));
  await done;
  database.close();
  return receipt;
}

export async function saveReferenceCache<T>(entry: LocalReferenceCache<T>): Promise<void> {
  const database = await openFieldDatabase();
  const transaction = database.transaction('referenceData', 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore('referenceData').put(entry);
  await done;
  database.close();
}

export async function getReferenceCache<T>(key: string): Promise<LocalReferenceCache<T> | undefined> {
  const database = await openFieldDatabase();
  const transaction = database.transaction('referenceData', 'readonly');
  const done = transactionDone(transaction);
  const row = await requestResult<LocalReferenceCache<T> | undefined>(transaction.objectStore('referenceData').get(key));
  await done;
  database.close();
  return row;
}

export async function clearReferenceCache(): Promise<void> {
  const database = await openFieldDatabase();
  const transaction = database.transaction('referenceData', 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore('referenceData').clear();
  await done;
  database.close();
}

export async function clearLocalDatabaseForTests(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Database deletion is blocked.'));
  });
}
