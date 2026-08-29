'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  AlertGate,
  ExpiringDeduper,
  ProblemTracker,
  buildNtfyPayload,
  buildQuizPrompt,
  buildSlideIndex,
  classifyAIHttpError,
  detectActiveQuiz,
  extractPresentationId,
  extractProblemIds,
  normalizeEventName,
  normalizeNtfyTopic,
  selectQuizText,
  stableTextHash,
} = require('../src/core.js');

test('normalizeNtfyTopic accepts a private-looking topic and trims whitespace', () => {
  assert.equal(normalizeNtfyTopic('  shy_ykt_a7k2  '), 'shy_ykt_a7k2');
});

test('normalizeNtfyTopic rejects an empty or unsafe topic', () => {
  assert.throws(() => normalizeNtfyTopic('   '), /topic/i);
  assert.throws(() => normalizeNtfyTopic('课堂 提醒'), /topic/i);
  assert.throws(() => normalizeNtfyTopic('test'), /topic/i);
});

test('normalizeEventName accepts common YuKeTang event fields and casing', () => {
  assert.equal(normalizeEventName({ op: 'unlockProblem' }), 'unlockproblem');
  assert.equal(normalizeEventName({ event: 'PUBLISH_PROBLEM' }), 'publishproblem');
  assert.equal(normalizeEventName({ type: 'problem' }), 'problem');
  assert.equal(normalizeEventName({}), '');
});

test('extractPresentationId finds a nested presentation identifier', () => {
  assert.equal(extractPresentationId({ data: { presentation_id: 187654 } }), '187654');
  assert.equal(extractPresentationId({ presentation: 'p-42' }), 'p-42');
  assert.equal(extractPresentationId({ data: { unrelated: 1 } }), '');
});

test('extractProblemIds normalizes nested objects and removes duplicates', () => {
  const message = {
    problem: { prob: 'p-1' },
    unlockedproblem: ['p-2', { sid: 'p-3' }, 'p-2'],
  };

  assert.deepEqual(extractProblemIds(message), ['p-1', 'p-2', 'p-3']);
});

test('ProblemTracker treats the first snapshot as history and reports only later additions', () => {
  const tracker = new ProblemTracker();

  assert.deepEqual(tracker.applySnapshot(['old-a', 'old-b']), []);
  assert.deepEqual(tracker.applySnapshot(['old-a', 'old-b']), []);
  assert.deepEqual(tracker.applySnapshot(['old-a', 'old-b', 'new-c']), ['new-c']);
});

test('ProblemTracker does not let an empty startup snapshot consume the history baseline', () => {
  const tracker = new ProblemTracker();

  assert.deepEqual(tracker.applySnapshot([]), []);
  assert.deepEqual(tracker.applySnapshot(['old-a']), []);
  assert.deepEqual(tracker.applySnapshot(['old-a', 'new-b']), ['new-b']);
});

test('ProblemTracker accepts each realtime problem once and can reset between lessons', () => {
  const tracker = new ProblemTracker();

  assert.equal(tracker.recordRealtime('p-1'), true);
  assert.equal(tracker.recordRealtime('p-1'), false);
  tracker.reset();
  assert.equal(tracker.recordRealtime('p-1'), true);
});

test('ExpiringDeduper suppresses only the same key during its TTL', () => {
  let now = 1_000;
  const deduper = new ExpiringDeduper(5_000, () => now);

  assert.equal(deduper.accept('problem:a'), true);
  assert.equal(deduper.accept('problem:a'), false);
  assert.equal(deduper.accept('problem:b'), true);
  now = 6_001;
  assert.equal(deduper.accept('problem:a'), true);
});

