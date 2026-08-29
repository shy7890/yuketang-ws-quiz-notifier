(function exposeCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.YKTQuizCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createCore() {
  'use strict';

function normalizeNtfyTopic(value) {
  const topic = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(topic)) {
    throw new Error('ntfy topic must be 8-64 characters using letters, numbers, _ or -');
  }
  return topic;
}

function normalizeIdentifier(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim();
  }
  return '';
}

function normalizeEventName(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const value = payload.op ?? payload.event ?? payload.type ?? payload.action ?? '';
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findNestedIdentifier(payload, acceptedKeys, maxDepth = 5) {
  const seen = new Set();

  function visit(value, depth) {
    if (!value || typeof value !== 'object' || depth > maxDepth || seen.has(value)) return '';
    seen.add(value);

    for (const [key, child] of Object.entries(value)) {
      if (acceptedKeys.has(key)) {
        const identifier = normalizeIdentifier(child);
        if (identifier) return identifier;
      }
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') {
        const found = visit(child, depth + 1);
        if (found) return found;
      }
    }
    return '';
  }

  return visit(payload, 0);
}

function extractPresentationId(payload) {
  return findNestedIdentifier(
    payload,
    new Set(['presentation', 'pres', 'presentation_id', 'presentationId']),
  );
}

function extractProblemIds(payload) {
  const result = [];
  const identifiers = new Set();
  const seen = new Set();
  const directIdKeys = new Set(['prob', 'sid', 'problem_id', 'problemId']);
  const problemContainerKeys = new Set(['problem', 'unlockedproblem', 'unlockedProblem']);

  function add(value) {
    const identifier = normalizeIdentifier(value);
    if (identifier && !identifiers.has(identifier)) {
      identifiers.add(identifier);
      result.push(identifier);
    }
  }

  function visit(value, parentKey = '', depth = 0) {
    if (depth > 6 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (problemContainerKeys.has(parentKey)) add(item);
        if (item && typeof item === 'object') visit(item, parentKey, depth + 1);
      }
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) {
      if (problemContainerKeys.has(parentKey)) add(value);
      return;
    }
    seen.add(value);

    for (const [key, child] of Object.entries(value)) {
      if (directIdKeys.has(key)) add(child);
      if (problemContainerKeys.has(key)) add(child);
      if (child && typeof child === 'object') visit(child, key, depth + 1);
    }
  }

  visit(payload);
  return result;
}

class ProblemTracker {
  constructor() {
    this.reset();
  }

  applySnapshot(problemIds) {
    const current = Array.from(new Set((problemIds || []).map(normalizeIdentifier).filter(Boolean)));
    if (!this.initialized) {
      if (current.length === 0) return [];
      current.forEach((id) => this.known.add(id));
      this.initialized = true;
      return [];
    }

    const additions = current.filter((id) => !this.known.has(id));
    current.forEach((id) => this.known.add(id));
    return additions;
  }

  recordRealtime(problemId) {
    const identifier = normalizeIdentifier(problemId);
    if (!identifier || this.known.has(identifier)) return false;
    this.known.add(identifier);
    return true;
  }

  reset() {
    this.initialized = false;
    this.known = new Set();
  }
}

class ExpiringDeduper {
  constructor(ttlMs, now = () => Date.now()) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be positive');
    this.ttlMs = ttlMs;
    this.now = now;
    this.entries = new Map();
  }

  accept(key) {
    const normalizedKey = String(key ?? '').trim();
    if (!normalizedKey) return false;
    const currentTime = this.now();
    const previousTime = this.entries.get(normalizedKey);
    if (previousTime !== undefined && currentTime - previousTime < this.ttlMs) return false;
    this.entries.set(normalizedKey, currentTime);
    return true;
  }

  clear() {
    this.entries.clear();
  }
}

class AlertGate {
  constructor({ ttlMs, crossSourceMs, now = () => Date.now() }) {
    this.now = now;
    this.crossSourceMs = crossSourceMs;
    this.deduper = new ExpiringDeduper(ttlMs, now);
    this.lastGenericAt = Number.NEGATIVE_INFINITY;
    this.lastProblemAt = Number.NEGATIVE_INFINITY;
  }

  accept(key, hasProblemId) {
    if (!this.deduper.accept(key)) return false;
    const currentTime = this.now();
    if (hasProblemId) {
      if (currentTime - this.lastGenericAt < this.crossSourceMs) {
        this.lastGenericAt = Number.NEGATIVE_INFINITY;
        return false;
      }
      this.lastProblemAt = currentTime;
      return true;
    }
    if (currentTime - this.lastProblemAt < this.crossSourceMs) return false;
    this.lastGenericAt = currentTime;
    return true;
  }

