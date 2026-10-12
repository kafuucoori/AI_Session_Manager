let codexSqlPromise = null;

async function readCodexIndexes(rootHandle) {
  const databaseFiles = await getCodexDatabaseFiles(rootHandle);
  const [stateRecords, catalogRecords] = await Promise.all([
    readCodexStateIndex(databaseFiles.state),
    readCodexCatalogIndex(databaseFiles.catalog),
  ]);
  return { stateRecords, catalogRecords };
}

async function readCodexStateIndex(database) {
  const SQL = await loadCodexSql();
  const { bytes } = await readCodexDatabaseSnapshot(database);
  const db = new SQL.Database(bytes);
  try {
    const rows = queryCodexRows(db,
      "SELECT id, rollout_path, updated_at, updated_at_ms, cwd, title, name, " +
      "first_user_message, preview FROM threads");
    return new Map(rows.map((row) => [row.id, row]));
  } finally {
    db.close();
  }
}

async function readCodexCatalogIndex(database) {
  if (!database) return new Map();
  const SQL = await loadCodexSql();
  const { bytes } = await readCodexDatabaseSnapshot(database);
  const db = new SQL.Database(bytes);
  try {
    const rows = queryCodexRows(db,
      "SELECT thread_id AS id, display_title, source_created_at, source_updated_at, cwd " +
      "FROM local_thread_catalog WHERE host_id = 'local'");
    return new Map(rows.map((row) => [row.id, row]));
  } finally {
    db.close();
  }
}

async function deleteCodexThreads(targets) {
  ensureRoot();
  const databaseFiles = await getCodexDatabaseFiles(state.rootHandle);
  const snapshots = await readCodexDatabaseSnapshots(databaseFiles);

  const SQL = await loadCodexSql();
  const stateOriginal = snapshots.state.bytes;
  const historyOriginal = snapshots.history?.bytes || null;
  const catalogOriginal = snapshots.catalog?.bytes || null;
  const historySnapshotsOriginal = snapshots.historySnapshots?.bytes || null;
  const summariesOriginal = snapshots.summaries?.bytes || null;
  const stateDb = new SQL.Database(stateOriginal);
  const historyDb = historyOriginal ? new SQL.Database(historyOriginal) : null;
  const catalogDb = catalogOriginal ? new SQL.Database(catalogOriginal) : null;
  const historySnapshotsDb = historySnapshotsOriginal
    ? new SQL.Database(historySnapshotsOriginal)
    : null;
  const summariesDb = summariesOriginal ? new SQL.Database(summariesOriginal) : null;

  try {
    assertCodexIntegrity(stateDb, databaseFiles.state.name);
    if (historyDb) assertCodexIntegrity(historyDb, databaseFiles.history.name);
    if (catalogDb) assertCodexIntegrity(catalogDb, databaseFiles.catalog.name);
    if (historySnapshotsDb) {
      assertCodexIntegrity(historySnapshotsDb, databaseFiles.historySnapshots.name);
    }
    if (summariesDb) assertCodexIntegrity(summariesDb, databaseFiles.summaries.name);
    const requestedIds = targets.map((target) => target.id).filter(Boolean);
    const threadIds = collectCodexThreadTree(stateDb, requestedIds);
    const rolloutPaths = readCodexRolloutPaths(stateDb, threadIds);
    const nextState = deleteCodexStateRows(stateDb, threadIds);
    const nextHistory = historyDb ? deleteCodexRowsByThreadId(historyDb, threadIds) : null;
    const nextCatalog = catalogDb ? deleteCodexRowsByThreadId(catalogDb, threadIds) : null;
    const nextHistorySnapshots = historySnapshotsDb
      ? deleteCodexRowsByThreadId(historySnapshotsDb, threadIds) : null;
    const nextSummaries = summariesDb
      ? deleteCodexRowsByThreadId(summariesDb, threadIds) : null;

    const updates = buildCodexDatabaseUpdates(databaseFiles, snapshots, {
      state: nextState,
      history: nextHistory,
      catalog: nextCatalog,
      historySnapshots: nextHistorySnapshots,
      summaries: nextSummaries,
    });
    await replaceCodexDatabases(updates);
    try {
      await removeCodexSidecars(snapshots.sidecars);
      await verifyCodexDatabaseDeletion(SQL, databaseFiles, threadIds);
    } catch (error) {
      await restoreCodexDatabases(updates);
      throw new Error(`数据库后续校验或清理失败，已恢复完整数据: ${getErrorMessage(error)}`);
    }

    await cleanupCodexIndexes(threadIds);
    await deleteCodexRollouts(targets, rolloutPaths);
    return threadIds;
  } finally {
    stateDb.close();
    historyDb?.close();
    catalogDb?.close();
    historySnapshotsDb?.close();
    summariesDb?.close();
  }
}

