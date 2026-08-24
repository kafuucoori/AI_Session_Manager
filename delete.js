function openConfirm(mode) {
  const targets = getActionTargets(mode);
  if (!targets.length) return;
  state.pending = { mode };
  const size = formatBytes(targets.reduce((sum, target) => sum + (target.size || 0), 0));
  let title = "确认删除选中会话";
  let desc = `即将删除 ${targets.length} 个选中会话记录, 共 ${size}.`;
  if (mode === "all") {
    title = "确认删除全部会话";
    desc = `即将删除 ${targets.length} 个会话记录, 共 ${size}.`;
  } else if (mode === "single") {
    title = "确认删除当前会话";
    desc = `即将删除当前会话 "${getActiveSession()?.title || "-"}", 共 ${size}.`;
  }
  el.modalTitle.textContent = title;
  el.modalDesc.textContent = desc;
  el.modalWarning.textContent =
    "高风险操作: 删除前请关闭对应客户端. 此操作不可撤销. " +
    (isCodex()
      ? "将同步删除 Codex 线程、派生子线程、历史数据库、会话索引和转录文件；" +
        "同时清理侧边栏目录、历史快照和摘要缓存."
      : "将同步清理该会话的工具输出、检查点、任务、调试和会话环境数据.");
  el.modalConfirm.textContent = "确认删除";
  el.modalCancel.hidden = false;
  el.modal.dataset.kind = "confirm";
  el.modal.hidden = false;
}

function closeModal() {
  if (el.modal) el.modal.hidden = true;
  state.pending = null;
}

function getActionTargets(mode) {
  if (mode === "single") {
    const active = getActiveSession();
    return active && isDeletable(active) ? [active] : [];
  }
  if (mode === "all") return state.sessions.filter(isDeletable);
  return state.sessions.filter((session) => state.selectedIds.has(session.id) && isDeletable(session));
}

async function confirmAction() {
  if (el.modal.dataset.kind === "error") {
    closeModal();
    return;
  }
  if (!state.pending) return;
  const targets = getActionTargets(state.pending.mode);
  closeModal();
  if (!targets.length) return;

  if (isCodex()) {
    const deletedIds = await deleteCodexThreads(targets);
    for (const id of deletedIds) {
      state.selectedIds.delete(id);
      state.timelineCache.delete(id);
    }
  } else {
    for (const session of targets) await assertClaudeSessionNotRunning(session.id);
    for (const session of targets) {
      await deleteSessionFiles(session);
      state.selectedIds.delete(session.id);
      state.timelineCache.delete(session.id);
    }
  }
  await scanSessions();
}

async function assertClaudeSessionNotRunning(sessionId) {
  const sessionsHandle = await getOptionalDirectoryHandle(state.rootHandle, "sessions");
  if (!sessionsHandle) return;
  for await (const [name] of sessionsHandle.entries()) {
    if (name === sessionId || name.startsWith(`${sessionId}.`)) {
      throw new Error(`会话 ${sessionId} 仍有运行标记，请关闭 Claude Code 后再删除.`);
    }
  }
}

async function deleteSessionFiles(session) {
  if (session.parentHandle && session.fileName) {
    await removeEntryIfPresent(session.parentHandle, session.fileName);
    await removeEntryIfPresent(session.parentHandle, session.id, true);
  }
  await cleanupClaudeSessionData(session.id);
}

async function cleanupClaudeSessionData(sessionId) {
  const perSessionDirectories = ["file-history", "tasks", "debug", "session-env", "todos"];
  for (const directoryName of perSessionDirectories) {
    const directoryHandle = await getOptionalDirectoryHandle(state.rootHandle, directoryName);
    if (!directoryHandle) continue;
    const matches = [];
    for await (const [name] of directoryHandle.entries()) {
      if (name === sessionId || name.startsWith(`${sessionId}.`)) matches.push(name);
    }
    for (const name of matches) await removeEntryIfPresent(directoryHandle, name, true);
  }
  await filterJsonLinesFile("history.jsonl", (record) => !recordMatchesSession(record, sessionId));
}

function recordMatchesSession(record, sessionId) {
  return [record?.sessionId, record?.session_id, record?.session].some(
    (value) => typeof value === "string" && value === sessionId,
  );
}

async function cleanupCodexIndexes(deletedIds) {
  const removeIds = new Set(deletedIds);
  await filterJsonLinesFile(
    "session_index.jsonl",
    (record) => !record?.id || !removeIds.has(record.id),
  );
}

async function removeEntryIfPresent(directoryHandle, name, recursive = false) {
  try {
    await directoryHandle.removeEntry(name, { recursive });
  } catch (error) {
    if (error?.name !== "NotFoundError") throw error;
  }
}

async function filterJsonLinesFile(fileName, shouldKeep) {
  ensureRoot();
  try {
    const fh = await state.rootHandle.getFileHandle(fileName);
    const text = await (await fh.getFile()).text();
    const lines = [];
    for (const raw of text.split(/\r?\n/)) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const parsed = safeJsonParse(trimmed);
      if (!parsed || shouldKeep(parsed)) lines.push(raw);
    }
    const writable = await fh.createWritable();
    await writable.write(lines.length ? `${lines.join("\n")}\n` : "");
    await writable.close();
  } catch (error) {
    if (error?.name === "NotFoundError") return;
    throw error;
  }
}
