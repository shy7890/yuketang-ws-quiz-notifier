// ==UserScript==
// @name         雨课堂答题监控提醒
// @namespace    https://github.com/shy7890/yuketang-ws-quiz-notifier
// @version      3.7.1
// @description  WebSocket + DOM 双通道监控雨课堂课堂题目，支持声音、桌面通知、标题闪烁、ntfy 手机推送和 DeepSeek 参考答案。
// @author       Shy
// @match        *://changjiang.yuketang.cn/*
// @match        *://*.yuketang.cn/*
// @match        *://yuketang.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @connect      ntfy.sh
// @run-at       document-start
// @updateURL    https://github.com/shy7890/yuketang-ws-quiz-notifier/releases/latest/download/yuketang-quiz-notifier.user.js
// @downloadURL  https://github.com/shy7890/yuketang-ws-quiz-notifier/releases/latest/download/yuketang-quiz-notifier.user.js
// @homepageURL  https://github.com/shy7890/yuketang-ws-quiz-notifier
// @supportURL   https://github.com/shy7890/yuketang-ws-quiz-notifier/issues
// @license      MIT
// ==/UserScript==

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

(function startQuizNotifier() {
  'use strict';

  const core = globalThis.YKTQuizCore;
  if (!core) {
    console.error('[YKT监控] 核心模块未加载，脚本已停止。');
    return;
  }

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
  } = core;

  const pageWindow = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  const VERSION = '3.7.0';
  const CONFIG = Object.freeze({
    domIntervalMs: 3_000,
    domDedupeMs: 90_000,
    alertDedupeMs: 60_000,
    crossSourceDedupeMs: 5_000,
    aiWaitAttempts: 8,
    aiWaitIntervalMs: 1_000,
    titleFlashMs: 20_000,
  });
  const STORAGE = Object.freeze({
    aiKey: 'ykt_notifier_ai_key',
    aiModel: 'ykt_notifier_ai_model',
    ntfyTopic: 'ykt_notifier_ntfy_topic',
    managed: 'ykt_notifier_managed',
    debug: 'ykt_notifier_debug',
  });

  const settings = {
    aiKey: String(GM_getValue(STORAGE.aiKey, GM_getValue('ai_api_key', '')) || ''),
    aiModel: String(GM_getValue(STORAGE.aiModel, GM_getValue('ai_model', 'deepseek-chat')) || 'deepseek-chat'),
    ntfyTopic: String(GM_getValue(STORAGE.ntfyTopic, '') || ''),
    managed: Boolean(GM_getValue(STORAGE.managed, false)),
    debug: Boolean(GM_getValue(STORAGE.debug, false)),
  };
  if (!['deepseek-chat', 'deepseek-reasoner'].includes(settings.aiModel)) {
    settings.aiModel = 'deepseek-chat';
  }

  const state = {
    activeAlert: false,
    aiInFlight: new Map(),
    aiRequestedIds: new Set(),
    alertCount: 0,
    alertGate: new AlertGate({ ttlMs: CONFIG.alertDedupeMs, crossSourceMs: CONFIG.crossSourceDedupeMs }),
    audioContext: null,
    currentLessonKey: '',
    currentPresentationId: '',
    domCheckCount: 0,
    domDeduper: new ExpiringDeduper(CONFIG.domDedupeMs),
    domPaused: false,
    domTimer: null,
    fetchAttempts: new Map(),
    fetchingPresentations: new Set(),
    generation: 0,
    lastQuiz: null,
    mutationDebounceTimer: null,
    mutationObserver: null,
    panel: null,
    problemTracker: new ProblemTracker(),
    slideIndex: new Map(),
    titleBeforeFlash: '',
    titleFlashTimer: null,
    titleStopTimer: null,
    unlockedProblemIds: [],
  };

  const REALTIME_PROBLEM_EVENTS = new Set(['unlockproblem', 'sendproblem', 'publishproblem']);
  const SKIP_PATHS = ['/student-lesson-report', '/lesson-report', '/homework', '/user-center', '/course-manage', '/web/log'];
  const QUIZ_CONTAINER_SELECTORS = [
    '.el-dialog',
    '.el-message-box',
    '[role="dialog"]',
    '[class*="quiz"]',
    '[class*="problem"]',
    '[class*="modal"]',
    '[class*="popup"]',
  ];

  function debugLog(...args) {
    if (settings.debug) console.debug('[YKT监控]', ...args);
  }

  function warnLog(...args) {
    console.warn('[YKT监控]', ...args);
  }

  function saveSetting(key, value) {
    settings[key] = value;
    GM_setValue(STORAGE[key], value);
    updatePanel();
  }

  function setAIStatus(message, tone = 'muted', detail = '') {
    const box = document.getElementById('ykt-ai-box');
    if (!box) return;
    const colors = { success: '#86efac', warning: '#fde047', error: '#fca5a5', muted: '#d1d5db' };
    box.replaceChildren();
    const primary = document.createElement('div');
    primary.style.color = colors[tone] || colors.muted;
    primary.style.whiteSpace = 'pre-wrap';
    primary.textContent = message;
    box.appendChild(primary);
    if (detail) {
      const secondary = document.createElement('div');
      secondary.className = 'ai-detail';
      secondary.textContent = detail;
      box.appendChild(secondary);
    }
    box.hidden = false;
  }

  function updatePanel() {
    if (!state.panel) return;
    const byId = (id) => document.getElementById(id);
    const status = byId('ykt-status');
    const dot = byId('ykt-dot');
    const pauseButton = byId('ykt-pause');
    const managedButton = byId('ykt-managed');
    const modelButton = byId('ykt-model');
    const debugButton = byId('ykt-debug');

    if (state.activeAlert) {
      status.textContent = '检测到新题目';
      dot.className = 'dot alert';
    } else if (state.domPaused) {
      status.textContent = 'DOM 已暂停，WS 仍在监听';
      dot.className = 'dot paused';
    } else {
      status.textContent = '监控中';
      dot.className = 'dot online';
    }
    byId('ykt-counts').textContent = `提醒 ${state.alertCount} · PPT ${state.slideIndex.size} · 题目 ${state.unlockedProblemIds.length}`;
    byId('ykt-mode').textContent = isLivePage() ? 'DOM + WS' : '仅 WS';
    pauseButton.textContent = state.domPaused ? '▶ 恢复' : '⏸ 暂停';
    managedButton.textContent = settings.managed ? '📲 托管开' : '📵 托管关';
    managedButton.classList.toggle('enabled', settings.managed);
    modelButton.textContent = settings.aiModel === 'deepseek-reasoner' ? '⚡ R1' : '💬 V3';
    debugButton.textContent = settings.debug ? '🧰 日志开' : '🧰 日志关';
    debugButton.classList.toggle('enabled', settings.debug);
    byId('ykt-ntfy').classList.toggle('enabled', Boolean(settings.ntfyTopic));
  }

  function configureNtfy() {
    const current = settings.ntfyTopic || '未设置';
    const input = prompt(`请输入 ntfy topic（8-64 位字母、数字、_ 或 -）：\n当前：${current}`);
    if (input === null) return Boolean(settings.ntfyTopic);
    if (!input.trim()) {
      saveSetting('ntfyTopic', '');
      saveSetting('managed', false);
      setAIStatus('ntfy 配置已清除', 'muted');
      return false;
    }
    try {
      const topic = normalizeNtfyTopic(input);
      saveSetting('ntfyTopic', topic);
      setAIStatus('ntfy topic 已保存', 'success', 'topic 相当于接收密钥，请勿公开。');
      return true;
    } catch (error) {
      setAIStatus(error.message, 'error');
      return false;
    }
  }

  function configureAIKey() {
    const current = settings.aiKey ? `${settings.aiKey.slice(0, 5)}…` : '未设置';
    const input = prompt(`请输入 DeepSeek API Key：\n当前：${current}\n留空可清除。`);
    if (input === null) return;
    saveSetting('aiKey', input.trim());
    state.aiRequestedIds.clear();
    setAIStatus(input.trim() ? 'DeepSeek API Key 已保存' : 'DeepSeek API Key 已清除', input.trim() ? 'success' : 'muted');
  }

  function createPanel() {
    if (document.getElementById('ykt-panel')) return;
    const panel = document.createElement('aside');
    panel.id = 'ykt-panel';
    panel.innerHTML = `
      <style>
        #ykt-panel{position:fixed;right:20px;bottom:20px;z-index:2147483647;width:282px;padding:14px;border:1px solid rgba(255,255,255,.16);border-radius:14px;background:linear-gradient(145deg,#172554,#1e3a5f);box-shadow:0 12px 36px rgba(0,0,0,.35);color:#fff;font:13px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;user-select:none}
        #ykt-panel *{box-sizing:border-box}#ykt-panel .header{display:flex;align-items:center;justify-content:space-between;font-weight:700;font-size:15px;cursor:move}#ykt-panel .status-row{display:flex;align-items:center;gap:7px;margin-top:9px}#ykt-panel .dot{width:9px;height:9px;border-radius:50%}.dot.online{background:#4ade80}.dot.paused{background:#facc15}.dot.alert{background:#fb7185;animation:ykt-blink .55s infinite}@keyframes ykt-blink{50%{opacity:.2}}#ykt-panel .tag{margin-left:auto;padding:2px 7px;border-radius:999px;background:rgba(255,255,255,.12);font-size:10px}#ykt-panel .counts{margin-top:5px;color:#bfdbfe;font-size:11px}#ykt-panel .ai-box{margin-top:9px;padding:8px 10px;border-radius:9px;background:rgba(0,0,0,.24);max-height:180px;overflow:auto;user-select:text}.ai-box[hidden]{display:none}.ai-detail{margin-top:4px;color:#93c5fd;font-size:10px;white-space:pre-wrap}.buttons{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}#ykt-panel button{padding:5px 9px;border:1px solid rgba(255,255,255,.2);border-radius:7px;background:rgba(255,255,255,.1);color:#fff;font:inherit;cursor:pointer}#ykt-panel button:hover,#ykt-panel button.enabled{background:rgba(74,222,128,.25)}#ykt-panel .minimize{padding:1px 8px;font-size:16px}.ykt-hidden{display:none!important}
      </style>
      <div class="header" id="ykt-drag"><span>🔍 雨课堂监控 v${VERSION}</span><button class="minimize" id="ykt-minimize" title="最小化">−</button></div>
      <div class="collapsible">
        <div class="status-row"><span class="dot online" id="ykt-dot"></span><span id="ykt-status">监控中</span><span class="tag" id="ykt-mode">检测中</span></div>
        <div class="counts" id="ykt-counts">提醒 0 · PPT 0 · 题目 0</div>
        <div class="ai-box" id="ykt-ai-box" hidden></div>
        <div class="buttons">
          <button id="ykt-test">🧪 测试</button><button id="ykt-retry">🔄 重试 AI</button><button id="ykt-managed">📵 托管关</button><button id="ykt-ntfy">📡 ntfy</button><button id="ykt-key">🔑 Key</button><button id="ykt-model">💬 V3</button><button id="ykt-pause">⏸ 暂停</button><button id="ykt-debug">🧰 日志关</button>
        </div>
      </div>`;
    document.body.appendChild(panel);
    state.panel = panel;

    panel.querySelector('#ykt-test').addEventListener('click', () => {
      playAlertSound();
      sendBrowserNotification('🧪 雨课堂监控测试', '桌面提醒工作正常。');
      sendPhoneNotification('雨课堂监控测试', 'ntfy 推送工作正常。');
      flashTitle('测试提醒');
      setTimeout(stopTitleFlash, 4_000);
      setAIStatus('测试提醒已触发', 'success');
    });
    panel.querySelector('#ykt-retry').addEventListener('click', retryAI);
    panel.querySelector('#ykt-managed').addEventListener('click', () => {
      if (!settings.managed && !settings.ntfyTopic && !configureNtfy()) return;
      saveSetting('managed', !settings.managed);
      setAIStatus(settings.managed ? '手机托管推送已开启' : '手机托管推送已关闭', settings.managed ? 'success' : 'muted');
    });
    panel.querySelector('#ykt-ntfy').addEventListener('click', configureNtfy);
    panel.querySelector('#ykt-key').addEventListener('click', configureAIKey);
    panel.querySelector('#ykt-model').addEventListener('click', () => {
      saveSetting('aiModel', settings.aiModel === 'deepseek-reasoner' ? 'deepseek-chat' : 'deepseek-reasoner');
    });
    panel.querySelector('#ykt-pause').addEventListener('click', () => {
      state.domPaused = !state.domPaused;
      updatePanel();
    });
    panel.querySelector('#ykt-debug').addEventListener('click', () => {
      saveSetting('debug', !settings.debug);
      debugLog('调试日志已开启');
    });
    panel.querySelector('#ykt-minimize').addEventListener('click', () => {
      const content = panel.querySelector('.collapsible');
      const minimized = !content.classList.contains('ykt-hidden');
      content.classList.toggle('ykt-hidden', minimized);
      panel.querySelector('#ykt-minimize').textContent = minimized ? '+' : '−';
    });

    let drag = null;
    const dragHandle = panel.querySelector('#ykt-drag');
    dragHandle.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      dragHandle.setPointerCapture(event.pointerId);
    });
    dragHandle.addEventListener('pointermove', (event) => {
      if (!drag) return;
      panel.style.left = `${Math.max(0, event.clientX - drag.x)}px`;
      panel.style.top = `${Math.max(0, event.clientY - drag.y)}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    dragHandle.addEventListener('pointerup', () => { drag = null; });
    updatePanel();
  }

  function unlockAudio() {
    try {
      if (!state.audioContext) {
        const AudioContext = pageWindow.AudioContext || pageWindow.webkitAudioContext;
        if (AudioContext) state.audioContext = new AudioContext();
      }
      if (state.audioContext?.state === 'suspended') state.audioContext.resume().catch(() => {});
    } catch (error) {
      debugLog('AudioContext 初始化失败', error);
    }
  }

  function playAlertSound() {
    unlockAudio();
    const context = state.audioContext;
    if (!context || context.state !== 'running') return;
    [0, 0.5, 1].forEach((offset, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + offset;
      oscillator.frequency.setValueAtTime(1_180 - index * 130, start);
      gain.gain.setValueAtTime(0.32, start);
      gain.gain.exponentialRampToValueAtTime(0.01, start + 0.35);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.36);
    });
  }

  function sendBrowserNotification(title, body) {
    try {
      GM_notification({ title, text: body, timeout: 15_000, onclick: () => pageWindow.focus() });
      return;
    } catch (error) {
      debugLog('GM_notification 不可用', error);
    }
    if ('Notification' in pageWindow && pageWindow.Notification.permission === 'granted') {
      const notification = new pageWindow.Notification(title, { body, requireInteraction: true });
      notification.onclick = () => { pageWindow.focus(); notification.close(); };
    }
  }

  function sendPhoneNotification(title, message) {
    if (!settings.managed) return;
    let payload;
    try {
      payload = buildNtfyPayload(settings.ntfyTopic, title, message);
    } catch (error) {
      saveSetting('managed', false);
      setAIStatus('ntfy topic 无效，手机托管已关闭', 'error');
      return;
    }
    GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://ntfy.sh',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(payload),
      timeout: 12_000,
      onload: (response) => {
        if (response.status < 200 || response.status >= 300) warnLog(`ntfy 推送失败（HTTP ${response.status}）`);
        else debugLog('ntfy 推送成功');
      },
      ontimeout: () => warnLog('ntfy 推送超时'),
      onerror: () => warnLog('ntfy 推送网络错误'),
    });
  }

  function flashTitle(message) {
    stopTitleFlash();
    state.titleBeforeFlash = document.title;
    let visible = false;
    state.titleFlashTimer = setInterval(() => {
      document.title = visible ? state.titleBeforeFlash : `🔔 ${message}`;
      visible = !visible;
    }, 650);
    state.titleStopTimer = setTimeout(stopTitleFlash, CONFIG.titleFlashMs);
  }

  function stopTitleFlash() {
    if (state.titleFlashTimer) clearInterval(state.titleFlashTimer);
    if (state.titleStopTimer) clearTimeout(state.titleStopTimer);
    if (state.titleFlashTimer && state.titleBeforeFlash) document.title = state.titleBeforeFlash;
    state.titleFlashTimer = null;
    state.titleStopTimer = null;
  }

  function triggerAlert(source, detail, problemId = '') {
    const key = problemId ? `problem:${problemId}` : `${source}:${detail}:${makeLessonKey()}`;
    if (!state.alertGate.accept(key, Boolean(problemId))) {
      if (problemId) scheduleAI(problemId);
      return;
    }
    state.activeAlert = true;
    state.alertCount += 1;
    console.info(`[YKT监控] 检测到新题目：${source} · ${detail}`);
    playAlertSound();
    sendBrowserNotification('⚠️ 雨课堂有新题目', `${detail}\n请打开课堂确认。`);
    sendPhoneNotification('雨课堂有新题目', `${detail}\n请打开课堂确认。`);
    flashTitle('有新题目');
    updatePanel();
    scheduleAI(problemId);
    setTimeout(() => {
      state.activeAlert = false;
      updatePanel();
    }, CONFIG.titleFlashMs);
  }

  function scheduleAI(problemId = '', attempt = 0) {
    if (!settings.aiKey) {
      setAIStatus('尚未配置 DeepSeek API Key', 'warning', '点击“🔑 Key”后才能获取 AI 参考答案。');
      return;
    }
    const unlockedIds = problemId ? [] : state.unlockedProblemIds;
    const quiz = selectQuizText(problemId, unlockedIds, state.slideIndex, state.aiRequestedIds);
    if (quiz) {
      askDeepSeek(quiz);
      return;
    }
    if (attempt < CONFIG.aiWaitAttempts) {
      setAIStatus('正在等待当前题目的 PPT 文本…', 'muted');
      setTimeout(() => scheduleAI(problemId, attempt + 1), CONFIG.aiWaitIntervalMs);
      return;
    }
    setAIStatus('未找到当前题目的文本，已跳过 AI', 'warning', '图片题、公式或平台协议变化都可能导致文本无法提取。');
  }

  function askDeepSeek(quiz) {
    if (!quiz?.id || !quiz.text || state.aiRequestedIds.has(quiz.id)) return;
    state.aiRequestedIds.add(quiz.id);
    state.lastQuiz = quiz;
    const modelLabel = settings.aiModel === 'deepseek-reasoner' ? 'R1' : 'V3';
    setAIStatus(`DeepSeek ${modelLabel} 正在分析…`, 'muted', quiz.text.slice(0, 120));

    let promptText;
    try {
      promptText = buildQuizPrompt(quiz.text);
    } catch (error) {
      state.aiRequestedIds.delete(quiz.id);
      setAIStatus('题目文本无效，AI 请求已取消', 'warning');
      return;
    }

    const request = GM_xmlhttpRequest({
      method: 'POST',
      url: 'https://api.deepseek.com/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.aiKey}`,
      },
      timeout: settings.aiModel === 'deepseek-reasoner' ? 45_000 : 20_000,
      data: JSON.stringify({
        model: settings.aiModel,
        messages: [{ role: 'user', content: promptText }],
        max_tokens: settings.aiModel === 'deepseek-reasoner' ? 1_024 : 400,
        temperature: 0,
        stream: false,
      }),
      onload: (response) => {
        state.aiInFlight.delete(quiz.id);
        if (response.status < 200 || response.status >= 300) {
          const failure = classifyAIHttpError(response.status);
          if (failure.retryable) state.aiRequestedIds.delete(quiz.id);
          setAIStatus(failure.message, 'error', failure.retryable ? '稍后可点击“重试 AI”。' : '请检查配置后重试。');
          return;
        }
        try {
          const data = JSON.parse(response.responseText);
          const answer = String(data?.choices?.[0]?.message?.content || '').trim().slice(0, 2_000);
          if (!answer) throw new Error('empty answer');
          setAIStatus(`🤖 AI 参考\n${answer}`, 'success');
          sendPhoneNotification('AI 参考答案', `${answer}\n\n题目：${quiz.text.slice(0, 160)}`);
        } catch (error) {
          state.aiRequestedIds.delete(quiz.id);
          setAIStatus('DeepSeek 返回内容无法解析', 'error', '可以稍后点击“重试 AI”。');
        }
      },
      ontimeout: () => {
        state.aiInFlight.delete(quiz.id);
        state.aiRequestedIds.delete(quiz.id);
        setAIStatus('DeepSeek 请求超时', 'error', '可以稍后点击“重试 AI”。');
      },
      onerror: () => {
        state.aiInFlight.delete(quiz.id);
        state.aiRequestedIds.delete(quiz.id);
        setAIStatus('DeepSeek 网络请求失败', 'error', '请检查网络后重试。');
      },
      onabort: () => state.aiInFlight.delete(quiz.id),
    });
    if (request?.abort) state.aiInFlight.set(quiz.id, request);
  }

  function retryAI() {
    if (!state.lastQuiz) {
      scheduleAI('');
      return;
    }
    state.aiRequestedIds.delete(state.lastQuiz.id);
    askDeepSeek(state.lastQuiz);
  }

  function mergePresentationData(data, presentationId = '') {
    const nextIndex = buildSlideIndex(data);
    if (nextIndex.size === 0) return;
    if (presentationId && state.currentPresentationId && presentationId !== state.currentPresentationId) {
      state.slideIndex.clear();
      state.aiRequestedIds.clear();
    }
    if (presentationId) state.currentPresentationId = presentationId;
    nextIndex.forEach((slide, id) => state.slideIndex.set(id, slide));
    debugLog(`已索引 ${nextIndex.size} 张幻灯片，累计 ${state.slideIndex.size} 张`);
    updatePanel();
  }

  function presentationIdFromUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl), location.href);
      return url.searchParams.get('presentation_id') || url.searchParams.get('presentation') || '';
    } catch (error) {
      return '';
    }
  }

  function inspectPresentationResponse(response, rawUrl, generation) {
    if (!response?.clone) return;
    response.clone().json()
      .then((data) => {
        if (generation !== state.generation) return;
        mergePresentationData(data, presentationIdFromUrl(rawUrl) || extractPresentationId(data));
      })
      .catch((error) => debugLog('presentation 响应解析失败', error));
  }

  function fetchPresentationData(presentationId) {
    const id = String(presentationId || '').trim();
    const generation = state.generation;
    const fetchKey = `${generation}:${id}`;
    if (!id || state.fetchingPresentations.has(fetchKey) || typeof pageWindow.fetch !== 'function') return;
    state.fetchingPresentations.add(fetchKey);
    const url = `/api/v3/lesson/presentation/fetch?presentation_id=${encodeURIComponent(id)}`;
    pageWindow.fetch.call(pageWindow, url, { credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
        return response.json();
      })
      .then((data) => {
        if (generation !== state.generation) return;
        state.fetchAttempts.delete(id);
        mergePresentationData(data, id);
      })
      .catch((error) => {
        if (generation !== state.generation) return;
        const attempts = (state.fetchAttempts.get(id) || 0) + 1;
        state.fetchAttempts.set(id, attempts);
        if (attempts <= 3 && (error.status === 401 || error.status >= 500 || !error.status)) {
          setTimeout(() => fetchPresentationData(id), attempts * 1_500);
        } else {
          warnLog(`presentation ${id} 获取失败`, error.message);
        }
      })
      .finally(() => state.fetchingPresentations.delete(fetchKey));
  }

  function handleWSPayload(payload) {
    if (Array.isArray(payload)) {
      payload.forEach(handleWSPayload);
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    const eventName = normalizeEventName(payload);
    const presentationId = extractPresentationId(payload);
    if (presentationId) fetchPresentationData(presentationId);

    if (REALTIME_PROBLEM_EVENTS.has(eventName)) {
      const problemIds = extractProblemIds(payload);
      if (problemIds.length === 0) triggerAlert('WebSocket', `收到 ${eventName} 事件`);
      problemIds.forEach((problemId) => {
        if (!state.problemTracker.recordRealtime(problemId)) return;
        if (!state.unlockedProblemIds.includes(problemId)) state.unlockedProblemIds.push(problemId);
        triggerAlert('WebSocket', '新题目已解锁', problemId);
      });
    }

    const unlocked = payload.unlockedproblem ?? payload.unlockedProblem ?? payload.data?.unlockedproblem;
    if (Array.isArray(unlocked)) {
      const snapshot = extractProblemIds({ unlockedproblem: unlocked });
      state.unlockedProblemIds = snapshot;
      state.problemTracker.applySnapshot(snapshot).forEach((problemId) => {
        triggerAlert('WebSocket', '题目列表出现新项目', problemId);
      });
      updatePanel();
    }
  }

  function processWSMessage(rawData) {
    try {
      const payload = JSON.parse(rawData);
      debugLog('WS', normalizeEventName(payload) || '(无事件名)', payload);
      handleWSPayload(payload);
    } catch (error) {
      debugLog('忽略非 JSON WebSocket 消息');
    }
  }

  function hookWebSocket() {
    const RealWebSocket = pageWindow.WebSocket;
    if (!RealWebSocket || pageWindow.__YKT_NOTIFIER_WS_HOOKED__) return;
    const WebSocketProxy = new Proxy(RealWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        debugLog('WebSocket 已连接', args[0]);
        socket.addEventListener('message', (event) => {
          const data = event.data;
          if (typeof data === 'string') processWSMessage(data);
          else if (data && typeof data.text === 'function') data.text().then(processWSMessage).catch(() => {});
          else if (pageWindow.ArrayBuffer && data instanceof pageWindow.ArrayBuffer) processWSMessage(new TextDecoder().decode(data));
        });
        return socket;
      },
    });
    try {
      pageWindow.WebSocket = WebSocketProxy;
      pageWindow.__YKT_NOTIFIER_WS_HOOKED__ = true;
      console.info('[YKT监控] WebSocket 监听已启动');
    } catch (error) {
      warnLog('WebSocket Hook 安装失败', error);
    }
  }

  function hookFetchAndXHR() {
    const realFetch = pageWindow.fetch;
    if (typeof realFetch === 'function' && !pageWindow.__YKT_NOTIFIER_FETCH_HOOKED__) {
      const fetchProxy = new Proxy(realFetch, {
        apply(target, thisArg, args) {
          const result = Reflect.apply(target, thisArg, args);
          const rawUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
          const generation = state.generation;
          if (String(rawUrl).includes('presentation/fetch')) {
            result.then((response) => inspectPresentationResponse(response, rawUrl, generation)).catch(() => {});
          }
          return result;
        },
      });
      try {
        pageWindow.fetch = fetchProxy;
        pageWindow.__YKT_NOTIFIER_FETCH_HOOKED__ = true;
      } catch (error) {
        warnLog('Fetch Hook 安装失败', error);
      }
    }

    const XHR = pageWindow.XMLHttpRequest;
    if (!XHR?.prototype || pageWindow.__YKT_NOTIFIER_XHR_HOOKED__) return;
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;
    XHR.prototype.open = function yktOpen(method, url, ...rest) {
      this.__yktNotifierUrl = String(url || '');
      this.__yktNotifierGeneration = state.generation;
      return Reflect.apply(originalOpen, this, [method, url, ...rest]);
    };
    XHR.prototype.send = function yktSend(...args) {
      if (this.__yktNotifierUrl?.includes('presentation/fetch')) {
        this.addEventListener('load', () => {
          try {
            if (this.__yktNotifierGeneration !== state.generation) return;
            mergePresentationData(JSON.parse(this.responseText), presentationIdFromUrl(this.__yktNotifierUrl));
          } catch (error) {
            debugLog('presentation XHR 解析失败', error);
          }
        });
      }
      return Reflect.apply(originalSend, this, args);
    };
    pageWindow.__YKT_NOTIFIER_XHR_HOOKED__ = true;
  }

  function isLivePage() {
    const path = `${location.pathname}${location.hash}`.toLowerCase();
    return !SKIP_PATHS.some((pattern) => path.includes(pattern));
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && element.getClientRects().length > 0;
  }

  function inspectQuizCandidate(element) {
    if (!isVisible(element)) return false;
    const text = String(element.innerText || '').slice(0, 4_000);
    const keyword = detectActiveQuiz(text);
    if (!keyword) return false;
    const dedupeKey = `${makeLessonKey()}:${stableTextHash(text)}`;
    if (!state.domDeduper.accept(dedupeKey)) return false;
    triggerAlert('DOM', `页面出现“${keyword}”`);
    return true;
  }

  function checkDOM() {
    state.domCheckCount += 1;
    if (state.domPaused || !isLivePage() || !document.body) {
      updatePanel();
      return;
    }
    for (const selector of QUIZ_CONTAINER_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        if (inspectQuizCandidate(element)) return;
      }
    }
    const actionElements = document.querySelectorAll('button,[role="button"]');
    for (const action of actionElements) {
      if (!isVisible(action) || !/^(提交答案|开始答题|立即作答|确认提交)$/.test(String(action.innerText || '').trim())) continue;
      const container = action.closest('[role="dialog"],.el-dialog,[class*="problem"],[class*="quiz"]') || action.parentElement;
      if (container && inspectQuizCandidate(container)) return;
    }
    updatePanel();
  }

  function makeLessonKey() {
    const url = new URL(location.href);
    const identityParams = ['classroom_id', 'lesson_id', 'presentation_id']
      .map((key) => `${key}=${url.searchParams.get(key) || ''}`)
      .join('&');
    const hashRoute = url.hash.split('?')[0];
    return `${url.origin}${url.pathname}${hashRoute}?${identityParams}`;
  }

  function resetLessonState(reason) {
    state.generation += 1;
    state.aiInFlight.forEach((request) => request.abort?.());
    state.aiInFlight.clear();
    state.aiRequestedIds.clear();
    state.alertGate.clear();
    state.domDeduper.clear();
    state.fetchAttempts.clear();
    state.fetchingPresentations.clear();
    state.problemTracker.reset();
    state.slideIndex.clear();
    state.unlockedProblemIds = [];
    state.currentPresentationId = '';
    state.lastQuiz = null;
    stopTitleFlash();
    debugLog('课堂状态已重置', reason);
    updatePanel();
  }

  function watchLessonNavigation() {
    state.currentLessonKey = makeLessonKey();
    setInterval(() => {
      const nextKey = makeLessonKey();
      if (nextKey === state.currentLessonKey) return;
      state.currentLessonKey = nextKey;
      resetLessonState('页面导航');
    }, 1_000);
  }

  function registerMenuCommands() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('设置 ntfy topic', configureNtfy);
    GM_registerMenuCommand('设置 DeepSeek API Key', configureAIKey);
    GM_registerMenuCommand('切换调试日志', () => saveSetting('debug', !settings.debug));
  }

  function onReady() {
    createPanel();
    state.domTimer = setInterval(checkDOM, CONFIG.domIntervalMs);
    state.mutationObserver = new MutationObserver((mutations) => {
      if (state.domPaused || !mutations.some((mutation) => mutation.addedNodes.length > 0)) return;
      clearTimeout(state.mutationDebounceTimer);
      state.mutationDebounceTimer = setTimeout(checkDOM, 600);
    });
    state.mutationObserver.observe(document.body, { childList: true, subtree: true });
    watchLessonNavigation();
    checkDOM();
    console.info(`[YKT监控] v${VERSION} 已启动`);
  }

  ['click', 'keydown', 'touchstart'].forEach((eventName) => {
    document.addEventListener(eventName, unlockAudio, { capture: true, once: true });
  });
  hookWebSocket();
  hookFetchAndXHR();
  registerMenuCommands();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
  else onReady();
})();