async function loadCodexSql() {
  if (typeof initSqlJs !== "function") {
    throw new Error("SQLite 组件未加载，请确认根目录中的 sql-asm.js 文件完整.");
  }
  if (!codexSqlPromise) codexSqlPromise = initSqlJs();
  return codexSqlPromise;
}

async function getCodexDatabaseFiles(rootHandle) {
  let stateFile = null;
  let historyFile = null;
  for await (const [name, handle] of rootHandle.entries()) {
    if (handle.kind !== "file") continue;
    const stateMatch = name.match(/^state_(\d+)\.sqlite$/i);
    if (stateMatch && (!stateFile || Number(stateMatch[1]) > stateFile.version)) {
      stateFile = {
        name,
        path: name,
        handle,
        directoryHandle: rootHandle,
        version: Number(stateMatch[1]),
      };
    }
    const historyMatch = name.match(/^thread_history_(\d+)\.sqlite$/i);
    if (historyMatch && (!historyFile || Number(historyMatch[1]) > historyFile.version)) {
      historyFile = {
        name,
        path: name,
        handle,
        directoryHandle: rootHandle,
        version: Number(historyMatch[1]),
      };
    }
  }
  if (!stateFile) {
    throw new Error("未找到 Codex state_<版本>.sqlite，无法执行完整删除.");
  }
  const sqliteDirectory = await getOptionalDirectoryHandle(rootHandle, "sqlite");
  const catalog = await getOptionalCodexDatabase(sqliteDirectory, "codex-dev.db", "sqlite");
  const historySnapshots = await getOptionalCodexDatabase(
    sqliteDirectory,
    "codex-history-snapshots-dev.db",
    "sqlite",
  );
  const summaries = await getOptionalCodexDatabase(
    sqliteDirectory,
    "codex-thread-summaries-dev.db",
    "sqlite",
  );
  return { state: stateFile, history: historyFile, catalog, historySnapshots, summaries };
}

async function readCodexDatabaseSnapshots(databaseFiles) {
  const snapshots = { sidecars: [] };
  for (const key of ["state", "history", "catalog", "historySnapshots", "summaries"]) {
    const database = databaseFiles[key];
    snapshots[key] = database ? await readCodexDatabaseSnapshot(database) : null;
    if (snapshots[key]) snapshots.sidecars.push(...snapshots[key].sidecars);
  }
  return snapshots;
}

async function readCodexDatabaseSnapshot(database) {
  const mainBytes = await readFileBytes(database.handle);
  const walName = `${database.name}-wal`;
  const shmName = `${database.name}-shm`;
  const walFile = await getOptionalCodexFile(database.directoryHandle, walName);
  const shmFile = await getOptionalCodexFile(database.directoryHandle, shmName);
  const sidecars = [
    walFile ? { directoryHandle: database.directoryHandle, name: walName } : null,
    shmFile ? { directoryHandle: database.directoryHandle, name: shmName } : null,
  ].filter(Boolean);

  if (!walFile || walFile.size === 0) return { bytes: mainBytes, sidecars };

  const walBytes = new Uint8Array(await walFile.arrayBuffer());
  return { bytes: mergeCodexWal(mainBytes, walBytes, `${database.path}-wal`), sidecars };
}

