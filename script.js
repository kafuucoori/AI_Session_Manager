function $(id) {
  return document.getElementById(id);
}

const ELEMENT_IDS = [
  "src-claude", "src-codex", "support-hint", "status-badge", "status-text",
  "status-dir", "status-scanned", "pick-btn", "reload-btn", "delete-selected-btn",
  "delete-all-btn", "codex-delete-hint", "age-filter", "sort-select", "project-filter",
  "m-total", "m-group", "m-filtered", "m-size", "m-selected",
  "list-caption", "session-list", "detail-overview", "msg-count", "conv-filter",
  "conversation", "download-btn", "delete-current-btn", "modal", "modal-backdrop",
  "modal-title", "modal-desc", "modal-warning", "modal-cancel", "modal-confirm",
];

function bindElements() {
  for (const id of ELEMENT_IDS) {
    const key = id.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    el[key] = $(id);
  }
}

function initialize() {
  bindElements();
  const supported = "showDirectoryPicker" in window;
  state.source = localStorage.getItem(SOURCE_KEY) === "codex" ? "codex" : "claude";
  el.pickBtn.disabled = true;
  el.supportHint.textContent = supported ? "正在恢复上次目录..." : "请使用最新版 Chrome 或 Edge.";

  if (supported) {
    preloadDirectoryHandles()
      .then(() => { el.supportHint.textContent = ""; })
      .catch((error) => {
        console.warn("无法读取已记住的目录:", error);
        el.supportHint.textContent = "目录记忆不可用，仍可正常手动选择.";
      })
      .finally(() => { el.pickBtn.disabled = false; });
  }

  renderConvFilters();
  el.srcClaude.addEventListener("click", () => switchSource("claude"));
  el.srcCodex.addEventListener("click", () => switchSource("codex"));
  el.pickBtn.addEventListener("click", () => pickDirectory().catch(handleError));
  el.reloadBtn.addEventListener("click", () => scanSessions().catch(handleError));
  el.deleteSelectedBtn.addEventListener("click", () => openConfirm("selected"));
  el.deleteAllBtn.addEventListener("click", () => openConfirm("all"));
  el.ageFilter.addEventListener("change", onFilterChange);
  el.sortSelect.addEventListener("change", onFilterChange);
  el.projectFilter.addEventListener("change", onFilterChange);
  el.sessionList.addEventListener("scroll", onListScroll);
  el.conversation.addEventListener("scroll", onConversationScroll);
  el.downloadBtn.addEventListener("click", () => exportCurrentMarkdown().catch(handleError));
  el.deleteCurrentBtn.addEventListener("click", () => openConfirm("single"));
  el.modalBackdrop.addEventListener("click", closeModal);
  el.modalCancel.addEventListener("click", closeModal);
  el.modalConfirm.addEventListener("click", () => confirmAction().catch(handleError));

  applySourceUi();
  renderEmptyList("未扫描");
  renderDetails(null);
  updateStatus();
}

function switchSource(source) {
  if (state.source === source) return;
  closeModal();
  state.scanReq += 1;
  state.source = source;
  localStorage.setItem(SOURCE_KEY, source);
  state.rootHandle = null;
  state.childDirHandle = null;
  state.sessions = [];
  state.filtered = [];
  state.projects = [];
  state.selectedIds.clear();
  state.timelineCache.clear();
  state.activeId = null;
  state.scannedAt = null;
  state.listVisible = LIST_PAGE;
  el.reloadBtn.disabled = true;
  el.projectFilter.value = "all";
  applySourceUi();
  renderEmptyList("未扫描");
  renderDetails(null);
  updateStatus();
}

function applySourceUi() {
  const codex = isCodex();
  el.srcClaude.classList.toggle("is-active", !codex);
  el.srcCodex.classList.toggle("is-active", codex);
  el.srcClaude.setAttribute("aria-pressed", String(!codex));
  el.srcCodex.setAttribute("aria-pressed", String(codex));
  el.codexDeleteHint.hidden = !codex;
}

