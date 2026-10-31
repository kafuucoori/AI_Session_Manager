const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ console });
for (const name of ['core.js', 'claude.js', 'codex.js', 'conversation.js', 'script.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context);
}
const run = (code) => vm.runInContext(code, context);
const user = (body) => context.renderConversationBody({ filterKind: 'user', body });

test('user request is prominent while context and attachments remain in disclosures', () => {
  const html = user('<environment_context><cwd>C:/demo</cwd></environment_context>\n# Files mentioned by the user:\n## demo.js\n# My request:\n请修改 **标题**\n\n- 保留说明');
  assert.ok(html.indexOf('请修改 <strong>标题</strong>') < html.indexOf('<details'));
  assert.match(html, /<li>保留说明<\/li>/);
  assert.match(html, /<summary>上下文与其它细节（2 项）<\/summary>/);
  assert.match(html, /<h4>运行环境<\/h4>/);
  assert.match(html, /<h4>附件与补充信息<\/h4>/);
  assert.match(html, /查看原始消息/);
  assert.doesNotMatch(html, /<environment_context>/);
});

test('context-only messages are compact and unknown XML stays visible', () => {
  const html = user('<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>');
  assert.match(html, /^<details/);
  assert.match(html, /页面上下文/);
  assert.match(user('<custom>keep me</custom>'), /&lt;custom&gt;keep me/);
});

test('Markdown fences preserve literal code, Windows paths and whitespace', () => {
  const html = user('# 标题\n\n```powershell\n  Get-Content C:\\demo\\file.txt\n<script>bad()</script>\n```\n\n`**literal**`');
  assert.match(html, /<h4>标题<\/h4>/);
  assert.match(html, /  Get-Content C:\\demo\\file.txt/);
  assert.match(html, /<code>\*\*literal\*\*<\/code>/);
  assert.doesNotMatch(html, /<script>/);
  const quoted = user('请解释这个示例：\n```xml\n<environment_context>keep this</environment_context>\n```');
  assert.doesNotMatch(quoted, /<summary>运行环境/);
  assert.match(quoted, /&lt;environment_context&gt;keep this/);
});

test('transcript HTML and executable links never become active markup', () => {
  const html = user('<img src=x onerror=alert(1)>\n[bad](javascript:alert(1))\n[ok](https://example.com/"onclick="evil)');
  assert.doesNotMatch(html, /<img|<script|href="javascript:| onclick="/i);
  assert.match(html, /&lt;img/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('direct shell tools show directory, decoded command and remaining parameters', () => {
  const html = context.conversationToolCall({ body: 'exec_command', toolName: 'exec_command', toolInput: JSON.stringify({ cmd: 'echo first\necho second', workdir: 'C:/demo', max_output_tokens: 6000 }) });
  assert.match(html, /工作目录/);
  assert.match(html, /echo first\necho second/);
  assert.match(html, /max_output_tokens/);
});

test('exec wrappers extract string literals without executing JavaScript', () => {
  const input = 'throw new Error("must never execute"); text(await tools.exec_command({cmd:"rg --files",workdir:"C:/demo"}));';
  const html = context.conversationToolCall({ body: 'exec\n' + input, toolName: 'exec', toolInput: input });
  assert.match(html, /命令片段/);
  assert.match(html, /rg --files/);
  assert.match(html, /查看完整调用代码/);
  const quoted = context.conversationToolCall({ body: 'exec\nawait tools.exec_command({"cmd":"echo quoted","workdir":"C:/demo"})' });
  assert.match(quoted, /命令片段/);
  assert.match(quoted, /echo quoted/);
});

test('transport envelopes yield readable output, exit status and elapsed time', () => {
  const raw = 'Script completed\nWall time 6 seconds\nOutput:\n' + JSON.stringify({ exit_code: 0, wall_time_seconds: 6, output: 'first\nsecond\n中文' });
  const html = context.conversationToolOutput({ body: raw });
  assert.match(html, /退出码 0/);
  assert.match(html, /耗时 6 秒/);
  assert.match(html, /first\nsecond\n中文/);
  assert.match(html, /查看原始工具输出/);
});

test('long output is available in full and tool output stays escaped', () => {
  const body = Array.from({ length: 50 }, (_, i) => 'line ' + i).join('\n') + '\n<script>bad</script>';
  const html = context.conversationToolOutput({ body });
  assert.match(html, /展开完整输出/);
  assert.match(html, /line 49/);
  assert.doesNotMatch(html, /<script>/);
});

test('Codex retains full display data beyond export summary limit', () => {
  const output = 'x'.repeat(2200) + 'END';
  context.record = { type: 'response_item', payload: { type: 'function_call_output', output } };
  const item = run('extractCodexResponseItems(record)[0]');
  assert.equal(item.rawBody, output);
  assert.ok(item.body.length < output.length);
  assert.match(context.renderConversationBody(item), /END/);
});

test('Claude tool results in user messages retain the full readable output', () => {
  const output = 'x'.repeat(2200) + 'END';
  context.record = { type: 'user', message: { content: [{ type: 'tool_result', content: output }] } };
  const items = run('extractClaudeTimelineItems(record)');
  assert.equal(items.length, 1);
  assert.equal(items[0].filterKind, 'toolOutput');
  assert.equal(items[0].rawBody, output);
});

const allFilters = new Set(['user', 'assistant', 'toolCall', 'toolOutput']);
const entry = (filterKind, body) => ({ kind: filterKind === 'user' ? 'user' : 'system', filterKind, roleLabel: filterKind, body });
const display = (items, filters = allFilters) => context.conversationDisplayTimeline(items, filters);

test('consecutive calls and outputs form one collapsed group in original order', () => {
  const items = [entry('toolCall', 'first'), entry('toolOutput', 'result one'), entry('toolCall', 'second'), entry('toolOutput', 'result two')];
  const groups = display(items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].displayType, 'toolGroup');
  assert.deepEqual(Array.from(groups[0].items), items);
  const html = context.renderConvItem(groups[0]);
  assert.match(html, /2 次调用 · 2 条输出/);
  assert.match(html, /^<details class="conversation-item tool-group">/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  const content = html.slice(html.indexOf('<div class="tool-group-body">'));
  assert.ok(content.indexOf('result one') < content.indexOf('second'));
});

test('hidden assistant and user messages still separate tool runs', () => {
  const groups = display([
    entry('toolCall', 'one'), entry('assistant', 'progress'), entry('toolOutput', 'two'),
    entry('user', 'next question'), entry('toolCall', 'three'),
  ], new Set(['toolCall', 'toolOutput']));
  assert.equal(groups.length, 3);
  assert.deepEqual(Array.from(groups, (group) => group.items.length), [1, 1, 1]);
});

test('filtering calls or outputs updates group contents and counts', () => {
  const timeline = [entry('toolCall', 'first'), entry('toolOutput', 'answer'), entry('toolCall', 'second')];
  const outputs = display(timeline, new Set(['toolOutput']));
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].items.length, 1);
  assert.match(context.renderConvItem(outputs[0]), /0 次调用 · 1 条输出/);
  assert.equal(display(timeline, new Set(['user'])).length, 0);
});

test('tool groups spanning the old 30-item page boundary are not split', () => {
  const items = Array.from({ length: 65 }, (_, index) => entry(index % 2 ? 'toolOutput' : 'toolCall', 'step ' + index));
  const groups = display(items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 65);
  assert.match(context.renderConvItem(groups[0]), /step 64/);
});

test('consecutive user metadata and question become one question-first card', () => {
  const items = [
    entry('user', '<environment_context><cwd>C:/demo</cwd></environment_context>'),
    entry('user', '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'),
    entry('user', '# Files mentioned by the user:\n## demo.js\n\n# My request:\n如何修复分支删除？'),
  ];
  items[2].timestamp = '2026-10-31T01:00:00Z';
  const groups = display(items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].displayType, 'userGroup');
  assert.equal(groups[0].timestamp, items[2].timestamp);
  const html = context.renderConvItem(groups[0]);
  assert.doesNotMatch(html, /用户上下文/);
  assert.ok(html.indexOf('如何修复分支删除？') < html.indexOf('<details'));
  assert.match(html, /上下文与其它细节（3 项）/);
  assert.match(html, /原始消息 3/);
});

test('question markers support inline text and Chinese headings', () => {
  for (const marker of ['# My request: 问题正文', '## 我的请求：问题正文', '# 用户请求: 问题正文']) {
    const html = user('# Files mentioned by the user:\n## demo.js\n' + marker);
    assert.ok(html.indexOf('问题正文') < html.indexOf('<details'));
  }
});

test('display grouping does not mutate raw timeline, export data or cross assistant boundaries', () => {
  const timeline = [entry('user', 'first'), entry('assistant', 'answer'), entry('user', 'second'), entry('toolCall', 'tool'), entry('toolOutput', 'output')];
  const before = JSON.stringify(timeline);
  const groups = display(timeline);
  assert.equal(groups.length, 4);
  assert.equal(JSON.stringify(timeline), before);
  context.timelineForExport = timeline;
  assert.equal(run('filterConvTimeline(timelineForExport).length'), 5);
  assert.ok(timeline.every((item) => !item.displayType));
});
