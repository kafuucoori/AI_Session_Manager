// Display helpers only: never execute transcript HTML, JavaScript or tool input.
function conversationCode(text, language = "") {
  return `<div class="code-block">${language ? `<div class="code-label">${escapeHtml(language)}</div>` : ""}` +
    `<pre><code>${escapeHtml(text)}</code></pre></div>`;
}

function conversationDetails(label, html, className = "") {
  return `<details class="message-details ${className}"><summary>${escapeHtml(label)}</summary>${html}</details>`;
}

// A small, escaped Markdown subset. No embedded HTML, images or executable links.
function conversationInline(text) {
  const tokens = [];
  const token = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
  const escaped = escapeHtml(String(text).replace(/\u0000/g, ""));
  return escaped.replace(/`([^`]+)`/g, (_, code) => token(`<code>${code}</code>`))
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_, label, href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    .replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
}

function conversationMarkdown(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let list = [];
  let listType = "";
  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map(conversationInline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) html.push(`<${listType}>${list.map((line) => `<li>${conversationInline(line)}</li>`).join("")}</${listType}>`);
    list = [];
    listType = "";
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      flushParagraph(); flushList();
      const code = [];
      const close = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (++i < lines.length && !close.test(lines[i])) code.push(lines[i]);
      html.push(conversationCode(code.join("\n"), fence[2].trim()));
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const bullet = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (!line.trim() || heading || bullet || /^>\s?/.test(line)) flushParagraph();
    if (!bullet) flushList();
    if (!line.trim()) continue;
    if (heading) html.push(`<h4>${conversationInline(heading[1])}</h4>`);
    else if (bullet) {
      const type = /^\s*\d/.test(line) ? "ol" : "ul";
      if (listType && listType !== type) flushList();
      listType = type; list.push(bullet[1]);
    } else if (/^>\s?/.test(line)) html.push(`<blockquote>${conversationInline(line.replace(/^>\s?/, ""))}</blockquote>`);
    else paragraph.push(line);
  }
  flushParagraph(); flushList();
  return `<div class="message-prose">${html.join("")}</div>`;
}

function conversationUserParts(body) {
  const contexts = [];
  const labels = {
    environment_context: "运行环境", external_codex_apps_open_page: "页面上下文",
    turn_aborted: "中断信息", system_reminder: "系统补充",
  };
  let request = String(body).trim();
  // Only unwrap leading metadata. Tags quoted inside a user's prose/code stay literal.
  const envelope = /^<(environment_context|external_codex_apps_open_page|turn_aborted|system_reminder)\b[^>]*>([\s\S]*?)<\/\1>\s*/;
  let context;
  while ((context = envelope.exec(request))) {
    contexts.push({ label: labels[context[1]], body: context[2].trim() });
    request = request.slice(context[0].length).trim();
  }
  const marker = /^[ \t]*#{1,6}[ \t]+(?:My request|我的请求|用户请求)[ \t]*[:：][ \t]*(.*)$/mi.exec(request);
  if (marker) {
    const prefix = request.slice(0, marker.index).trim();
    if (prefix) contexts.push({ label: "附件与补充信息", body: prefix });
    request = [marker[1], request.slice(marker.index + marker[0].length)].filter(Boolean).join("\n").trim();
  } else if (/^#\s*Files mentioned by the user:/i.test(request)) {
    contexts.push({ label: "附件与补充信息", body: request });
    request = "";
  }
  return { request, contexts };
}

function conversationUser(body) {
  return conversationUserGroup([{ body }]);
}

function conversationUserGroup(items) {
  const parts = items.map((item) => conversationUserParts(item.body));
  const requests = parts.map((part) => part.request).filter(Boolean);
  const contexts = parts.flatMap((part) => part.contexts);
  const questions = requests.map((request) => `<div class="user-request">${conversationMarkdown(request)}</div>`).join("");
  if (!contexts.length) return questions;
  const contextHtml = contexts.map((part) => `<section class="user-context-section"><h4>${escapeHtml(part.label)}</h4>` +
    (part.label === "附件与补充信息" ? conversationMarkdown(part.body) : conversationCode(part.body)) + "</section>").join("");
  const originals = items.map((item, index) => conversationCode(item.body, items.length > 1 ? `原始消息 ${index + 1}` : "")).join("");
  return questions + conversationDetails(`上下文与其它细节（${contexts.length} 项）`,
    contextHtml + conversationDetails("查看原始消息", originals, "raw-message"), "user-context");
}

function isConversationTool(item) {
  return item.filterKind === "toolCall" || item.filterKind === "toolOutput";
}

// Group before filtering so a hidden user/assistant message still separates tool runs.
// Raw timeline items stay intact for exports and message counts.
function conversationDisplayTimeline(timeline, filters) {
  const groups = [];
  for (let index = 0; index < timeline.length;) {
    const first = timeline[index];
    if (isConversationTool(first)) {
      const items = [];
      while (index < timeline.length && isConversationTool(timeline[index])) items.push(timeline[index++]);
      const visible = items.filter((item) => filters.has(item.filterKind));
      if (visible.length) groups.push({ kind: "system", displayType: "toolGroup", items: visible, timestamp: first.timestamp });
    } else if (first.filterKind === "user") {
      const items = [];
      while (index < timeline.length && timeline[index].filterKind === "user") items.push(timeline[index++]);
      if (filters.has("user")) {
        const question = items.find((item) => conversationUserParts(item.body).request);
        groups.push({ ...first, displayType: "userGroup", items, timestamp: question?.timestamp || first.timestamp });
      }
    } else {
      if (filters.has(first.filterKind || first.kind)) groups.push(first);
      index += 1;
    }
  }
  return groups;
}

function conversationToolGroup(item) {
  const calls = item.items.filter((entry) => entry.filterKind === "toolCall");
  const outputs = item.items.length - calls.length;
  const names = [...new Set(calls.map((entry) => entry.toolName || (entry.rawBody || entry.body).split("\n")[0]))];
  const label = names.slice(0, 2).join("、") + (names.length > 2 ? ` 等 ${names.length} 种工具` : "");
  return `<details class="conversation-item tool-group"><summary class="tool-group-summary">` +
    `<span class="tool-group-title">工具活动<span class="tool-group-count">${calls.length} 次调用 · ${outputs} 条输出</span></span>` +
    (label ? `<span class="tool-group-names">${escapeHtml(label)}</span>` : "") +
    `</summary><div class="tool-group-body">${item.items.map((entry) => renderConvItem(entry)).join("")}</div></details>`;
}

function conversationJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function conversationToolCall(item) {
  const raw = item.rawBody || item.body;
  const newline = raw.indexOf("\n");
  const name = item.toolName || (newline < 0 ? raw : raw.slice(0, newline));
  const input = item.toolInput ?? (newline < 0 ? "" : raw.slice(newline + 1));
  const data = conversationJson(input);
  let html = `<div class="tool-name">${escapeHtml(name)}</div>`;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const command = data.cmd ?? data.command;
    const directory = data.workdir ?? data.cwd;
    if (directory) html += `<div class="tool-directory"><span>工作目录</span><code>${escapeHtml(directory)}</code></div>`;
    if (typeof command === "string") html += conversationCode(command, "命令");
    const rest = Object.fromEntries(Object.entries(data).filter(([key]) => !["cmd", "command", "cwd", "workdir"].includes(key)));
    if (Object.keys(rest).length) html += conversationCode(JSON.stringify(rest, null, 2), "参数");
    if (!command && !directory && !Object.keys(rest).length) html += conversationCode(JSON.stringify(data, null, 2), "参数");
  } else if (input) {
    // Read JSON string literals in common exec wrappers without evaluating JS.
    if (typeof input === "string" && /tools\.exec_command\s*\(/.test(input)) {
      const commands = [...input.matchAll(/(?:\b(?:cmd|command)|"(?:cmd|command)")\s*:\s*("(?:\\.|[^"\\])*")/g)]
        .map((match) => conversationJson(match[1])).filter((value) => typeof value === "string");
      const directory = input.match(/(?:\b(?:workdir|cwd)|"(?:workdir|cwd)")\s*:\s*("(?:\\.|[^"\\])*")/);
      if (directory && commands.length === 1) html += `<div class="tool-directory"><span>工作目录</span><code>${escapeHtml(conversationJson(directory[1]))}</code></div>`;
      for (const command of commands) html += conversationCode(command, "命令片段");
      if (commands.length) return html + conversationDetails("查看完整调用代码", conversationCode(input, "JavaScript"));
    }
    html += conversationCode(typeof input === "string" ? input : JSON.stringify(input, null, 2),
      /(?:^|\.)(?:exec|js)$/.test(name) ? "JavaScript" : "输入");
  }
  return html + conversationDetails("查看原始调用", conversationCode(raw), "raw-message");
}

// Peel common transport envelopes; JSON.parse only, never eval tool scripts.
function conversationOutputValue(raw) {
  let value = raw;
  const metadata = {};
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      const parsed = conversationJson(trimmed);
      if (parsed !== null) { value = parsed; continue; }
      const marker = trimmed.match(/(?:^|\n)Output:\s*\n/);
      if (marker) { value = trimmed.slice(marker.index + marker[0].length); continue; }
      break;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) break;
    for (const key of ["exit_code", "wall_time_seconds", "session_id"]) {
      if (value[key] !== undefined && value[key] !== null) metadata[key] = value[key];
    }
    if (typeof value.output === "string") value = value.output;
    else if (Array.isArray(value.content) && value.content.every((part) => part?.type === "text" && typeof part.text === "string")) {
      value = value.content.map((part) => part.text).join("\n");
    } else break;
  }
  return { text: typeof value === "string" ? value : JSON.stringify(value, null, 2), metadata };
}

function conversationToolOutput(item) {
  const raw = item.rawBody || item.body;
  const { text, metadata } = conversationOutputValue(raw);
  const badges = [];
  if (metadata.exit_code !== undefined) badges.push(`<span class="tool-status ${metadata.exit_code === 0 ? "is-success" : "is-error"}">退出码 ${escapeHtml(metadata.exit_code)}</span>`);
  if (metadata.wall_time_seconds !== undefined) badges.push(`<span class="tool-status">耗时 ${escapeHtml(metadata.wall_time_seconds)} 秒</span>`);
  if (metadata.session_id !== undefined) badges.push(`<span class="tool-status">进程会话 ${escapeHtml(metadata.session_id)}</span>`);
  const long = text.length > 1800 || text.split("\n").length > 18;
  const preview = long ? text.slice(0, 1800).split("\n").slice(0, 12).join("\n") : text;
  return (badges.length ? `<div class="tool-statuses">${badges.join("")}</div>` : "") +
    conversationCode(preview, "输出") +
    (long ? conversationDetails(`展开完整输出（${text.length.toLocaleString()} 字符）`, conversationCode(text)) : "") +
    (raw !== text ? conversationDetails("查看原始工具输出", conversationCode(raw), "raw-message") : "");
}

function renderConversationBody(item) {
  if (item.displayType === "userGroup") return conversationUserGroup(item.items);
  if (item.filterKind === "user") return conversationUser(item.body);
  if (item.filterKind === "toolCall") return conversationToolCall(item);
  if (item.filterKind === "toolOutput") return conversationToolOutput(item);
  return `<div class="message-plain">${escapeHtml(item.body)}</div>`;
}