async function pickDirectory() {
  const source = state.source;
  try {
    const rootHandle = await window.showDirectoryPicker({
      id: `session-console-${source}`,
      mode: "readwrite",
      startIn: state.rootHandle || state.rememberedHandles.get(source) || "documents",
    });

    let childDirHandle;
    if (source === "codex") {
      childDirHandle = await rootHandle.getDirectoryHandle("sessions");
    } else {
      childDirHandle = await rootHandle.getDirectoryHandle("projects");
    }

    if (state.source !== source) return;
    state.rootHandle = rootHandle;
    state.childDirHandle = childDirHandle;
    state.rememberedHandles.set(source, rootHandle);
    rememberDirectoryHandle(source, rootHandle).catch((error) => {
      console.warn("无法保存所选目录:", error);
      el.supportHint.textContent = "本次目录可正常使用，但浏览器未能记住它.";
    });
    el.reloadBtn.disabled = false;
    await scanSessions();
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (error?.name === "NotFoundError") {
      throw new Error(source === "codex"
        ? "请选择包含 sessions 文件夹的 .codex 目录."
        : "请选择包含 projects 文件夹的 .claude 目录.");
    }
    throw error;
  }
}

async function scanSessions() {
  ensureRoot();
  const reqId = ++state.scanReq;
  const source = state.source;
  const rootHandle = state.rootHandle;
  const childDirHandle = state.childDirHandle;
  setLoading("正在扫描...");

  let sessions;
  if (source === "codex") {
    sessions = await readCodexSessions(rootHandle, childDirHandle);
  } else {
    sessions = await readClaudeSessions(childDirHandle);
  }

  if (reqId !== state.scanReq || source !== state.source) return false;
  state.timelineCache.clear();
  state.sessions = sessions;
  state.projects = buildProjectList(sessions);
  state.scannedAt = new Date();
  state.listVisible = LIST_PAGE;
  renderProjectFilter();
  pruneSelection();
  if (!state.activeId || !sessions.some((session) => session.id === state.activeId)) {
    state.activeId = sessions[0]?.id || null;
  }
  await applyFilters();
  return true;
}

async function getSessionTimeline(session) {
  if (!session.fileHandle) return [];
  const cached = getCachedTimeline(session.id);
  if (cached) return cached;
  const text = await (await session.fileHandle.getFile()).text();
  const timeline = isCodex() ? buildCodexTimeline(text) : buildClaudeTimeline(text);
  session.messageCount = countConversationMessages(timeline);
  session.readError = "";
  cacheTimeline(session.id, timeline);
  return timeline;
}

function onFilterChange() {
  state.listVisible = LIST_PAGE;
  scheduleFilters();
}

function onListScroll() {
  const node = el.sessionList;
  if (node.scrollTop + node.clientHeight < node.scrollHeight - 80) return;
  if (state.listVisible >= state.filtered.length) return;
  const keepTop = node.scrollTop;
  state.listVisible += LIST_PAGE;
  renderList();
  updateStatus();
  node.scrollTop = keepTop;
}

function onConversationScroll() {
  const node = el.conversation;
  if (node.scrollTop + node.clientHeight < node.scrollHeight - 80) return;
  if (state.convVisible >= state.convTimeline.length) return;
  const start = state.convVisible;
  state.convVisible = Math.min(state.convVisible + CONV_PAGE, state.convTimeline.length);
  appendConversationItems(state.convTimeline, start, state.convVisible);
}

function scheduleFilters() {
  window.clearTimeout(state.debounce);
  state.debounce = window.setTimeout(() => applyFilters().catch(handleError), 160);
}

async function applyFilters() {
  const reqId = ++state.filterReq;
  const age = el.ageFilter.value;
  const sort = el.sortSelect.value;
  const project = el.projectFilter.value;
  const now = Date.now();
  const result = [];

  for (const session of state.sessions) {
    if (reqId !== state.filterReq) return;
    if (project !== "all" && session.projectDirName !== project) continue;
    if (age !== "all") {
      const updatedTime = new Date(session.updatedAt || 0).getTime();
      if (!updatedTime) {
        if (age === "older") result.push(session);
        continue;
      }
      const diff = now - updatedTime;
      if (age === "7d" && diff > 7 * 864e5) continue;
      if (age === "30d" && diff > 30 * 864e5) continue;
      if (age === "older" && diff <= 30 * 864e5) continue;
    }
    result.push(session);
  }
  if (reqId !== state.filterReq) return;

  result.sort((left, right) => {
    if (sort === "size-desc") return right.size - left.size;
    if (sort === "title-asc") return left.title.localeCompare(right.title, "zh-CN");
    return new Date(right.updatedAt || 0) - new Date(left.updatedAt || 0);
  });
  state.filtered = result;
  state.listVisible = Math.max(LIST_PAGE, Math.min(state.listVisible, result.length || LIST_PAGE));
  if (!result.some((session) => session.id === state.activeId)) {
    state.activeId = result[0]?.id || null;
  }
  renderList();
  renderDetails(getActiveSession());
  updateStatus();
}