  clear() {
    this.deduper.clear();
    this.lastGenericAt = Number.NEGATIVE_INFINITY;
    this.lastProblemAt = Number.NEGATIVE_INFINITY;
  }
}

function normalizeTextFragment(value) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function extractTextFragments(value) {
  const fragments = [];
  const fragmentSet = new Set();
  const seen = new Set();
  const textKeys = new Set(['Text', 'text', 'content', 'plainText', 'plain_text']);

  function add(fragment) {
    const normalized = normalizeTextFragment(fragment);
    if (normalized && !fragmentSet.has(normalized)) {
      fragmentSet.add(normalized);
      fragments.push(normalized);
    }
  }

  function visit(child, parentKey = '', depth = 0) {
    if (depth > 10 || child === null || child === undefined) return;
    if (typeof child === 'string') {
      if (textKeys.has(parentKey)) add(child);
      return;
    }
    if (typeof child !== 'object' || seen.has(child)) return;
    seen.add(child);
    if (Array.isArray(child)) {
      child.forEach((item) => visit(item, parentKey, depth + 1));
      return;
    }
    for (const [key, nested] of Object.entries(child)) {
      visit(nested, key, depth + 1);
    }
  }

  visit(value);
  return fragments;
}

function buildSlideIndex(presentationData) {
  const slides = presentationData?.data?.slides ?? presentationData?.slides ?? [];
  const index = new Map();
  if (!Array.isArray(slides)) return index;

  slides.forEach((slide, position) => {
    const id = normalizeIdentifier(slide?.id ?? slide?.sid);
    if (!id) return;
    const fragments = extractTextFragments(slide?.shapes ?? slide);
    const text = fragments.join('\n').slice(0, 4_000);
    if (!text) return;
    index.set(id, {
      id,
      index: slide?.index ?? position,
      text,
    });
  });
  return index;
}

function selectQuizText(problemId, unlockedProblemIds, slideIndex, requestedIds = new Set()) {
  const exactId = normalizeIdentifier(problemId);
  if (exactId && !requestedIds.has(exactId)) {
    const exactSlide = slideIndex.get(exactId);
    if (exactSlide?.text) return { id: exactId, text: exactSlide.text };
  }

  const candidates = Array.from(unlockedProblemIds || []).map(normalizeIdentifier).filter(Boolean);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const id = candidates[index];
    if (requestedIds.has(id)) continue;
    const slide = slideIndex.get(id);
    if (slide?.text) return { id, text: slide.text };
  }
  return null;
}

function buildQuizPrompt(quizText) {
  const cleanedText = normalizeTextFragment(
    String(quizText ?? '').replace(/<[^>]*>/g, ' '),
  ).slice(0, 2_500);
  if (cleanedText.length < 3) throw new Error('quiz text is empty');

  return `你是课堂选择题参考助手。请严格依据给出的题干和选项作答：
1. 先识别题型、题干和全部选项。
2. 只能选择题目中真实存在的选项，不得补造选项。
3. 单选题只给一个选项；多选题给出全部选项；判断题只回答“正确”或“错误”。
4. 信息不足时明确回答“无法判断”，不要猜测。
5. 输出第一行写“参考答案：…”，第二行用一句话说明理由。

幻灯片文本：
${cleanedText}`;
}

function classifyAIHttpError(status) {
  if (status === 401 || status === 403) {
    return { message: 'DeepSeek API Key 无效或已过期', retryable: false };
  }
  if (status === 402) {
    return { message: 'DeepSeek 账户余额不足', retryable: false };
  }
  if (status === 429) {
    return { message: 'DeepSeek 请求过于频繁，请稍后重试', retryable: true };
  }
  if (status >= 500 || status === 0) {
    return { message: 'DeepSeek 服务暂时不可用', retryable: true };
  }
  return { message: `DeepSeek 请求失败（HTTP ${status}）`, retryable: false };
}

function buildNtfyPayload(topic, title, message) {
  return {
    topic: normalizeNtfyTopic(topic),
    title: String(title ?? '').trim() || '雨课堂提醒',
    message: String(message ?? '').trim(),
    priority: 5,
    tags: ['bell'],
  };
}

function detectActiveQuiz(candidateText) {
  const text = String(candidateText ?? '');
  const finishedMarkers = ['作答已结束', '答题已结束', '已提交', '查看答案'];
  if (finishedMarkers.some((marker) => text.includes(marker))) return '';
  const activeKeywords = ['提交答案', '请作答', '限时答题', '答题时间', '剩余时间', '开始答题', '最多可选', '投票'];
  return activeKeywords.find((keyword) => text.includes(keyword)) || '';
}

function stableTextHash(value) {
  const text = String(value ?? '').replace(/\s+/g, '').slice(0, 1_000);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

  return Object.freeze({
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
  });
});
