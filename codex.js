async function readCodexSessions(rootHandle, sessionsHandle) {
  const [indexes, sessionRecords, sessions] = await Promise.all([
    readCodexIndexes(rootHandle),
    readCodexSessionIndex(rootHandle),
    readCodexSessionFiles(sessionsHandle),
  ]);
  const { stateRecords, catalogRecords } = indexes;

  for (const session of sessions) {
    const stored = stateRecords.get(session.id);
    const cataloged = catalogRecords.get(session.id);
    const indexed = sessionRecords.get(session.id);
    const cwd = stored?.cwd || cataloged?.cwd || session.cwd || "";
    session.title = (cataloged?.display_title || stored?.name || stored?.title ||
      indexed?.thread_name || "").trim() ||
      session.firstUserText || session.id;
    session.updatedAt = codexStoredTimestamp(stored) ||
      codexCatalogTimestamp(cataloged) || indexed?.updated_at || session.updatedAt;
    session.previewSummary = (stored?.preview || stored?.first_user_message || "").trim() ||
      session.firstUserText ||
      (session.readError ? `读取元数据失败: ${session.readError}` : "");
    session.projectDirName = cwd || "(未知项目)";
    session.projectPath = cwd;
  }

  const existingIds = new Set(sessions.map((session) => session.id));
  for (const [id, record] of stateRecords.entries()) {
    if (existingIds.has(id)) continue;
    const indexed = sessionRecords.get(id);
    const cataloged = catalogRecords.get(id);
    const relativePath = codexRelativeRolloutPath(record.rollout_path);
    sessions.push({
      id,
      title: (cataloged?.display_title || record.name || record.title ||
        indexed?.thread_name || "").trim() || id,
      updatedAt: codexStoredTimestamp(record) || codexCatalogTimestamp(cataloged) ||
        indexed?.updated_at || null,
      size: 0,
      relativePath: relativePath || "sessions/<已丢失>",
      fileHandle: null,
      parentHandle: null,
      fileName: null,
      orphanState: true,
      previewSummary: (record.preview || record.first_user_message || "").trim(),
      projectDirName: record.cwd || "(未知项目)",
      projectPath: record.cwd || "",
      messageCount: null,
    });
    existingIds.add(id);
  }
  for (const [id, record] of catalogRecords.entries()) {
    if (existingIds.has(id)) continue;
    const indexed = sessionRecords.get(id);
    sessions.push({
      id,
      title: (record.display_title || indexed?.thread_name || "").trim() || id,
      updatedAt: codexCatalogTimestamp(record) || indexed?.updated_at || null,
      size: 0,
      relativePath: "sqlite/codex-dev.db",
      fileHandle: null,
      parentHandle: null,
      fileName: null,
      orphanCatalog: true,
      previewSummary: "",
      projectDirName: record.cwd || "(未知项目)",
      projectPath: record.cwd || "",
      messageCount: null,
    });
    existingIds.add(id);
  }
  for (const [id, record] of sessionRecords.entries()) {
    if (existingIds.has(id)) continue;
    sessions.push({
      id,
      title: (record.thread_name || "").trim() || id,
      updatedAt: record.updated_at,
      size: 0,
      relativePath: "sessions/<已丢失>",
      fileHandle: null,
      parentHandle: null,
      fileName: null,
      orphanIndex: true,
      previewSummary: "",
      projectDirName: "(未知项目)",
      projectPath: "",
      messageCount: null,
    });
  }
  return sessions;
}

function codexStoredTimestamp(record) {
  const value = Number(record?.updated_at_ms || record?.updated_at || 0);
  if (!value) return null;
  return new Date(value < 1e12 ? value * 1000 : value).toISOString();
}

function codexCatalogTimestamp(record) {
  const value = Number(record?.source_updated_at || record?.source_created_at || 0);
  if (!value) return null;
  return new Date(value < 1e12 ? value * 1000 : value).toISOString();
}