function renderList() {
  el.sessionList.innerHTML = "";
  const visible = getVisibleSessions();
  if (!visible.length) {
    renderEmptyList(state.rootHandle ? "无匹配会话." : "未扫描");
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const session of visible) fragment.appendChild(createSessionNode(session));
  const remaining = state.filtered.length - visible.length;
  if (remaining > 0) {
    const hint = document.createElement("p");
    hint.className = "list-more-hint";
    hint.textContent = `下滑加载更多 (剩余 ${remaining} 个)`;
    fragment.appendChild(hint);
  }
  el.sessionList.appendChild(fragment);
}

function createSessionNode(session) {
  const node = document.createElement("article");
  node.className = "session-item" + (session.id === state.activeId ? " is-active" : "");

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "session-check";
  checkbox.checked = state.selectedIds.has(session.id);
  checkbox.disabled = !isDeletable(session);
  checkbox.setAttribute("aria-label", `选择会话 ${session.title}`);
  checkbox.addEventListener("change", (event) => toggleSelection(session.id, event.target.checked));

  const main = document.createElement("button");
  main.type = "button";
  main.className = "session-main";
  main.innerHTML = `
    <div class="session-row">
      <span class="session-title">${escapeHtml(session.title)}</span>
      <span class="session-size">${escapeHtml(formatBytes(session.size))}</span>
    </div>
    <div class="session-sub">
      <span>${escapeHtml(abbreviateId(session.id))}</span>
      <span>${escapeHtml(formatDateTime(session.updatedAt))}</span>
    </div>
    <div class="session-summary">${escapeHtml(buildSummary(session))}</div>
  `;
  main.addEventListener("click", () => {
    state.activeId = session.id;
    renderList();
    renderDetails(session);
    updateStatus();
  });
  node.append(checkbox, main);
  return node;
}

function renderEmptyList(text) {
  el.sessionList.innerHTML = `<p class="empty-state">${escapeHtml(text)}</p>`;
}

function setLoading(text) {
  el.statusBadge.textContent = "扫描中";
  el.statusBadge.dataset.tone = "warning";
  el.statusText.textContent = text;
  el.reloadBtn.disabled = true;
  renderEmptyList(text);
}

function toggleSelection(id, checked) {
  if (checked) state.selectedIds.add(id);
  else state.selectedIds.delete(id);
  renderList();
  updateStatus();
}

function pruneSelection() {
  const validIds = new Set(state.sessions.filter(isDeletable).map((session) => session.id));
  state.selectedIds.forEach((id) => {
    if (!validIds.has(id)) state.selectedIds.delete(id);
  });
}

function renderDetails(session) {
  state.previewReq += 1;
  state.convVisible = CONV_PAGE;
  if (!session) {
    el.detailOverview.innerHTML = buildOverview(null);
    el.msgCount.textContent = "0";
    el.conversation.innerHTML = `<p class="empty-state">未选择会话</p>`;
    el.downloadBtn.disabled = true;
    el.deleteCurrentBtn.disabled = true;
    return;
  }
  el.detailOverview.innerHTML = buildOverview(session);
  el.downloadBtn.disabled = !isExportable(session);
  el.deleteCurrentBtn.disabled = !isDeletable(session);
  renderConversation(session);
}

function buildOverview(session) {
  const item = (label, value) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
  const messageCount = session?.messageCount == null ? "打开后统计" : String(session.messageCount);
  return (
    item("会话 ID", session ? session.id : "-") +
    item("所属项目", session ? (session.projectPath || "-") : "-") +
    item("消息数", session ? messageCount : "-") +
    item("最后更新", session ? formatDateTime(session.updatedAt) : "-")
  );
}

