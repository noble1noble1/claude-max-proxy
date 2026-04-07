/**
 * Regression tests for tool name normalization round-trip.
 *
 * The proxy renames OpenClaw tools outbound and must restore original
 * names on inbound Anthropic responses (both JSON and SSE).
 * If restoration breaks, OpenClaw receives unknown tool names and gets
 * stuck in a retry loop (e.g. "Tool sess_spawn not found").
 */

'use strict';

const assert = require('assert');

// ── Pull the maps directly from the proxy ────────────────────────────────────
const { TOOL_RENAMES, TOOL_RENAMES_REVERSE, desanitizeResponseJson, desanitizeSseLine } = require('../index.js');

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeToolUseJson(name) {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu_test', name, input: {} }],
  };
}

function makeSseLine(name) {
  return 'data: ' + JSON.stringify({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'tu_test', name, input: {} },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────
const TOOLS_TO_TEST = [
  ['sessions_spawn',   'sess_spawn'],
  ['sessions_send',    'sess_send'],
  ['sessions_list',    'sess_list'],
  ['sessions_history', 'sess_history'],
  ['sessions_yield',   'sess_yield'],
  ['session_status',   'sess_status'],
  ['memory_search',    'mem_search'],
  ['memory_get',       'mem_get'],
  ['subagents',        'sub_agents'],
  ['cron',             'scheduler'],
];

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${label}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log('\nTool rename map integrity');
for (const [orig, renamed] of TOOLS_TO_TEST) {
  test(`TOOL_RENAMES: ${orig} → ${renamed}`, () => {
    assert.strictEqual(TOOL_RENAMES[orig], renamed, `Expected TOOL_RENAMES['${orig}'] = '${renamed}'`);
  });
  test(`TOOL_RENAMES_REVERSE: ${renamed} → ${orig}`, () => {
    assert.strictEqual(TOOL_RENAMES_REVERSE[renamed], orig, `Expected TOOL_RENAMES_REVERSE['${renamed}'] = '${orig}'`);
  });
}

console.log('\nJSON response desanitization');
for (const [orig, renamed] of TOOLS_TO_TEST) {
  test(`JSON: ${renamed} → ${orig}`, () => {
    const response = makeToolUseJson(renamed);
    const fixed = desanitizeResponseJson(response);
    assert.strictEqual(
      fixed.content[0].name, orig,
      `Expected '${orig}', got '${fixed.content[0].name}'`
    );
  });
}

test('JSON: non-tool names are not modified', () => {
  const response = { type: 'message', content: [{ type: 'text', text: 'hello' }] };
  const fixed = desanitizeResponseJson(response);
  assert.deepStrictEqual(fixed, response);
});

test('JSON: unknown tool names pass through unchanged', () => {
  const response = makeToolUseJson('some_other_tool');
  const fixed = desanitizeResponseJson(response);
  assert.strictEqual(fixed.content[0].name, 'some_other_tool');
});

test('JSON: nested tool_use in array', () => {
  const response = {
    content: [
      { type: 'text', text: 'ok' },
      { type: 'tool_use', name: 'sub_agents', input: {} },
    ],
  };
  const fixed = desanitizeResponseJson(response);
  assert.strictEqual(fixed.content[1].name, 'subagents');
  assert.strictEqual(fixed.content[0].text, 'ok');
});

console.log('\nSSE streaming desanitization');
for (const [orig, renamed] of TOOLS_TO_TEST) {
  test(`SSE: ${renamed} → ${orig}`, () => {
    const line = makeSseLine(renamed);
    const fixed = desanitizeSseLine(line);
    const evt = JSON.parse(fixed.slice(6));
    assert.strictEqual(
      evt.content_block.name, orig,
      `Expected '${orig}', got '${evt.content_block.name}'`
    );
  });
}

test('SSE: non-data lines pass through unchanged', () => {
  const line = 'event: message_start';
  assert.strictEqual(desanitizeSseLine(line), line);
});

test('SSE: [DONE] sentinel passes through unchanged', () => {
  const line = 'data: [DONE]';
  assert.strictEqual(desanitizeSseLine(line), line);
});

test('SSE: invalid JSON passes through unchanged', () => {
  const line = 'data: not-json';
  assert.strictEqual(desanitizeSseLine(line), line);
});

test('SSE: unknown tool names pass through unchanged', () => {
  const line = makeSseLine('some_other_tool');
  const fixed = desanitizeSseLine(line);
  const evt = JSON.parse(fixed.slice(6));
  assert.strictEqual(evt.content_block.name, 'some_other_tool');
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
