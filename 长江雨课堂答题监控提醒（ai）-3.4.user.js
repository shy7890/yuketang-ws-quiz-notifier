// ==UserScript==
// @name         长江雨课堂答题监控提醒（ai）
// @namespace    http://tampermonkey.net/
// @version      3.4
// @description  通过拦截WebSocket消息+DOM监控，实时检测雨课堂课堂答题推送，弹窗+声音+标题闪烁+手机推送提醒（智能去重+页面过滤）+ AI参考答案
// @author       Shy
// @match        *://changjiang.yuketang.cn/*
// @match        *://*.yuketang.cn/*
// @match        *://yuketang.cn/*
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @connect      ntfy.sh
// @connect      api.deepseek.com
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        CHECK_INTERVAL: 5000,
        COOLDOWN: 15000,
        SOUND_REPEAT: 3,
        DEBUG: true,
    };

    // ===================== 状态 =====================
    let lastNotifyTime = 0;
    let isQuizActive = false;
    let originalTitle = '';
    let titleFlashTimer = null;
    let audioCtx = null;
    let quizCount = 0;
    let checkCount = 0;
    let seenDOMHashes = new Set();
    let lastURL = location.href;
    let 托管模式 = false;

    // ===================== 核心：幻灯片数据存储 =====================
    // slideId → {texts: [...所有Text字段], index: 幻灯片序号}
    let slideDataMap = {};
    // 已解锁的题目slide ID列表
    let unlockedProblems = [];
    // 已经AI回答过的题目ID（避免重复）
    let answeredProblems = new Set();

    let aiApiKey = GM_getValue('ai_api_key', '');
    let aiModel = GM_getValue('ai_model', 'deepseek-chat');

    function debugLog(...args) {
        if (CONFIG.DEBUG) console.log('%c[YKT-DEBUG]', 'color: #a78bfa; font-weight: bold;', ...args);
    }

    // ===================== 从presentation数据构建幻灯片文本索引 =====================
    function indexPresentationData(presData) {
        try {
            const slides = presData.data?.slides || presData.slides || [];
            debugLog(`索引幻灯片数据: ${slides.length}张`);

            for (const slide of slides) {
                const slideId = slide.id;
                if (!slideId) continue;

                const texts = [];
                const shapes = slide.shapes || [];
                for (const shape of shapes) {
                    if (shape.Text && shape.Text.trim().length > 0) {
                        texts.push(shape.Text.replace(/\r/g, '\n').trim());
                    }
                }

                if (texts.length > 0) {
                    slideDataMap[slideId] = {
                        texts: texts,
                        index: slide.index || 0,
                    };
                }
            }

            debugLog(`幻灯片索引完成, 共${Object.keys(slideDataMap).length}张有文本`);
            updatePanel();
            // 只负责索引，不主动调AI（避免旧题误报）
        } catch (e) {
            debugLog('索引幻灯片数据异常:', e);
        }
    }

    /**
     * 主动请求 presentation 数据（关键！拦截可能错过早于hook的请求）
     */
    let fetchedPresentations = new Set();
    function fetchPresentationData(presentationId) {
        if (!presentationId || fetchedPresentations.has(presentationId)) return;
        if (Object.keys(slideDataMap).length > 0) {
            debugLog('幻灯片数据已存在，跳过主动请求');
            return;
        }
        fetchedPresentations.add(presentationId);

        const url = `/api/v3/lesson/presentation/fetch?presentation_id=${presentationId}`;
        debugLog('🎯 主动请求 presentation 数据:', url);

        // 使用原生XHR避免被自己的hook干扰
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.onload = function () {
            try {
                const json = JSON.parse(xhr.responseText);
                if (json.code === 0 && json.data) {
                    debugLog('✅ presentation 数据获取成功');
                    indexPresentationData(json);
                } else {
                    debugLog('presentation 请求返回异常:', json.code, json.msg);
                }
            } catch (e) {
                debugLog('presentation 响应解析失败:', e);
            }
        };
        xhr.onerror = function () {
            debugLog('presentation 请求失败');
        };
        xhr.send();
    }

    // ===================== 根据slideId获取题目文本 =====================
    function getQuizTextBySlideId(slideId) {
        const slide = slideDataMap[slideId];
        if (!slide) {
            debugLog(`未找到幻灯片 ${slideId} 的数据`);
            return '';
        }

        const allText = slide.texts.join('\n');
        debugLog(`幻灯片 ${slideId} 的文本:`, allText.substring(0, 200));
        return allText.substring(0, 1500);
    }

    // ===================== 获取所有未回答的题目 =====================
    function getLatestUnlockedQuizText() {
        // 从后往前找第一个没回答过的
        for (let i = unlockedProblems.length - 1; i >= 0; i--) {
            const probId = unlockedProblems[i];
            const text = getQuizTextBySlideId(probId);
            if (text.length > 5) {
                return { id: probId, text: text };
            }
        }
        // 都回答过了就返回最后一个
        if (unlockedProblems.length > 0) {
            const lastId = unlockedProblems[unlockedProblems.length - 1];
            return { id: lastId, text: getQuizTextBySlideId(lastId) };
        }
        return { id: '', text: '' };
    }

    // ===================== AI 调用 =====================
    function askDeepSeek(quizText) {
        const aiBox = document.getElementById('ykt-ai-box');

        if (!aiApiKey) {
            if (aiBox) {
                aiBox.style.display = 'block';
                aiBox.innerHTML = '<span style="color:#facc15">⚠️ 未设置Key，点「🔑 Key」填入</span>';
            }
            return;
        }
        if (!quizText || quizText.trim().length < 3) {
            if (aiBox) {
                aiBox.style.display = 'block';
                aiBox.innerHTML = `<span style="opacity:0.6">⚠️ 未提取到题目（幻灯片索引: ${Object.keys(slideDataMap).length}张, 解锁题目: ${unlockedProblems.length}个）</span>`;
            }
            return;
        }

        // 清理HTML
        quizText = quizText.replace(/<[^>]+>/g, '');

        if (aiBox) {
            aiBox.style.display = 'block';
            const modelLabel = aiModel === 'deepseek-reasoner' ? 'R1' : 'V3';
            aiBox.innerHTML = `<span style="opacity:0.7">🤖 DeepSeek-${modelLabel} 思考中…</span>
                <br><span style="font-size:10px;opacity:0.4">题目: ${quizText.substring(0, 80)}…</span>`;
        }

        const prompt = `你是一个答题助手。下面是从课堂PPT幻灯片中提取的文本，其中包含一道题目和选项。请完成以下任务：
1. 从文本中找到题目和选项（选项可能以A B C D字母标记，也可能是带圆圈的序号）
2. 只能从给出的选项中选择答案，不要编造不存在的选项
3. 如果只有A、B两个选项，答案只能是A或B；有ABC三个选项就只能从ABC中选
4. 如果是判断题，只能回答"正确"或"错误"
5. 回答格式：先给出答案字母，再用一句话简要说明理由

幻灯片文本如下：
${quizText}`;

        const timeout = aiModel === 'deepseek-reasoner' ? 30000 : 15000;

        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://api.deepseek.com/chat/completions',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${aiApiKey}`,
            },
            timeout: timeout,
            data: JSON.stringify({
                model: aiModel,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: aiModel === 'deepseek-reasoner' ? 1024 : 300,
                temperature: 0,
            }),
            onload: (res) => {
                try {
                    const data = JSON.parse(res.responseText);
                    if (res.status === 401 || res.status === 403) {
                        if (aiBox) aiBox.innerHTML = '<span style="color:#f87171">Key无效或已过期</span>';
                        return;
                    }
                    const answer = data.choices?.[0]?.message?.content || '未能获取答案';
                    if (aiBox) {
                        aiBox.innerHTML = `<span style="color:#4ade80;font-weight:600">🤖 AI参考：</span><br>${answer}`;
                    }
                    console.log('[YKT监控] AI参考答案:', answer);

                    // 托管模式：把AI答案推送到手机
                    if (托管模式 && answer !== '未能获取答案') {
                        sendPhoneNotification(
                            '🤖 AI参考答案',
                            `${answer}\n\n📝 ${quizText.substring(0, 100)}`
                        );
                    }
                } catch (e) {
                    if (aiBox) aiBox.innerHTML = `<span style="color:#f87171">AI解析失败 (${res.status})</span>`;
                }
            },
            ontimeout: () => {
                if (aiBox) aiBox.innerHTML = `<span style="color:#facc15">⏰ 超时，建议用V3模型或点重试</span>`;
            },
            onerror: () => {
                if (aiBox) aiBox.innerHTML = '<span style="color:#f87171">AI请求失败，检查网络</span>';
            }
        });
    }

    // ===================== 手机推送 =====================
    const NTFY_CHANNEL = 'shy_yuketang';
    function sendPhoneNotification(title, message) {
        if (!托管模式) return;
        GM_xmlhttpRequest({
            method: 'POST', url: 'https://ntfy.sh',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ topic: NTFY_CHANNEL, title, message, priority: 5, tags: ['bell'] }),
            onload: (r) => console.log('[YKT监控] 手机推送:', r.status),
            onerror: (e) => console.warn('[YKT监控] 手机推送失败:', e)
        });
    }

    // ===================== 提示音 =====================
    // 尽早通过用户交互解锁 AudioContext
    function unlockAudio() {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().then(() => debugLog('🔊 AudioContext 已解锁'));
        }
    }
    // 任何用户交互都解锁一次（点页面任何地方即可）
    ['click', 'keydown', 'touchstart'].forEach(evt => {
        document.addEventListener(evt, unlockAudio, { once: true, capture: true });
    });

    function playAlertSound() {
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

            // 关键修复：如果 AudioContext 被挂起，先恢复
            const doBeep = () => {
                let i = 0;
                function beep() {
                    if (i >= CONFIG.SOUND_REPEAT) return;
                    const osc = audioCtx.createOscillator();
                    const gain = audioCtx.createGain();
                    osc.connect(gain); gain.connect(audioCtx.destination);
                    osc.frequency.setValueAtTime(1200 - i * 150, audioCtx.currentTime);
                    gain.gain.setValueAtTime(0.4, audioCtx.currentTime);
                    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
                    osc.start(audioCtx.currentTime); osc.stop(audioCtx.currentTime + 0.4);
                    i++; if (i < CONFIG.SOUND_REPEAT) setTimeout(beep, 500);
                }
                beep();
            };

            if (audioCtx.state === 'suspended') {
                debugLog('⚠️ AudioContext suspended，尝试 resume...');
                audioCtx.resume().then(doBeep).catch(e => {
                    debugLog('AudioContext resume 失败，用 fallback:', e);
                    playFallbackSound();
                });
            } else {
                doBeep();
            }
        } catch (e) {
            debugLog('playAlertSound 异常:', e);
            playFallbackSound();
        }
    }

    // Fallback: 用 HTML5 Audio 播放 base64 提示音（不受 AudioContext 限制那么严格）
    function playFallbackSound() {
        try {
            // 生成简单的 WAV beep
            const sampleRate = 8000, duration = 0.3, freq = 1200;
            const samples = sampleRate * duration;
            const buffer = new ArrayBuffer(44 + samples * 2);
            const view = new DataView(buffer);
            // WAV header
            const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
            writeStr(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); writeStr(8, 'WAVE');
            writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
            view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
            view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
            writeStr(36, 'data'); view.setUint32(40, samples * 2, true);
            for (let i = 0; i < samples; i++) {
                const t = i / sampleRate;
                const val = Math.sin(2 * Math.PI * freq * t) * 0.3 * (1 - t / duration);
                view.setInt16(44 + i * 2, val * 32767, true);
            }
            const blob = new Blob([buffer], { type: 'audio/wav' });
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio.volume = 0.5;
            let count = 0;
            audio.onended = () => { URL.revokeObjectURL(url); count++; if (count < CONFIG.SOUND_REPEAT) audio.play().catch(() => {}); };
            audio.play().catch(e => debugLog('Fallback 音频也播放失败:', e));
        } catch (e) {
            debugLog('Fallback sound 异常:', e);
        }
    }

    function sendNotification(title, body) {
        if ('Notification' in window && Notification.permission === 'granted') {
            const n = new Notification(title, { body, icon: 'https://changjiang.yuketang.cn/favicon.ico', requireInteraction: true });
            n.onclick = () => { window.focus(); n.close(); };
        }
        try { GM_notification({ title, text: body, timeout: 15000, onclick: () => window.focus() }); } catch (e) {}
    }

    function startTitleFlash(msg) {
        if (titleFlashTimer) return;
        let toggle = false;
        titleFlashTimer = setInterval(() => { document.title = toggle ? originalTitle : `🔔 ${msg}`; toggle = !toggle; }, 700);
    }
    function stopTitleFlash() {
        if (titleFlashTimer) { clearInterval(titleFlashTimer); titleFlashTimer = null; document.title = originalTitle; }
    }

    // ===================== 触发提醒 =====================
    function triggerAlert(source, detail, probId) {
        const now = Date.now();
        if (now - lastNotifyTime < CONFIG.COOLDOWN) return;
        lastNotifyTime = now;
        isQuizActive = true;
        quizCount++;

        console.log(`%c[YKT监控] ⚠️ 检测到答题！来源: ${source} | ${detail}`,
            'color: #ff4444; font-size: 16px; font-weight: bold;');

        playAlertSound();
        sendNotification('⚠️ 雨课堂有题目了！', `${source}: ${detail}\n快去答题！`);
        sendPhoneNotification('雨课堂：有题目了！', `快去答题！（${source}）`);
        startTitleFlash('有新题目！快去答题！');
        updatePanel();

        // AI答案：用slideId精准查表
        let quizText = '';
        if (probId) {
            quizText = getQuizTextBySlideId(probId);
        }
        if (!quizText) {
            // fallback: 取最新的未回答题目
            const latest = getLatestUnlockedQuizText();
            quizText = latest.text;
        }

        if (quizText) {
            askDeepSeek(quizText);
        } else {
            // 幻灯片数据可能还没加载，等一下再试
            debugLog('题目文本为空，等待presentation数据加载...');
            setTimeout(() => {
                const latest = getLatestUnlockedQuizText();
                askDeepSeek(latest.text);
            }, 2000);
        }

        setTimeout(() => { stopTitleFlash(); isQuizActive = false; updatePanel(); }, 30000);
    }

    // ============================================================
    //  核心: WebSocket 拦截
    // ============================================================
    function hookWebSocket() {
        const RealWS = unsafeWindow.WebSocket || window.WebSocket;

        const ProxyWS = function (url, protocols) {
            const ws = protocols ? new RealWS(url, protocols) : new RealWS(url);
            console.log('[YKT监控] WebSocket连接:', url);

            ws.addEventListener('message', function (event) {
                try {
                    let data = event.data;
                    if (typeof data !== 'string') {
                        if (data instanceof Blob) {
                            data.text().then(t => processWSMessage(t)).catch(() => {});
                            return;
                        } else if (data instanceof ArrayBuffer) {
                            data = new TextDecoder('utf-8').decode(data);
                        } else return;
                    }
                    processWSMessage(data);
                } catch (err) {
                    console.warn('[YKT监控] WS消息处理错误:', err);
                }
            });

            return ws;
        };

        function processWSMessage(data) {
            try {
                const json = JSON.parse(data);
                const op = (json.op || '').toLowerCase();

                debugLog('WS:', op, JSON.stringify(json).substring(0, 200));

                // 0. 提取 presentation ID 并主动获取幻灯片数据
                const presId = json.presentation || json.pres;
                if (presId) {
                    fetchPresentationData(presId);
                }

                // 1. 提取 unlockedproblem（hello 和 fetchtimeline 都有）
                if (json.unlockedproblem && Array.isArray(json.unlockedproblem)) {
                    const oldList = [...unlockedProblems];
                    unlockedProblems = json.unlockedproblem;
                    debugLog('更新解锁题目列表:', unlockedProblems);

                    if (oldList.length === 0) {
                        // 首次加载（hello消息），这些都是旧题目，标记为已回答
                        unlockedProblems.forEach(id => answeredProblems.add(id));
                        debugLog('首次加载，标记旧题目为已回答:', unlockedProblems);
                    } else {
                        // 后续更新，检查是否有新题目
                        const newProbs = unlockedProblems.filter(id => !oldList.includes(id));
                        for (const newProbId of newProbs) {
                            if (!answeredProblems.has(newProbId)) {
                                debugLog('🆕 检测到新题目:', newProbId);
                                answeredProblems.add(newProbId);
                                triggerAlert('WebSocket', `新题目解锁`, newProbId);
                                break; // 一次只处理一个新题
                            }
                        }
                    }
                }

                // 2. timeline中的problem事件
                if (json.timeline && Array.isArray(json.timeline)) {
                    for (const event of json.timeline) {
                        if (event.type === 'problem' && event.prob) {
                            if (!unlockedProblems.includes(event.prob)) {
                                unlockedProblems.push(event.prob);
                            }
                        }
                    }
                }

                // 3. 直接的problem事件（实时推送）
                if (op === 'problem' || json.type === 'problem') {
                    const probId = json.prob || json.problem || json.sid || '';
                    if (probId && !answeredProblems.has(probId)) {
                        if (!unlockedProblems.includes(probId)) unlockedProblems.push(probId);
                        triggerAlert('WebSocket', `实时题目推送`, probId);
                        answeredProblems.add(probId);
                    }
                }

                // 4. slidenav 可能包含新解锁的题目
                if (op === 'slidenav' && json.unlockedproblem) {
                    // 已在上面的 unlockedproblem 处理中覆盖
                }

                // 5. 兜底：字符串检测
                const lower = data.toLowerCase();
                if (!op && (lower.includes('unlockproblem') || lower.includes('sendproblem') || lower.includes('publishproblem'))) {
                    triggerAlert('WebSocket', '题目推送(字符串检测)', '');
                }

            } catch (e) {
                // 非JSON
                const lower = data.toLowerCase();
                if (lower.includes('problem') || lower.includes('vote')) {
                    debugLog('非JSON WS消息含题目关键词:', data.substring(0, 100));
                }
            }
        }

        ProxyWS.prototype = RealWS.prototype;
        ProxyWS.CONNECTING = RealWS.CONNECTING;
        ProxyWS.OPEN = RealWS.OPEN;
        ProxyWS.CLOSING = RealWS.CLOSING;
        ProxyWS.CLOSED = RealWS.CLOSED;
        try { unsafeWindow.WebSocket = ProxyWS; } catch (e) { window.WebSocket = ProxyWS; }
        console.log('%c[YKT监控] ✅ WebSocket拦截已启动', 'color: #4CAF50; font-weight: bold;');
    }

    // ============================================================
    //  核心: Fetch/XHR 拦截 — 捕获 presentation/fetch 响应
    // ============================================================
    function hookFetchAndXHR() {
        const origFetch = unsafeWindow.fetch || window.fetch;
        const hookedFetch = function (...args) {
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            const result = origFetch.apply(this, args);

            // 拦截 presentation/fetch — 这是幻灯片数据的来源
            if (url.includes('presentation/fetch') || url.includes('presentation_id')) {
                debugLog('🎯 拦截到 presentation/fetch 请求:', url);
                result.then(response => {
                    const cloned = response.clone();
                    cloned.text().then(bodyText => {
                        try {
                            const json = JSON.parse(bodyText);
                            indexPresentationData(json);
                            updatePanel();
                            // 只索引，不主动调AI
                        } catch (e) {
                            debugLog('presentation响应解析失败:', e);
                        }
                    }).catch(() => {});
                }).catch(() => {});
            }

            return result;
        };
        try { unsafeWindow.fetch = hookedFetch; } catch (e) { window.fetch = hookedFetch; }

        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this._yktUrl = url || '';
            return origOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function (...args) {
            if ((this._yktUrl || '').includes('presentation/fetch') || (this._yktUrl || '').includes('presentation_id')) {
                debugLog('🎯 拦截到 presentation XHR:', this._yktUrl);
                this.addEventListener('load', function () {
                    try {
                        const json = JSON.parse(this.responseText);
                        indexPresentationData(json);
                        updatePanel();
                        // 只索引，不主动调AI
                    } catch (e) {}
                });
            }
            return origSend.apply(this, args);
        };
    }

    // ============================================================
    //  DOM 监控（保留作为补充检测）
    // ============================================================
    const SKIP_URL_PATTERNS = ['/student-lesson-report', '/lesson-report', '/homework', '/user-center', '/course-manage', '/web/log'];
    function isLivePage() { return !SKIP_URL_PATTERNS.some(p => location.pathname.toLowerCase().includes(p)); }

    const LIVE_QUIZ_SELECTORS = ['.el-dialog', '.el-message-box', '.v-modal', '[class*="modal"]', '[class*="popup"]'];
    const LIVE_QUIZ_KEYWORDS = ['请作答', '限时答题', '答题时间', '开始答题', '提交答案', '剩余时间', '投票', '最多可选'];

    function contentHash(text) {
        const s = text.replace(/\s+/g, '').substring(0, 100);
        let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        return h.toString();
    }

    function checkDOM() {
        checkCount++;
        if (location.href !== lastURL) { seenDOMHashes.clear(); lastURL = location.href; }
        if (!isLivePage()) { updatePanel(); return; }
        for (const sel of LIVE_QUIZ_SELECTORS) {
            try {
                for (const el of document.querySelectorAll(sel)) {
                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden') continue;
                    if (!el.offsetParent && el.style.position !== 'fixed') continue;
                    const text = el.innerText || '';
                    for (const kw of LIVE_QUIZ_KEYWORDS) {
                        if (text.includes(kw)) {
                            const hash = contentHash(text);
                            if (seenDOMHashes.has(hash)) continue;
                            seenDOMHashes.add(hash);
                            triggerAlert('DOM检测', `检测到「${kw}」`, '');
                            return;
                        }
                    }
                }
            } catch (e) {}
        }
        updatePanel();
    }

    // ============================================================
    //  重试AI
    // ============================================================
    function retryAI() {
        const aiBox = document.getElementById('ykt-ai-box');
        if (aiBox) { aiBox.style.display = 'block'; aiBox.innerHTML = '<span style="opacity:0.7">🔄 重新查找题目…</span>'; }

        // 如果PPT数据为空，尝试重新获取
        if (Object.keys(slideDataMap).length === 0) {
            debugLog('PPT数据为空，尝试重新获取...');
            fetchedPresentations.clear(); // 清除缓存允许重新请求
            // 从WS消息中找presentation ID（遍历unlockedProblems无法直接得知，但可以从页面URL或之前的WS数据推断）
            // 最简单：直接从当前页面的API重新请求
            const presMatch = location.href.match(/presentation[_=](\d+)/i);
            if (presMatch) fetchPresentationData(presMatch[1]);
        }

        // 清空已回答记录，强制重新查找
        answeredProblems.clear();

        const latest = getLatestUnlockedQuizText();
        if (latest.text) {
            debugLog('重试: 找到题目', latest.id);
            askDeepSeek(latest.text);
        } else {
            if (aiBox) {
                aiBox.innerHTML = `<span style="color:#facc15">⚠️ 未找到题目</span>
                    <br><span style="font-size:10px;opacity:0.5">PPT: ${Object.keys(slideDataMap).length}张 | 题目ID: ${unlockedProblems.join(', ') || '无'}</span>
                    <br><span style="font-size:10px;opacity:0.5">PPT数据正在加载，请稍后再点重试</span>`;
            }
        }
    }

    // ============================================================
    //  控制面板
    // ============================================================
    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'ykt-panel';
        panel.innerHTML = `
            <style>
                #ykt-panel {
                    position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
                    background: linear-gradient(135deg, #1e3a5f 0%, #2d6a9f 100%);
                    color: #fff; border-radius: 14px; padding: 14px 18px;
                    font-size: 13px; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
                    box-shadow: 0 4px 24px rgba(0,0,0,0.35); cursor: move; user-select: none;
                    min-width: 220px; transition: box-shadow 0.3s, transform 0.2s;
                }
                #ykt-panel:hover { box-shadow: 0 6px 32px rgba(0,0,0,0.45); transform: translateY(-1px); }
                #ykt-panel .hdr { font-weight: 700; font-size: 15px; margin-bottom: 10px; }
                #ykt-panel .row { display: flex; align-items: center; gap: 6px; margin: 5px 0; font-size: 12px; flex-wrap: wrap; }
                #ykt-panel .dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
                #ykt-panel .dot.on  { background: #4ade80; animation: ykt-pulse 2s infinite; }
                #ykt-panel .dot.off { background: #facc15; }
                #ykt-panel .dot.alert { background: #f87171; animation: ykt-blink 0.5s infinite; }
                @keyframes ykt-pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
                @keyframes ykt-blink { 0%,100%{opacity:1} 50%{opacity:0.1} }
                #ykt-panel .tag { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; background: rgba(74,222,128,0.3); }
                #ykt-panel .info { font-size: 11px; opacity: 0.7; margin: 3px 0; }
                #ykt-panel .ai-box {
                    margin-top: 8px; background: rgba(0,0,0,0.25); border-radius: 8px;
                    padding: 7px 10px; font-size: 12px; line-height: 1.5;
                    max-height: 160px; overflow-y: auto; display: none;
                }
                #ykt-panel .btns { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
                #ykt-panel button {
                    background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.25);
                    color: #fff; border-radius: 8px; padding: 5px 12px; font-size: 12px;
                    cursor: pointer; transition: background 0.2s; font-family: inherit;
                }
                #ykt-panel button:hover { background: rgba(255,255,255,0.3); }
            </style>
            <div class="hdr">🔍 雨课堂答题监控 v3.4</div>
            <div class="row">
                <span class="dot on" id="ykt-dot"></span>
                <span id="ykt-status">监控中…</span>
                <span class="tag" id="ykt-page">检测中</span>
                <span class="tag" style="background:rgba(96,165,250,0.3)" id="ykt-slides">PPT: 0</span>
                <span class="tag" style="background:rgba(250,204,21,0.3)" id="ykt-probs">题目: 0</span>
            </div>
            <div class="info" id="ykt-info">提醒: 0次</div>
            <div class="ai-box" id="ykt-ai-box"></div>
            <div class="btns">
                <button id="ykt-test">🧪 测试</button>
                <button id="ykt-retry-ai">🔄 重试</button>
                <button id="ykt-tuoguan">📵 托管: 关</button>
                <button id="ykt-ai-key">🔑 Key</button>
                <button id="ykt-ai-model">💬 V3</button>
                <button id="ykt-pause">⏸ 暂停</button>
                <button id="ykt-min">−</button>
            </div>
        `;
        document.body.appendChild(panel);

        let dragging = false, ox, oy;
        panel.addEventListener('mousedown', e => {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true; ox = e.clientX - panel.getBoundingClientRect().left; oy = e.clientY - panel.getBoundingClientRect().top;
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            panel.style.left = (e.clientX - ox) + 'px'; panel.style.top = (e.clientY - oy) + 'px';
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', () => dragging = false);

        document.getElementById('ykt-test').addEventListener('click', () => {
            playAlertSound();
            sendNotification('🧪 测试提醒', '声音和通知正常！');
            sendPhoneNotification('雨课堂：有题目了！', '测试推送');
            startTitleFlash('测试'); setTimeout(stopTitleFlash, 5000);
            if (!aiApiKey) {
                const aiBox = document.getElementById('ykt-ai-box');
                if (aiBox) { aiBox.style.display = 'block'; aiBox.innerHTML = '<span style="color:#facc15">⚠️ 未设置Key</span>'; }
            } else {
                askDeepSeek('单选题：中国的首都是哪里？\nA. 上海\nB. 北京\nC. 广州\nD. 深圳');
            }
        });

        document.getElementById('ykt-retry-ai').addEventListener('click', retryAI);

        const tuoBtn = document.getElementById('ykt-tuoguan');
        tuoBtn.addEventListener('click', () => {
            托管模式 = !托管模式;
            tuoBtn.textContent = 托管模式 ? '📲 托管: 开' : '📵 托管: 关';
            tuoBtn.style.background = 托管模式 ? 'rgba(74,222,128,0.35)' : 'rgba(255,255,255,0.15)';
        });

        document.getElementById('ykt-ai-key').addEventListener('click', () => {
            const key = prompt('输入 DeepSeek API Key（sk-xxx）：\n当前：' + (aiApiKey ? aiApiKey.substring(0, 8) + '…' : '未设置'));
            if (key !== null) { aiApiKey = key.trim(); GM_setValue('ai_api_key', aiApiKey); alert(aiApiKey ? '✅ Key已保存！' : '⚠️ Key已清除'); }
        });

        const modelBtn = document.getElementById('ykt-ai-model');
        modelBtn.textContent = aiModel === 'deepseek-reasoner' ? '⚡ R1' : '💬 V3';
        modelBtn.style.background = aiModel === 'deepseek-reasoner' ? 'rgba(167,139,250,0.4)' : 'rgba(255,255,255,0.15)';
        modelBtn.addEventListener('click', () => {
            aiModel = aiModel === 'deepseek-reasoner' ? 'deepseek-chat' : 'deepseek-reasoner';
            GM_setValue('ai_model', aiModel);
            modelBtn.textContent = aiModel === 'deepseek-reasoner' ? '⚡ R1' : '💬 V3';
            modelBtn.style.background = aiModel === 'deepseek-reasoner' ? 'rgba(167,139,250,0.4)' : 'rgba(255,255,255,0.15)';
        });

        let paused = false;
        document.getElementById('ykt-pause').addEventListener('click', () => {
            paused = !paused;
            document.getElementById('ykt-pause').textContent = paused ? '▶ 恢复' : '⏸ 暂停';
            document.getElementById('ykt-dot').className = paused ? 'dot off' : 'dot on';
            document.getElementById('ykt-status').textContent = paused ? '已暂停' : '监控中…';
            if (paused) clearInterval(window._yktDOMTimer); else window._yktDOMTimer = setInterval(checkDOM, CONFIG.CHECK_INTERVAL);
        });

        let minimized = false;
        document.getElementById('ykt-min').addEventListener('click', () => {
            minimized = !minimized;
            document.getElementById('ykt-min').textContent = minimized ? '+' : '−';
            ['ykt-info', 'ykt-ai-box'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = minimized ? 'none' : ''; });
            panel.querySelectorAll('.btns button:not(#ykt-min)').forEach(b => b.style.display = minimized ? 'none' : '');
        });
    }

    function updatePanel() {
        const info = document.getElementById('ykt-info');
        const dot = document.getElementById('ykt-dot');
        const status = document.getElementById('ykt-status');
        const pageTag = document.getElementById('ykt-page');
        const slidesTag = document.getElementById('ykt-slides');
        const probsTag = document.getElementById('ykt-probs');

        if (info) info.textContent = `提醒: ${quizCount}次`;
        if (dot && status) {
            if (isQuizActive) { dot.className = 'dot alert'; status.textContent = '⚠️ 检测到答题！'; }
            else { dot.className = 'dot on'; status.textContent = '监控中…'; }
        }
        if (pageTag) {
            const live = isLivePage();
            pageTag.textContent = live ? 'DOM+WS' : '仅WS';
            pageTag.style.background = live ? 'rgba(74,222,128,0.3)' : 'rgba(250,204,21,0.3)';
        }
        if (slidesTag) slidesTag.textContent = `PPT: ${Object.keys(slideDataMap).length}`;
        if (probsTag) probsTag.textContent = `题目: ${unlockedProblems.length}`;
    }

    // ============================================================
    //  初始化
    // ============================================================
    hookWebSocket();

    function onReady() {
        originalTitle = document.title;
        console.log('%c[YKT监控] 🚀 长江雨课堂答题监控 v3.4 已启动！', 'color: #2d6a9f; font-size: 16px; font-weight: bold;');
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();

        hookFetchAndXHR();
        createPanel();
        window._yktDOMTimer = setInterval(checkDOM, CONFIG.CHECK_INTERVAL);
        setInterval(updatePanel, 3000);

        let mutDebounce = false;
        const observer = new MutationObserver(mutations => {
            if (mutDebounce) return;
            for (const m of mutations) {
                if (m.addedNodes.length > 0) {
                    mutDebounce = true;
                    setTimeout(() => { checkDOM(); mutDebounce = false; }, 800);
                    return;
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                unlockAudio(); // 切回页面时尝试解锁音频
                if (isQuizActive) playAlertSound();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(onReady, 500));
    } else {
        setTimeout(onReady, 500);
    }
})();