async function renderConversation(session) {
  const reqId = ++state.previewReq;
  el.conversation.innerHTML = `<p class="empty-state">加载中...</p>`;
  try {
    const hadReadError = Boolean(session.readError);
    const timeline = await getSessionTimeline(session);
    if (reqId !== state.previewReq) return;
    const visible = filterConvTimeline(timeline);
    state.convTimeline = visible;
    state.convVisible = Math.min(CONV_PAGE, visible.length);
    el.msgCount.textContent = String(visible.length);
    el.detailOverview.innerHTML = buildOverview(session);
    if (hadReadError) {
      renderList();
      updateStatus();
    }
    if (!timeline.length) {
      el.conversation.innerHTML = `<p class="empty-state">暂无可显示的对话内容.</p>`;
      return;
    }
    if (!visible.length) {
      el.conversation.innerHTML = `<p class="empty-state">没有匹配的对话块.</p>`;
      return;
    }
    paintConversation(visible);
  } catch (error) {
    if (reqId !== state.previewReq) return;
    session.readError = getErrorMessage(error);
    el.msgCount.textContent = "-";
    el.conversation.innerHTML =
      `<p class="empty-state">当前会话读取失败: ${escapeHtml(session.readError)}</p>`;
    el.detailOverview.innerHTML = buildOverview(session);
    renderList();
    updateStatus();
  }
}

function paintConversation(visible) {
  el.conversation.innerHTML = visible.slice(0, state.convVisible).map(renderConvItem).join("");
}

function appendConversationItems(visible, start, end) {
  const html = visible.slice(start, end).map(renderConvItem).join("");
  if (html) el.conversation.insertAdjacentHTML("beforeend", html);
}

function renderConvItem(item) {
  return `
    <article class="conversation-item ${escapeHtml(item.kind)}">
      <div class="conversation-meta">
        <span class="conversation-role">${escapeHtml(item.roleLabel)}</span>
        <span>${escapeHtml(formatDateTime(item.timestamp))}</span>
      </div>
      <div class="conversation-body">${escapeHtml(item.body)}</div>
    </article>
  `;
}

function renderConvFilters() {
  el.convFilter.innerHTML = FILTER_DEFS.map((filter) => {
    const active = isConvFilterActive(filter.kind);
    return `<button class="chip${active ? " is-active" : ""}" type="button" data-kind="${filter.kind}">${escapeHtml(filter.label)}</button>`;
  }).join("");
  for (const button of el.convFilter.querySelectorAll(".chip")) {
    button.addEventListener("click", () => toggleConvFilter(button.dataset.kind));
  }
}

function isConvFilterActive(kind) {
  if (kind === "all") return state.convFilters.size === FILTER_KINDS.length;
  return state.convFilters.has(kind);
}

function toggleConvFilter(kind) {
  if (kind === "all") {
    state.convFilters = new Set(FILTER_KINDS);
  } else if (state.convFilters.size === FILTER_KINDS.length) {
    state.convFilters = new Set([kind]);
  } else if (state.convFilters.has(kind)) {
    state.convFilters.delete(kind);
  } else {
    state.convFilters.add(kind);
  }
  if (!state.convFilters.size) state.convFilters = new Set(FILTER_KINDS);
  state.convVisible = CONV_PAGE;
  renderConvFilters();
  renderDetails(getActiveSession());
}

function filterConvTimeline(timeline) {
  if (state.convFilters.size === FILTER_KINDS.length) return timeline;
  return timeline.filter((item) => state.convFilters.has(item.filterKind || item.kind));
}

async function exportCurrentMarkdown() {
  const session = getActiveSession();
  if (!session || !isExportable(session)) return;
  const timeline = filterConvTimeline(await getSessionTimeline(session));
  const markdown = buildMarkdown(session, timeline);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${exportBaseName(session)}.md`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportBaseName(session) {
  const raw = `${session.title || session.id}`.replace(/[\\/:*?"<>|]+/g, "_").trim();
  return (raw || session.id).slice(0, 80);
}

function buildMarkdown(session, timeline) {
  const lines = [`# ${session.title || session.id}`, ""];
  lines.push(`- 会话 ID: \`${session.id}\``);
  if (session.projectPath) lines.push(`- 所属项目: ${session.projectPath}`);
  lines.push(`- 来源: ${isCodex() ? "Codex" : "Claude"}`);
  lines.push(`- 消息数: ${session.messageCount ?? countConversationMessages(timeline)}`);
  lines.push(`- 最后更新: ${formatDateTime(session.updatedAt)}`);
  lines.push("");
  for (const item of timeline) {
    lines.push(`## ${item.roleLabel}${item.timestamp ? ` · ${formatDateTime(item.timestamp)}` : ""}`, "");
    if (item.filterKind === "toolCall" || item.filterKind === "toolOutput") {
      lines.push("```text", item.body, "```", "");
    } else {
      lines.push(item.body, "");
    }
  }
  return lines.join("\n");
}

