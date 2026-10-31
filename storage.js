let handleDbPromise = null;

async function* streamFileLines(file) {
  if (!file?.stream) {
    for (const line of splitJsonLines(await file.text())) yield line;
    return;
  }

  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        completed = true;
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "").trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield line;
      }
    }
    const tail = buffer.trim();
    if (tail) yield tail;
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function* walkDirectory(directoryHandle, path = []) {
  for await (const [name, handle] of directoryHandle.entries()) {
    const nextPath = [...path, name];
    if (handle.kind === "directory") {
      yield* walkDirectory(handle, nextPath);
      continue;
    }
    yield { kind: handle.kind, name, handle, parentHandle: directoryHandle, path: nextPath };
  }
}

async function getOptionalDirectoryHandle(parentHandle, name) {
  try {
    return await parentHandle.getDirectoryHandle(name);
  } catch (error) {
    if (error?.name === "NotFoundError") return null;
    throw error;
  }
}

async function preloadDirectoryHandles() {
  const handles = await Promise.all(
    ["claude", "codex"].map(async (source) => [source, await readRememberedDirectory(source)]),
  );
  for (const [source, handle] of handles) {
    if (handle?.kind === "directory") state.rememberedHandles.set(source, handle);
  }
}

async function readRememberedDirectory(source) {
  const db = await openHandleDatabase();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const request = db.transaction(HANDLE_STORE_NAME, "readonly")
      .objectStore(HANDLE_STORE_NAME)
      .get(source);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function rememberDirectoryHandle(source, handle) {
  const db = await openHandleDatabase();
  if (!db) return;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(HANDLE_STORE_NAME, "readwrite");
    transaction.objectStore(HANDLE_STORE_NAME).put(handle, source);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function openHandleDatabase() {
  if (typeof window === "undefined" || !("indexedDB" in window)) return Promise.resolve(null);
  if (handleDbPromise) return handleDbPromise;
  handleDbPromise = new Promise((resolve, reject) => {
    let request;
    try {
      request = window.indexedDB.open(HANDLE_DB_NAME, 1);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(HANDLE_STORE_NAME)) {
        request.result.createObjectStore(HANDLE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return handleDbPromise;
}
