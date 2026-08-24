async function readClaudeSessions(projectsHandle) {
  const entries = [];
  for await (const [projectDirName, projectHandle] of projectsHandle.entries()) {
    if (projectHandle.kind !== "directory") continue;
    for await (const [name, handle] of projectHandle.entries()) {
      const id = extractUuid(name);
      if (handle.kind !== "file" || !id) continue;
      entries.push({ id, projectDirName, projectHandle, name, handle });
    }
  }

  return mapWithConcurrency(entries, 6, async ({ id, projectDirName, projectHandle, name, handle }) => {
    let file = null;
    let meta = { cwd: "", summary: "", title: "" };
    let readError = "";
    try {
      file = await handle.getFile();
      meta = await readClaudeMeta(file);
    } catch (error) {
      readError = getErrorMessage(error);
    }
    return {
      id,
      projectDirName,
      projectPath: meta.cwd || decodeProjectDirName(projectDirName),
      title: meta.title || id,
      previewSummary: meta.summary || (readError ? `读取元数据失败: ${readError}` : ""),
      messageCount: null,
      size: file?.size || 0,
      updatedAt: file?.lastModified ? new Date(file.lastModified).toISOString() : null,
      relativePath: `projects/${projectDirName}/${name}`,
      fileHandle: handle,
      parentHandle: projectHandle,
      fileName: name,
      readError,
    };
  });
}

async function readClaudeMeta(file) {
  let cwd = "";
  let summary = "";
  let title = "";
  for await (const line of streamFileLines(file)) {
    const parsed = safeJsonParse(line);
    if (!parsed) continue;
    if (!cwd && typeof parsed.cwd === "string") cwd = parsed.cwd;
    if (!summary && parsed.type === "summary" && typeof parsed.summary === "string") {
      summary = parsed.summary.trim();
    }
    if (!title) title = extractClaudeFirstUserText(parsed);
    if (cwd && (summary || title)) break;
  }
  const label = summary || title;
  return { cwd, summary: label, title: truncateText(label.replace(/\s+/g, " ").trim(), 80) };
}

function extractClaudeFirstUserText(record) {
  if (record.type !== "user" || record.isMeta) return "";
  const body = stripSystemNoise(extractClaudeMessageText(record.message?.content));
  if (!body) return "";
  return truncateText(body.replace(/\s+/g, " ").trim(), 80);
}

function buildClaudeTimeline(text) {
  const items = [];
  for (const line of splitJsonLines(text)) {
    const parsed = safeJsonParse(line);
    if (!parsed) continue;
    if (parsed.type === "user" || parsed.type === "assistant") {
      items.push(...extractClaudeTimelineItems(parsed));
    }
  }
  return items;
}

function extractClaudeTimelineItems(record) {
  const timestamp = record.timestamp || null;
  const content = record.message?.content;
  const items = [];
  if (record.type === "user") {
    if (record.isMeta) return [];
    const text = stripSystemNoise(extractClaudeMessageText(content));
    if (text) items.push(mkItem("user", "user", "用户", timestamp, text));
    return items;
  }
  if (!Array.isArray(content)) {
    const text = extractClaudeMessageText(content);
    if (text) items.push(mkItem("assistant", "assistant", "助手", timestamp, text));
    return items;
  }
  for (const block of content) {
    if (block.type === "text" && block.text?.trim()) {
      items.push(mkItem("assistant", "assistant", "助手", timestamp, block.text.trim()));
    } else if (block.type === "tool_use") {
      items.push(mkItem("system", "toolCall", "工具调用", timestamp, summarizeClaudeToolUse(block)));
    } else if (block.type === "tool_result") {
      const body = summarizeClaudeToolResult(block);
      if (body) items.push(mkItem("system", "toolOutput", "工具输出", timestamp, body));
    }
  }
  return items;
}

function extractClaudeMessageText(content) {
  if (typeof content === "string") return content.trim();
  return joinTextBlocks(content, new Set(["text"]));
}

function summarizeClaudeToolUse(block) {
  const name = block.name || "工具调用";
  let args = "";
  if (block.input && typeof block.input === "object") {
    try {
      args = JSON.stringify(block.input, null, 2);
    } catch {
      args = "";
    }
  } else if (typeof block.input === "string") {
    args = block.input;
  }
  return args.trim() ? `${name}\n${truncateText(args.trim(), TOOL_LIMIT)}` : name;
}

function summarizeClaudeToolResult(block) {
  const content = block.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((item) => (typeof item === "string" ? item : item?.type === "text" ? item.text || "" : ""))
      .filter(Boolean)
      .join("\n");
  }
  text = String(text || "").trim();
  return text ? truncateText(text, TOOL_LIMIT) : "";
}

function decodeProjectDirName(dirName) {
  return dirName.replace(/^c--/i, "C:/").replace(/-/g, "/");
}