function updateStatus() {
  const totalSize = state.sessions.reduce((sum, session) => sum + (session.size || 0), 0);
  const deletableCount = state.sessions.filter(isDeletable).length;
  const errorCount = state.sessions.filter((session) => session.readError).length;
  setText(el.mTotal, state.sessions.length ? String(state.sessions.length) : "-");
  setText(el.mGroup, state.projects.length ? String(state.projects.length) : "-");
  setText(el.mFiltered, state.sessions.length ? String(state.filtered.length) : "-");
  setText(el.mSize, state.sessions.length ? formatBytes(totalSize) : "-");
  setText(el.mSelected, String(state.selectedIds.size));
  el.statusDir.textContent = state.rootHandle?.name || "-";
  el.statusScanned.textContent = state.scannedAt ? formatDateTime(state.scannedAt.toISOString()) : "-";
  el.statusBadge.textContent = state.rootHandle ? (errorCount ? "部分可用" : "已连接") : "未连接";
  el.statusBadge.dataset.tone = state.rootHandle ? (errorCount ? "warning" : "success") : "";
  el.statusText.textContent = state.rootHandle
    ? `${state.sessions.length} 个会话${errorCount ? `，${errorCount} 个读取异常` : ""}`
    : "未选择目录";
  el.listCaption.textContent = state.filtered.length ? `共 ${state.filtered.length} 个会话` :
    (state.rootHandle ? "0 结果" : "未扫描");
  el.reloadBtn.disabled = !state.rootHandle;
  el.deleteSelectedBtn.disabled = !state.selectedIds.size;
  el.deleteSelectedBtn.hidden = !state.selectedIds.size;
  el.deleteAllBtn.disabled = !deletableCount;
}

function getActiveSession() {
  return state.filtered.find((session) => session.id === state.activeId) || null;
}

function getVisibleSessions() {
  return state.filtered.slice(0, state.listVisible);
}

function buildProjectList(sessions) {
  const map = new Map();
  for (const session of sessions) {
    if (!map.has(session.projectDirName)) {
      map.set(session.projectDirName, { dirName: session.projectDirName, path: session.projectPath, count: 0 });
    }
    map.get(session.projectDirName).count += 1;
  }
  return Array.from(map.values()).sort((left, right) => right.count - left.count);
}

function renderProjectFilter() {
  const prev = el.projectFilter.value;
  const options = ['<option value="all">全部项目</option>'];
  for (const project of state.projects) {
    const label = project.path || project.dirName;
    options.push(`<option value="${escapeHtml(project.dirName)}">${escapeHtml(label)} (${project.count})</option>`);
  }
  el.projectFilter.innerHTML = options.join("");
  el.projectFilter.value = state.projects.some((project) => project.dirName === prev) ? prev : "all";
}

function isDeletable(session) {
  return Boolean(session.parentHandle && session.fileName) ||
    Boolean(isCodex() && (session.orphanState || session.orphanCatalog || session.orphanIndex));
}

function isExportable(session) {
  return Boolean(session.fileHandle);
}

function buildSummary(session) {
  if (session.readError) return `读取异常: ${session.readError}`;
  if (session.orphanState) return "状态库存在, 但源会话文件已丢失.";
  if (session.orphanCatalog) return "Codex 侧边栏目录仍有残留，但底层会话已经丢失.";
  if (session.orphanIndex) return "会话索引存在, 但状态库和源文件均已丢失.";
  if (session.previewSummary) return session.previewSummary;
  return (isCodex() ? session.relativePath : session.projectPath) || "无摘要.";
}

function handleError(error) {
  closeModal();
  state.previewReq += 1;
  const message = getErrorMessage(error);
  if (!state.sessions.length) renderEmptyList(state.rootHandle ? "扫描未完成" : "未扫描");
  else renderList();
  updateStatus();
  showErrorModal(message);
}

function showErrorModal(message) {
  el.modalTitle.textContent = "操作失败";
  el.modalDesc.textContent = "本次操作未完成，未对其他会话执行后续清理.";
  el.modalWarning.textContent = message;
  el.modalCancel.hidden = true;
  el.modalConfirm.textContent = "关闭";
  el.modal.dataset.kind = "error";
  el.modal.hidden = false;
}

if (typeof document !== "undefined") initialize();
