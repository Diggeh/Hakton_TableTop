let database;

function open() {
  if (!globalThis.indexedDB || !globalThis.crypto?.subtle) {
    throw new Error(
      'Encrypted whispers need the desktop app or a secure browser connection.',
    );
  }
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('hakton-whisper-keys', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error('Whisper keys could not be opened on this device.'));
  });
  return database;
}

export async function readWhisperKey(id) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('keys', 'readonly');
    const request = transaction.objectStore('keys').get(id);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () =>
      reject(new Error('Whisper keys could not be read.'));
  });
}

export async function saveWhisperKey(id, value, onlyIfMissing = false) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('keys', 'readwrite');
    const store = transaction.objectStore('keys');
    let saved = value;
    const request = store.get(id);
    request.onsuccess = () => {
      if (onlyIfMissing && request.result) saved = request.result;
      else store.put(value, id);
    };
    transaction.oncomplete = () => resolve(saved);
    transaction.onabort = () =>
      reject(new Error('Whisper keys could not be saved on this device.'));
  });
}

export function whisperScope(socket, state) {
  return JSON.stringify([
    socket.io.uri,
    state.session.id,
    state.currentUser.id,
  ]);
}