async function getOptionalCodexDatabase(directoryHandle, name, directoryName) {
  if (!directoryHandle) return null;
  try {
    return {
      name,
      path: `${directoryName}/${name}`,
      handle: await directoryHandle.getFileHandle(name),
      directoryHandle,
    };
  } catch (error) {
    if (error?.name === "NotFoundError") return null;
    throw error;
  }
}

async function getOptionalCodexFile(rootHandle, name) {
  try {
    const handle = await rootHandle.getFileHandle(name);
    return await handle.getFile();
  } catch (error) {
    if (error?.name === "NotFoundError") return null;
    throw error;
  }
}

function mergeCodexWal(mainBytes, walBytes, fileName) {
  if (walBytes.length < 32) throw new Error(`${fileName} 的 WAL 文件头不完整.`);
  const view = new DataView(walBytes.buffer, walBytes.byteOffset, walBytes.byteLength);
  const magic = view.getUint32(0, false);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) {
    throw new Error(`${fileName} 不是有效的 SQLite WAL 文件.`);
  }
  let pageSize = view.getUint32(8, false);
  if (pageSize === 1) pageSize = 65536;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
    throw new Error(`${fileName} 包含无效的 SQLite 页大小.`);
  }

  const checksumLittleEndian = magic === 0x377f0682;
  let checksum = updateCodexWalChecksum(walBytes, 0, 24, [0, 0], checksumLittleEndian);
  if (checksum[0] !== view.getUint32(24, false) || checksum[1] !== view.getUint32(28, false)) {
    throw new Error(`${fileName} 的 WAL 文件头校验失败.`);
  }

  const salt1 = view.getUint32(16, false);
  const salt2 = view.getUint32(20, false);
  const frameSize = 24 + pageSize;
  const frames = [];
  let lastCommit = -1;
  let committedPageCount = 0;
  for (let offset = 32; offset + frameSize <= walBytes.length; offset += frameSize) {
    const pageNumber = view.getUint32(offset, false);
    const databasePageCount = view.getUint32(offset + 4, false);
    if (!pageNumber || view.getUint32(offset + 8, false) !== salt1 ||
        view.getUint32(offset + 12, false) !== salt2) break;
    checksum = updateCodexWalChecksum(walBytes, offset, 8, checksum, checksumLittleEndian);
    checksum = updateCodexWalChecksum(
      walBytes,
      offset + 24,
      pageSize,
      checksum,
      checksumLittleEndian,
    );
    if (checksum[0] !== view.getUint32(offset + 16, false) ||
        checksum[1] !== view.getUint32(offset + 20, false)) break;
    frames.push({ pageNumber, dataOffset: offset + 24 });
    if (databasePageCount) {
      lastCommit = frames.length - 1;
      committedPageCount = databasePageCount;
    }
  }

  if (lastCommit < 0) return mainBytes;
  const databaseSize = committedPageCount * pageSize;
  if (!Number.isSafeInteger(databaseSize) || databaseSize <= 0) {
    throw new Error(`${fileName} 包含无效的数据库大小.`);
  }
  const merged = new Uint8Array(databaseSize);
  merged.set(mainBytes.subarray(0, Math.min(mainBytes.length, merged.length)));
  for (const frame of frames.slice(0, lastCommit + 1)) {
    const targetOffset = (frame.pageNumber - 1) * pageSize;
    if (targetOffset >= merged.length) continue;
    merged.set(
      walBytes.subarray(frame.dataOffset, frame.dataOffset + pageSize),
      targetOffset,
    );
  }
  return merged;
}

function updateCodexWalChecksum(bytes, offset, length, initial, littleEndian) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let [s0, s1] = initial;
  for (let index = offset; index < offset + length; index += 8) {
    s0 = (s0 + view.getUint32(index, littleEndian) + s1) >>> 0;
    s1 = (s1 + view.getUint32(index + 4, littleEndian) + s0) >>> 0;
  }
  return [s0, s1];
}

async function removeCodexSidecars(sidecars) {
  for (const sidecar of sidecars) {
    await removeEntryIfPresent(sidecar.directoryHandle, sidecar.name);
  }
}