test('buildSlideIndex extracts nested text without treating IDs as question text', () => {
  const index = buildSlideIndex({
    data: {
      slides: [{
        id: 'slide-7',
        index: 7,
        shapes: [
          { id: 'shape-1', Text: '  下列哪项正确？\rA. 甲  ' },
          { children: [{ text: 'B. 乙' }, { text: 'B. 乙' }] },
        ],
      }],
    },
  });

  assert.equal(index.get('slide-7').text, '下列哪项正确？\nA. 甲\nB. 乙');
  assert.equal(index.get('slide-7').index, 7);
});

test('selectQuizText prefers the exact problem and otherwise chooses the latest unrequested slide', () => {
  const slideIndex = new Map([
    ['p-1', { text: '第一题' }],
    ['p-2', { text: '第二题' }],
  ]);

  assert.deepEqual(selectQuizText('p-1', ['p-1', 'p-2'], slideIndex, new Set()), {
    id: 'p-1',
    text: '第一题',
  });
  assert.deepEqual(selectQuizText('', ['p-1', 'p-2'], slideIndex, new Set(['p-2'])), {
    id: 'p-1',
    text: '第一题',
  });
  assert.equal(selectQuizText('', ['p-1', 'p-2'], slideIndex, new Set(['p-1', 'p-2'])), null);
});

test('buildQuizPrompt removes markup and caps untrusted slide text', () => {
  const prompt = buildQuizPrompt(`<b>题干</b>\nA. 甲\nB. 乙${'x'.repeat(5_000)}`);

  assert.match(prompt, /题干/);
  assert.doesNotMatch(prompt, /<b>/);
  assert.ok(prompt.length < 4_000);
});

test('classifyAIHttpError distinguishes configuration errors from retryable outages', () => {
  assert.deepEqual(classifyAIHttpError(401), { message: 'DeepSeek API Key 无效或已过期', retryable: false });
  assert.deepEqual(classifyAIHttpError(429), { message: 'DeepSeek 请求过于频繁，请稍后重试', retryable: true });
  assert.deepEqual(classifyAIHttpError(503), { message: 'DeepSeek 服务暂时不可用', retryable: true });
});

test('buildNtfyPayload uses only the user-configured topic', () => {
  assert.deepEqual(buildNtfyPayload('private_ykt_42', '新题', '请打开课堂'), {
    topic: 'private_ykt_42',
    title: '新题',
    message: '请打开课堂',
    priority: 5,
    tags: ['bell'],
  });
  assert.throws(() => buildNtfyPayload('', '新题', '请打开课堂'), /topic/i);
});

test('core exposes the same API when loaded directly in a browser context', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/core.js'), 'utf8');
  const context = {};

  vm.runInNewContext(source, context);

  assert.equal(typeof context.YKTQuizCore.normalizeNtfyTopic, 'function');
  assert.equal(typeof context.YKTQuizCore.ProblemTracker, 'function');
});

test('detectActiveQuiz evaluates completion markers inside the same candidate only', () => {
  assert.equal(detectActiveQuiz('限时答题\n剩余 30 秒\n提交答案'), '提交答案');
  assert.equal(detectActiveQuiz('限时答题\n作答已结束'), '');
  assert.equal(detectActiveQuiz('课程回顾：老师讲过答题方法'), '');
});

test('stableTextHash ignores whitespace changes but separates different questions', () => {
  assert.equal(stableTextHash('题目 A\nB'), stableTextHash(' 题目A B '));
  assert.notEqual(stableTextHash('题目 A'), stableTextHash('题目 B'));
});

test('AlertGate suppresses DOM and WebSocket copies without swallowing distinct problem IDs', () => {
  let now = 10_000;
  const gate = new AlertGate({ ttlMs: 60_000, crossSourceMs: 5_000, now: () => now });

  assert.equal(gate.accept('dom:question-a', false), true);
  now += 1_000;
  assert.equal(gate.accept('problem:p-1', true), false);
  assert.equal(gate.accept('problem:p-2', true), true);
  assert.equal(gate.accept('dom:question-b', false), false);
  now += 60_001;
  assert.equal(gate.accept('problem:p-1', true), true);
});
