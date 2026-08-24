const SOURCE_KEY = "session-console-source";
const TOOL_LIMIT = 600;
const CONV_PAGE = 30;
const LIST_PAGE = 15;
const TIMELINE_CACHE_LIMIT = 8;
const HANDLE_DB_NAME = "session-console-directory-handles";
const HANDLE_STORE_NAME = "directories";
const FILTER_KINDS = ["user", "assistant", "toolCall", "toolOutput"];
const FILTER_DEFS = [
  { kind: "all", label: "全部" },
  { kind: "user", label: "用户" },
  { kind: "assistant", label: "助手" },
  { kind: "toolCall", label: "工具调用" },
  { kind: "toolOutput", label: "工具输出" },
];

const state = {
  source: "claude",
  rootHandle: null,
  childDirHandle: null,
  timelineCache: new Map(),
  sessions: [],
  filtered: [],
  projects: [],
  selectedIds: new Set(),
  convFilters: new Set(FILTER_KINDS),
  convVisible: CONV_PAGE,
  convTimeline: [],
  activeId: null,
  scannedAt: null,
  listVisible: LIST_PAGE,
  previewReq: 0,
  filterReq: 0,
  scanReq: 0,
  debounce: null,
  pending: null,
  rememberedHandles: new Map(),
};

const el = {};

function isCodex() {
  return state.source === "codex";
}

function mkItem(kind, filterKind, roleLabel, timestamp, body) {
  return { kind, filterKind, roleLabel, timestamp, body };
}

function joinTextBlocks(content, types) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => typeof block === "string" ? block :
      block && types.has(block.type) && typeof block.text === "string" ? block.text : "")
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function stripSystemNoise(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (/^<(command-name|local-command|system-reminder|command-message|command-args)/i.test(value)) {
    return "";
  }
  return value;
}

function getCachedTimeline(id) {
  if (!state.timelineCache.has(id)) return null;
  const timeline = state.timelineCache.get(id);
  state.timelineCache.delete(id);
  state.timelineCache.set(id, timeline);
  return timeline;
}

function cacheTimeline(id, timeline) {
  state.timelineCache.delete(id);
  state.timelineCache.set(id, timeline);
  while (state.timelineCache.size > TIMELINE_CACHE_LIMIT) {
    state.timelineCache.delete(state.timelineCache.keys().next().value);
  }
}

function countConversationMessages(timeline) {
  return timeline.filter((item) => item.kind === "user" || item.kind === "assistant").length;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

function truncateText(text, limit) {
  const value = String(text || "");
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

function abbreviateId(id) {
  return id.length > 18 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function setText(node, value) {
  if (node) node.textContent = value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function extractUuid(fileName) {
  const match = fileName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] || null;
}

function splitJsonLines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function getErrorMessage(error) {
  return error?.message || error?.name || "未知错误";
}

function ensureRoot() {
  if (!state.rootHandle || !state.childDirHandle) {
    throw new Error(isCodex() ? "请选择 .codex 目录." : "请选择 .claude 目录.");
  }
}