function collectCodexThreadTree(db, requestedIds) {
  const ids = new Set(requestedIds);
  const rows = queryCodexRows(db, "SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges");
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (ids.has(row.parent_thread_id) && !ids.has(row.child_thread_id)) {
        ids.add(row.child_thread_id);
        changed = true;
      }
    }
  }
  return Array.from(ids);
}

function readCodexRolloutPaths(db, threadIds) {
  if (!threadIds.length) return [];
  const statement = db.prepare(
    `SELECT id, rollout_path FROM threads WHERE id IN (${sqlPlaceholders(threadIds)})`,
  );
  try {
    statement.bind(threadIds);
    const paths = [];
    while (statement.step()) {
      const row = statement.getAsObject();
      if (typeof row.rollout_path === "string" && row.rollout_path) paths.push(row.rollout_path);
    }
    return paths;
  } finally {
    statement.free();
  }
}

function deleteCodexStateRows(db, threadIds) {
  if (!threadIds.length) return db.export();
  const placeholders = sqlPlaceholders(threadIds);
  db.run("PRAGMA foreign_keys = ON");
  db.run("BEGIN IMMEDIATE");
  try {
    for (const table of codexThreadIdTables(db)) {
      db.run(`DELETE FROM ${quoteCodexIdentifier(table)} WHERE thread_id IN (${placeholders})`, threadIds);
    }
    db.run(
      `DELETE FROM thread_spawn_edges WHERE parent_thread_id IN (${placeholders}) ` +
      `OR child_thread_id IN (${placeholders})`,
      [...threadIds, ...threadIds],
    );
    db.run(`DELETE FROM threads WHERE id IN (${placeholders})`, threadIds);
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
  return db.export();
}

function deleteCodexRowsByThreadId(db, threadIds) {
  if (!threadIds.length) return db.export();
  const placeholders = sqlPlaceholders(threadIds);
  db.run("BEGIN IMMEDIATE");
  try {
    for (const table of codexThreadIdTables(db)) {
      db.run(`DELETE FROM ${quoteCodexIdentifier(table)} WHERE thread_id IN (${placeholders})`, threadIds);
    }
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
  return db.export();
}

function codexThreadIdTables(db) {
  const tables = queryCodexRows(db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  return tables.map(({ name }) => name).filter((name) =>
    queryCodexRows(db, `PRAGMA table_info(${quoteCodexIdentifier(name)})`)
      .some((column) => column.name === "thread_id"));
}

function quoteCodexIdentifier(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function buildCodexDatabaseUpdates(databaseFiles, snapshots, nextBytes) {
  const updates = [];
  for (const key of ["history", "catalog", "historySnapshots", "summaries", "state"]) {
    if (!databaseFiles[key] || !snapshots[key] || !nextBytes[key]) continue;
    updates.push({
      key,
      file: databaseFiles[key].handle,
      original: snapshots[key].bytes,
      next: nextBytes[key],
    });
  }
  return updates;
}

async function replaceCodexDatabases(updates) {
  try {
    for (const update of updates) await writeFileBytes(update.file, update.next);
  } catch (error) {
    const rollbackErrors = [];
    for (const update of updates) {
      await writeFileBytes(update.file, update.original).catch((rollbackError) =>
        rollbackErrors.push(rollbackError));
    }
    if (rollbackErrors.length) {
      throw new Error(`数据库写入失败且回滚不完整: ${getErrorMessage(error)}`);
    }
    throw error;
  }
}

async function verifyCodexDatabaseDeletion(SQL, databaseFiles, threadIds) {
  const stateBytes = await readFileBytes(databaseFiles.state.handle);
  const stateCheck = new SQL.Database(stateBytes);
  try {
    assertCodexIntegrity(stateCheck, databaseFiles.state.name);
    if (countCodexRowsByIds(stateCheck, "threads", threadIds) !== 0) {
      throw new Error(`${databaseFiles.state.name} 仍包含待删除线程.`);
    }
    verifyCodexThreadRows(stateCheck, databaseFiles.state.name, threadIds);
    if (countCodexSpawnEdges(stateCheck, threadIds) !== 0) {
      throw new Error(`${databaseFiles.state.name} 仍包含待删除线程的派生关系.`);
    }
  } finally {
    stateCheck.close();
  }

  for (const key of ["history", "catalog", "historySnapshots", "summaries"]) {
    const database = databaseFiles[key];
    if (!database) continue;
    const bytes = await readFileBytes(database.handle);
    const db = new SQL.Database(bytes);
    try {
      assertCodexIntegrity(db, database.name);
      verifyCodexThreadRows(db, database.path, threadIds);
    } finally {
      db.close();
    }
  }
}

function verifyCodexThreadRows(db, fileName, threadIds) {
  for (const table of codexThreadIdTables(db)) {
    if (countCodexRowsByIds(db, table, threadIds) !== 0) {
      throw new Error(`${fileName} 的 ${table} 仍包含待删除线程.`);
    }
  }
}

function countCodexSpawnEdges(db, threadIds) {
  if (!threadIds.length) return 0;
  const placeholders = sqlPlaceholders(threadIds);
  const statement = db.prepare(
    `SELECT COUNT(*) AS count FROM thread_spawn_edges WHERE parent_thread_id IN (${placeholders}) ` +
    `OR child_thread_id IN (${placeholders})`,
  );
  try {
    statement.bind([...threadIds, ...threadIds]);
    statement.step();
    return Number(statement.getAsObject().count || 0);
  } finally {
    statement.free();
  }
}

async function restoreCodexDatabases(updates) {
  const errors = [];
  for (const update of updates) {
    await writeFileBytes(update.file, update.original).catch((error) => errors.push(error));
  }
  if (errors.length) throw new Error("数据库校验失败，且原文件恢复不完整.");
}

function assertCodexIntegrity(db, fileName) {
  const result = db.exec("PRAGMA integrity_check")[0]?.values?.[0]?.[0];
  if (result !== "ok") throw new Error(`${fileName} 完整性检查失败: ${result || "未知错误"}`);
}

function countCodexRowsByIds(db, table, threadIds) {
  if (!threadIds.length) return 0;
  const column = table === "threads" ? "id" : "thread_id";
  const statement = db.prepare(
    `SELECT COUNT(*) AS count FROM ${quoteCodexIdentifier(table)} ` +
    `WHERE ${column} IN (${sqlPlaceholders(threadIds)})`,
  );
  try {
    statement.bind(threadIds);
    statement.step();
    return Number(statement.getAsObject().count || 0);
  } finally {
    statement.free();
  }
}

async function deleteCodexRollouts(targets, rolloutPaths) {
  const removed = new Set();
  for (const target of targets) {
    if (!target.parentHandle || !target.fileName) continue;
    await removeEntryIfPresent(target.parentHandle, target.fileName);
    removed.add(target.relativePath);
  }
  for (const rolloutPath of rolloutPaths) {
    const relativePath = codexRelativeRolloutPath(rolloutPath);
    if (!relativePath || removed.has(relativePath)) continue;
    await removeCodexRelativeFile(state.rootHandle, relativePath);
  }
}

function codexRelativeRolloutPath(rolloutPath) {
  const normalized = String(rolloutPath || "").replaceAll("\\", "/");
  const marker = "/sessions/";
  const index = normalized.toLowerCase().lastIndexOf(marker);
  return index === -1 ? "" : normalized.slice(index + 1);
}

async function removeCodexRelativeFile(rootHandle, relativePath) {
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "sessions") return;
  let directory = rootHandle;
  try {
    for (const part of parts.slice(0, -1)) {
      directory = await directory.getDirectoryHandle(part);
    }
    await removeEntryIfPresent(directory, parts.at(-1));
  } catch (error) {
    if (error?.name !== "NotFoundError") throw error;
  }
}

function queryCodexRows(db, sql) {
  const result = db.exec(sql)[0];
  if (!result) return [];
  return result.values.map((values) => Object.fromEntries(
    result.columns.map((column, index) => [column, values[index]]),
  ));
}

function sqlPlaceholders(values) {
  return values.map(() => "?").join(",");
}

async function readFileBytes(handle) {
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

async function writeFileBytes(handle, bytes) {
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}
