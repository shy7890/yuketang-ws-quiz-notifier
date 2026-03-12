// ==UserScript==
// @name         雨课堂答题监控提醒（AI）
// @namespace    http://tampermonkey.net/
// @version      2.9
// @description  通过拦截WebSocket消息+DOM监控，实时检测雨课堂课堂答题推送，弹窗+声音+标题闪烁+手机推送提醒（智能去重+页面过滤）+ AI参考答案。支持 DeepSeek R1/V3 + ntfy 手机推送（需自行配置频道）。
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

    // ===================== 配置区 =====================
    const CONFIG = {
        CHECK_INTERVAL: 5000,      // DOM轮询间隔（毫秒）
        COOLDOWN: 15000,           // 同一次通知冷却（毫秒）
        SOUND_REPEAT: 3,           // 提示音重复次数
    };

    // ===================== 状态 =====================
    let lastNotifyTime = 0;
    let isQuizActive = false;
    let originalTitle = '';
    let titleFlashTimer = null;
    let audioCtx = null;
    let wsMessageLog = [];
    let quizCount = 0;
    let checkCount = 0;
    let seenDOMHashes = new Set();
    let lastURL = location.href;
    let isHosted = false;

    // ===================== AI 配置 =====================
    let aiApiKey = GM_getValue('ai_api_key', '');
    let aiModel = GM_getValue('ai_model', 'deepseek-reasoner'); // deepseek-chat(V3) | deepseek-reasoner(R1)
    let pendingWsQuizText = ''; // 从WS JSON里直接提取的题目文本

    // ===================== ntfy 配置 =====================
    let ntfyChannel = GM_getValue('ntfy_channel', ''); // 用户自己的 ntfy 频道名，不填则托管推送不生效

    // ===================== AI 参考答案（DeepSeek） =====================

    // 尝试从 WS JSON 数据里提取题目文本（最可靠，题目数据就在WS消息里）
    function extractQuizFromWS(json) {
        try {
            // 雨课堂常见字段：problem / question / title / content + choices / options
            const prob = json.problem || json.question || json.data?.problem || json.data?.question || {};
            const title = prob.title || prob.content || prob.body || json.title || json.content || '';
            if (!title) return '';

            let text = title;
            // 拼接选项
            const choices = prob.choices || prob.options || prob.answers || [];
            if (Array.isArray(choices) && choices.length > 0) {
                const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
                choices.forEach((c, i) => {
                    const content = c.content || c.text || c.label || c;
                    text += `\n${labels[i] || i + 1}. ${content}`;
                });
            }
            return text.substring(0, 800);
        } catch (e) {
            return '';
        }
    }

    // DOM fallback：从可见弹窗里刮题目文本
    function extractQuizFromDOM() {
        const selectors = [
            '.el-dialog__body',
            '.el-message-box__content',
            '[class*="problem"]',
            '[class*="question"]',
            '[class*="modal"]',
            '[class*="popup"]',
        ];
        for (const sel of selectors) {
            try {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden') continue;
                    const text = (el.innerText || '').trim();
                    if (text.length > 10) return text.substring(0, 800);
                }
            } catch (e) {}
        }
        return '';
    }

    function askDeepSeek(quizText) {
        const aiBox = document.getElementById('ykt-ai-box');

        if (!aiApiKey) {
            if (aiBox) {
                aiBox.style.display = 'block';
                aiBox.innerHTML = '<span style="color:#facc15">⚠️ 未设置Key，点「🔑 Key」填入</span>';
            }
            return;
        }
        if (!quizText) {
            if (aiBox) {
                aiBox.style.display = 'block';
                aiBox.innerHTML = '<span style="opacity:0.6">未能提取到题目文本</span>';
            }
            return;
        }

        if (aiBox) {
            aiBox.style.display = 'block';
            const modelLabel = aiModel === 'deepseek-reasoner' ? 'R1' : 'V3';
            aiBox.innerHTML = `<span style="opacity:0.7">🤖 DeepSeek-${modelLabel} 思考中…</span>`;
        }

        const prompt = `以下是一道雨课堂课堂题目，请给出简洁的参考答案，直接给出答案选项或答案内容，不需要解释过程：\n\n${quizText}`;

        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://api.deepseek.com/chat/completions',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${aiApiKey}`,
            },
            data: JSON.stringify({
                model: aiModel,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 300,
                temperature: 0.1,
            }),
            onload: (res) => {
                try {
                    const data = JSON.parse(res.responseText);
                    // 401/403: key 有问题
                    if (res.status === 401 || res.status === 403) {
                        if (aiBox) aiBox.innerHTML = '<span style="color:#f87171">Key无效或已过期，请重新设置</span>';
                        return;
                    }
                    const answer = data.choices?.[0]?.message?.content || '未能获取答案';
                    if (aiBox) {
                        aiBox.innerHTML = `<span style="color:#4ade80;font-weight:600">🤖 AI参考：</span><br>${answer}`;
                    }
                    console.log('[YKT监控] AI参考答案:', answer);
                } catch (e) {
                    if (aiBox) aiBox.innerHTML = `<span style="color:#f87171">AI解析失败 (${res.status})</span>`;
                    console.warn('[YKT监控] AI响应解析失败:', e, res.responseText);
                }
            },
            onerror: () => {
                if (aiBox) aiBox.innerHTML = '<span style="color:#f87171">AI请求失败，检查网络</span>';
            }
        });
    }

    // ===================== 手机推送（ntfy） =====================
    function sendPhoneNotification(title, message) {
        if (!isHosted) return;
        if (!ntfyChannel) {
            console.warn('[YKT监控] 托管模式已开启但未设置 ntfy 频道，跳过推送。请点「📡 ntfy」按钮配置。');
            return;
        }
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://ntfy.sh',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ topic: ntfyChannel, title, message, priority: 5, tags: ['bell'] }),
            onload: (r) => console.log('[YKT监控] 手机推送, status:', r.status),
            onerror: (e) => console.warn('[YKT监控] 手机推送失败:', e)
        });
    }

    // ===================== 提示音 =====================
    function playAlertSound() {
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            let i = 0;
            function beep() {
                if (i >= CONFIG.SOUND_REPEAT) return;
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.frequency.setValueAtTime(1200 - i * 150, audioCtx.currentTime);
                gain.gain.setValueAtTime(0.4, audioCtx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
                osc.start(audioCtx.currentTime);
                osc.stop(audioCtx.currentTime + 0.4);
                i++;
                if (i < CONFIG.SOUND_REPEAT) setTimeout(beep, 500);
            }
            beep();
        } catch (e) { console.warn('[YKT监控] 声音播放失败:', e); }
    }

    // ===================== 浏览器通知 =====================
    function sendNotification(title, body) {
        if ('Notification' in window && Notification.permission === 'granted') {
            const n = new Notification(title, {
                body,
                icon: location.origin + '/favicon.ico',
                requireInteraction: true,
            });
            n.onclick = () => { window.focus(); n.close(); };
        }
        try {
            GM_notification({ title, text: body, timeout: 15000, onclick: () => window.focus() });
        } catch (e) {}
    }

    // ===================== 标题闪烁 =====================
    function startTitleFlash(msg) {
        if (titleFlashTimer) return;
        let toggle = false;
        titleFlashTimer = setInterval(() => {
            document.title = toggle ? originalTitle : `🔔 ${msg}`;
            toggle = !toggle;
        }, 700);
    }
    function stopTitleFlash() {
        if (titleFlashTimer) {
            clearInterval(titleFlashTimer);
            titleFlashTimer = null;
            document.title = originalTitle;
        }
    }

    // ===================== 触发提醒 =====================
    function triggerAlert(source, detail, wsQuizText) {
        const now = Date.now();
        if (now - lastNotifyTime < CONFIG.COOLDOWN) return;
        lastNotifyTime = now;
        isQuizActive = true;
        quizCount++;

        console.log(`%c[YKT监控] ⚠️ 检测到答题！来源: ${source} | ${detail}`,
            'color: #ff4444; font-size: 16px; font-weight: bold; background: #fff3f3; padding: 4px 8px;');

        playAlertSound();
        sendNotification('⚠️ 雨课堂有题目了！', `${source}: ${detail}\n快去答题！`);
        sendPhoneNotification('雨课堂：有题目了！', `快去答题！（${source}）`);
        startTitleFlash('有新题目！快去答题！');
        updatePanel();

        // AI 参考答案：优先用 WS 里直接拿到的题目，fallback 到 DOM 刮
        if (wsQuizText) {
            // WS 里有题目，直接调用
            askDeepSeek(wsQuizText);
        } else {
            // 等弹窗 DOM 渲染后再刮（600ms）
            setTimeout(() => {
                const domText = extractQuizFromDOM();
                askDeepSeek(domText); // 即使空也会给出提示
            }, 600);
        }

        setTimeout(() => {
            stopTitleFlash();
            isQuizActive = false;
            updatePanel();
        }, 30000);
    }

    // ============================================================
    //  核心方法1: WebSocket 拦截
    // ============================================================
    function hookWebSocket() {
        const RealWS = unsafeWindow.WebSocket || window.WebSocket;

        const ProxyWS = function (url, protocols) {
            const ws = protocols ? new RealWS(url, protocols) : new RealWS(url);
            console.log('[YKT监控] WebSocket连接:', url);

            ws.addEventListener('message', function (event) {
                try {
                    const data = event.data;
                    if (typeof data !== 'string') return;

                    // 记录日志
                    wsMessageLog.push({ time: new Date().toLocaleTimeString(), data: data.substring(0, 200) });
                    if (wsMessageLog.length > 50) wsMessageLog.shift();

                    const lower = data.toLowerCase();
                    let triggered = false;
                    let wsQuizText = '';

                    // 先尝试 JSON 解析，既用于检测事件类型，也用于提取题目
                    try {
                        const json = JSON.parse(data);
                        const op = (json.op || json.type || json.action || '').toLowerCase();
                        if (['unlockproblem', 'unlock_problem', 'sendproblem', 'send_problem',
                             'publishproblem', 'probleminfo', 'problem_info', 'startquiz', 'start_quiz'].includes(op)) {
                            wsQuizText = extractQuizFromWS(json);
                            triggerAlert('WebSocket', `事件: ${op}`, wsQuizText);
                            triggered = true;
                        }
                    } catch (e) { /* 非JSON，走字符串检测 */ }

                    if (triggered) return;

                    // 字符串兜底检测（非JSON消息）
                    if (lower.includes('unlockproblem') || lower.includes('unlock_problem')) {
                        triggerAlert('WebSocket', '新题目 (unlockproblem)', '');
                    } else if (lower.includes('"probleminfo"') || lower.includes('"problem_info"')) {
                        triggerAlert('WebSocket', '题目推送 (probleminfo)', '');
                    } else if (lower.includes('sendproblem') || lower.includes('send_problem')) {
                        triggerAlert('WebSocket', '题目推送 (sendproblem)', '');
                    } else if (lower.includes('publishproblem') || lower.includes('publish_problem')) {
                        triggerAlert('WebSocket', '习题发布 (publishproblem)', '');
                    } else if (lower.includes('slideproblem') || lower.includes('slide_problem')) {
                        triggerAlert('WebSocket', '课件习题 (slideproblem)', '');
                    } else if (lower.includes('exam') && (lower.includes('start') || lower.includes('publish'))) {
                        triggerAlert('WebSocket', '考试/试卷推送', '');
                    }

                } catch (err) {
                    console.warn('[YKT监控] WS消息处理错误:', err);
                }
            });

            return ws;
        };

        ProxyWS.prototype = RealWS.prototype;
        ProxyWS.CONNECTING = RealWS.CONNECTING;
        ProxyWS.OPEN = RealWS.OPEN;
        ProxyWS.CLOSING = RealWS.CLOSING;
        ProxyWS.CLOSED = RealWS.CLOSED;

        try { unsafeWindow.WebSocket = ProxyWS; } catch (e) { window.WebSocket = ProxyWS; }
        console.log('%c[YKT监控] ✅ WebSocket拦截已启动', 'color: #4CAF50; font-weight: bold;');
    }

    // ============================================================
    //  核心方法2: DOM 监控（兜底检测）
    // ============================================================
    const SKIP_URL_PATTERNS = [
        '/student-lesson-report', '/lesson-report', '/homework',
        '/user-center', '/course-manage', '/web/log',
    ];

    function isLivePage() {
        const path = location.pathname.toLowerCase();
        return !SKIP_URL_PATTERNS.some(p => path.includes(p));
    }

    const LIVE_QUIZ_SELECTORS = [
        '.el-dialog', '.el-message-box', '.v-modal',
        '[class*="modal"]', '[class*="popup"]', '[class*="overlay"]',
    ];
    const LIVE_QUIZ_KEYWORDS = ['请作答', '限时答题', '答题时间', '开始答题', '提交答案', '剩余时间', '答题倒计时'];

    function contentHash(text) {
        const s = text.replace(/\s+/g, '').substring(0, 100);
        let h = 0;
        for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        return h.toString();
    }

    function checkDOM() {
        checkCount++;
        if (location.href !== lastURL) {
            seenDOMHashes.clear();
            lastURL = location.href;
        }
        if (!isLivePage()) { updatePanel(); return; }

        for (const sel of LIVE_QUIZ_SELECTORS) {
            try {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden') continue;
                    if (!el.offsetParent && el.style.position !== 'fixed') continue;
                    const text = el.innerText || '';
                    for (const kw of LIVE_QUIZ_KEYWORDS) {
                        if (text.includes(kw)) {
                            const hash = contentHash(text);
                            if (seenDOMHashes.has(hash)) continue;
                            seenDOMHashes.add(hash);
                            // DOM检测时题目就在 el 里，直接用
                            triggerAlert('DOM检测', `检测到「${kw}」`, text.substring(0, 800));
                            return;
                        }
                    }
                }
            } catch (e) {}
        }
        updatePanel();
    }

    // ============================================================
    //  核心方法3: XHR/Fetch 拦截（补充检测，仅打日志）
    // ============================================================
    function hookFetchAndXHR() {
        const origFetch = unsafeWindow.fetch || window.fetch;
        const hookedFetch = function (...args) {
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            if (/\/(problem|exercise|quiz|unlock)/i.test(url)) {
                console.log('[YKT监控] 检测到答题API请求:', url);
            }
            return origFetch.apply(this, args);
        };
        try { unsafeWindow.fetch = hookedFetch; } catch (e) { window.fetch = hookedFetch; }

        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            if (/\/(problem\/detail|unlock_problem|exercise|quiz)/i.test(url || '')) {
                console.log('[YKT监控] 检测到答题XHR:', method, url);
            }
            return origOpen.call(this, method, url, ...rest);
        };
    }

    // ============================================================
    //  控制面板（精简版）
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
                #ykt-panel .row { display: flex; align-items: center; gap: 6px; margin: 5px 0; font-size: 12px; }
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
                    max-height: 140px; overflow-y: auto; display: none;
                }
                #ykt-panel .btns { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
                #ykt-panel button {
                    background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.25);
                    color: #fff; border-radius: 8px; padding: 5px 12px; font-size: 12px;
                    cursor: pointer; transition: background 0.2s; font-family: inherit;
                }
                #ykt-panel button:hover { background: rgba(255,255,255,0.3); }
            </style>
            <div class="hdr">🔍 雨课堂答题监控 v2.9</div>
            <div class="row">
                <span class="dot on" id="ykt-dot"></span>
                <span id="ykt-status">监控中…</span>
                <span class="tag" id="ykt-page">检测中</span>
            </div>
            <div class="info" id="ykt-info">提醒: 0次</div>
            <div class="ai-box" id="ykt-ai-box"></div>
            <div class="btns">
                <button id="ykt-test">🧪 测试</button>
                <button id="ykt-tuoguan">📵 托管: 关</button>
                <button id="ykt-ntfy">📡 ntfy</button>
                <button id="ykt-ai-key">🔑 Key</button>
                <button id="ykt-ai-model">⚡ R1</button>
                <button id="ykt-pause">⏸ 暂停</button>
                <button id="ykt-min">−</button>
            </div>
        `;
        document.body.appendChild(panel);

        // 拖拽
        let dragging = false, ox, oy;
        panel.addEventListener('mousedown', e => {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true;
            ox = e.clientX - panel.getBoundingClientRect().left;
            oy = e.clientY - panel.getBoundingClientRect().top;
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            panel.style.left = (e.clientX - ox) + 'px';
            panel.style.top  = (e.clientY - oy) + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', () => dragging = false);

        // 测试（声音+通知+AI）
        document.getElementById('ykt-test').addEventListener('click', () => {
            playAlertSound();
            sendNotification('🧪 测试提醒', '声音和通知正常！');
            sendPhoneNotification('雨课堂：有题目了！', '测试推送');
            startTitleFlash('测试');
            setTimeout(stopTitleFlash, 5000);
            // 测试AI
            if (!aiApiKey) {
                const aiBox = document.getElementById('ykt-ai-box');
                if (aiBox) {
                    aiBox.style.display = 'block';
                    aiBox.innerHTML = '<span style="color:#facc15">⚠️ 未设置Key，点「🔑 Key」填入</span>';
                }
            } else {
                askDeepSeek('单选题：中国的首都是哪里？\nA. 上海\nB. 北京\nC. 广州\nD. 深圳');
            }
        });

        // 托管模式
        const tuoBtn = document.getElementById('ykt-tuoguan');
        tuoBtn.addEventListener('click', () => {
            isHosted = !isHosted;
            tuoBtn.textContent = isHosted ? '📲 托管: 开' : '📵 托管: 关';
            tuoBtn.style.background = isHosted ? 'rgba(74,222,128,0.35)' : 'rgba(255,255,255,0.15)';
            if (isHosted && !ntfyChannel) {
                const aiBox = document.getElementById('ykt-ai-box');
                if (aiBox) {
                    aiBox.style.display = 'block';
                    aiBox.innerHTML = '<span style="color:#facc15">⚠️ 托管已开启，请点「📡 ntfy」设置频道</span>';
                }
            }
        });

        // ntfy 频道设置
        document.getElementById('ykt-ntfy').addEventListener('click', () => {
            const ch = prompt(
                'ntfy 手机推送频道名（在 ntfy.sh 或 App 中订阅同名频道）\n' +
                '建议取个不易猜到的名字，如：myname_ykt_2024\n' +
                '当前：' + (ntfyChannel || '未设置')
            );
            if (ch !== null) {
                ntfyChannel = ch.trim();
                GM_setValue('ntfy_channel', ntfyChannel);
                const ntfyBtn = document.getElementById('ykt-ntfy');
                if (ntfyBtn) ntfyBtn.style.background = ntfyChannel ? 'rgba(74,222,128,0.35)' : 'rgba(255,255,255,0.15)';
                alert(ntfyChannel ? `✅ 频道已保存：${ntfyChannel}` : '⚠️ 频道已清除，托管推送不生效');
            }
        });
        // 初始化按钮颜色（已配置则高亮）
        if (ntfyChannel) {
            const ntfyBtn = document.getElementById('ykt-ntfy');
            if (ntfyBtn) ntfyBtn.style.background = 'rgba(74,222,128,0.35)';
        }

        // 设置 Key
        document.getElementById('ykt-ai-key').addEventListener('click', () => {
            const key = prompt('输入 DeepSeek API Key（sk-xxx）：\n当前：' + (aiApiKey ? aiApiKey.substring(0, 8) + '…' : '未设置'));
            if (key !== null) {
                aiApiKey = key.trim();
                GM_setValue('ai_api_key', aiApiKey);
                alert(aiApiKey ? '✅ Key已保存！' : '⚠️ Key已清除');
            }
        });

        // 模型切换
        const modelBtn = document.getElementById('ykt-ai-model');
        modelBtn.textContent = aiModel === 'deepseek-reasoner' ? '⚡ R1' : '💬 V3';
        modelBtn.style.background = aiModel === 'deepseek-reasoner' ? 'rgba(167,139,250,0.4)' : 'rgba(255,255,255,0.15)';
        modelBtn.addEventListener('click', () => {
            aiModel = aiModel === 'deepseek-reasoner' ? 'deepseek-chat' : 'deepseek-reasoner';
            GM_setValue('ai_model', aiModel);
            modelBtn.textContent = aiModel === 'deepseek-reasoner' ? '⚡ R1' : '💬 V3';
            modelBtn.style.background = aiModel === 'deepseek-reasoner' ? 'rgba(167,139,250,0.4)' : 'rgba(255,255,255,0.15)';
        });

        // 暂停/恢复
        let paused = false;
        document.getElementById('ykt-pause').addEventListener('click', () => {
            paused = !paused;
            document.getElementById('ykt-pause').textContent = paused ? '▶ 恢复' : '⏸ 暂停';
            document.getElementById('ykt-dot').className = paused ? 'dot off' : 'dot on';
            document.getElementById('ykt-status').textContent = paused ? '已暂停' : '监控中…';
            if (paused) {
                clearInterval(window._yktDOMTimer);
            } else {
                window._yktDOMTimer = setInterval(checkDOM, CONFIG.CHECK_INTERVAL);
            }
        });

        // 最小化
        let minimized = false;
        document.getElementById('ykt-min').addEventListener('click', () => {
            minimized = !minimized;
            document.getElementById('ykt-min').textContent = minimized ? '+' : '−';
            ['ykt-info', 'ykt-ai-box'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = minimized ? 'none' : '';
            });
            panel.querySelectorAll('.btns button:not(#ykt-min)').forEach(b => {
                b.style.display = minimized ? 'none' : '';
            });
        });
    }

    function updatePanel() {
        const info   = document.getElementById('ykt-info');
        const dot    = document.getElementById('ykt-dot');
        const status = document.getElementById('ykt-status');
        const pageTag = document.getElementById('ykt-page');

        if (info) info.textContent = `提醒: ${quizCount}次`;
        if (dot && status) {
            if (isQuizActive) {
                dot.className = 'dot alert';
                status.textContent = '⚠️ 检测到答题！';
            } else {
                dot.className = 'dot on';
                status.textContent = '监控中…';
            }
        }
        if (pageTag) {
            const live = isLivePage();
            pageTag.textContent = live ? 'DOM+WS' : '仅WS';
            pageTag.style.background = live ? 'rgba(74,222,128,0.3)' : 'rgba(250,204,21,0.3)';
        }
    }

    // ============================================================
    //  初始化
    // ============================================================
    hookWebSocket();

    function onReady() {
        originalTitle = document.title;
        console.log('%c[YKT监控] 🚀 雨课堂答题监控 v2.9 已启动！', 'color: #2d6a9f; font-size: 16px; font-weight: bold;');

        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }

        hookFetchAndXHR();
        createPanel();

        window._yktDOMTimer = setInterval(checkDOM, CONFIG.CHECK_INTERVAL);

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
            if (!document.hidden && isQuizActive) playAlertSound();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(onReady, 500));
    } else {
        setTimeout(onReady, 500);
    }

})();