async function readCodexSessionIndex(rootHandle) {
  try {
    const fh = await rootHandle.getFileHandle("session_index.jsonl");
    const text = await (await fh.getFile()).text();
    const records = new Map();
    for (const line of splitJsonLines(text)) {
      const parsed = safeJsonParse(line);
      if (!parsed?.id) continue;
      const prev = records.get(parsed.id);
      if (!prev || new Date(parsed.updated_at || 0) >= new Date(prev.updated_at || 0)) {
        records.set(parsed.id, parsed);
      }
    }
    return records;
  } catch (error) {
    if (error?.name === "NotFoundError") return new Map();
    throw error;
  }
}

async function readCodexSessionFiles(sessionsHandle) {
  const entries = [];
  for await (const entry of walkDirectory(sessionsHandle, ["sessions"])) {
    if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".jsonl")) {
      entries.push(entry);
    }
  }
  const sessions = await mapWithConcurrency(entries, 6, async (entry) => {
    let file = null;
    let meta = { id: "", cwd: "", firstUserText: "" };
    let readError = "";
    try {
      file = await entry.handle.getFile();
      meta = await readCodexFileMeta(file);
    } catch (error) {
      readError = getErrorMessage(error);
    }
    const id = meta.id || extractUuid(entry.name);
    if (!id) return null;
    return {
      id,
      size: file?.size || 0,
      updatedAt: file?.lastModified ? new Date(file.lastModified).toISOString() : null,
      relativePath: entry.path.join("/"),
      fileHandle: entry.handle,
      parentHandle: entry.parentHandle,
      fileName: entry.name,
      messageCount: null,
      cwd: meta.cwd,
      firstUserText: meta.firstUserText,
      readError,
    };
  });
  return sessions.filter(Boolean);
}

async function readCodexFileMeta(file) {
  let id = "";
  let cwd = "";
  let firstUserText = "";
  for await (const line of streamFileLines(file)) {
    const parsed = safeJsonParse(line);
    const payload = parsed?.payload;
    if (!payload) continue;
    if (parsed.type === "session_meta") {
      if (!id && typeof payload.id === "string") id = payload.id;
      if (!cwd && typeof payload.cwd === "string") cwd = payload.cwd.trim();
    }
    if (!firstUserText && parsed.type === "response_item" && payload.type === "message" &&
      payload.role === "user") {
      firstUserText = codexTitleCandidate(extractCodexMessageContent(payload.content));
    }
    if (id && cwd && firstUserText) break;
  }
  return { id, cwd, firstUserText };
}

function codexTitleCandidate(text) {
  const body = stripSystemNoise(String(text || ""));
  if (!body) return "";
  return truncateText(body.replace(/\s+/g, " ").trim(), 80);
}

function buildCodexTimeline(text) {
  const items = [];
  for (const line of splitJsonLines(text)) {
    const parsed = safeJsonParse(line);
    if (parsed?.type === "response_item") items.push(...extractCodexResponseItems(parsed));
  }
  return items;
}

function extractCodexResponseItems(record) {
  const payload = record.payload || {};
  const timestamp = record.timestamp || null;
  if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
    const body = extractCodexMessageContent(payload.content);
    if (!body) return [];
    const isUser = payload.role === "user";
    return [mkItem(
      isUser ? "user" : "assistant",
      isUser ? "user" : "assistant",
      isUser ? "用户" : "助手",
      timestamp,
      body,
    )];
  }
  if (payload.type === "custom_tool_call") {
    const body = summarizeCodexToolInvocation(payload);
    return body ? [mkItem("system", "toolCall", "工具调用", timestamp, body)] : [];
  }
  if (payload.type === "custom_tool_call_output") {
    const output = typeof payload.output === "string" ? payload.output.trim() : "";
    return output
      ? [mkItem("system", "toolOutput", "工具输出", timestamp, truncateText(output, TOOL_LIMIT))]
      : [];
  }
  return [];
}

function extractCodexMessageContent(content) {
  return joinTextBlocks(content, new Set(["input_text", "output_text"]));
}

function summarizeCodexToolInvocation(payload) {
  const name = payload.name || "工具调用";
  const input = typeof payload.input === "string" ? payload.input.trim() : "";
  return input ? `${name}\n${truncateText(input, TOOL_LIMIT)}` : name;
}
