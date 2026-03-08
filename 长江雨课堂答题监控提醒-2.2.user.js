// ==UserScript==
// @name         长江雨课堂答题监控提醒
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  通过拦截WebSocket消息+DOM监控，实时检测雨课堂课堂答题推送，弹窗+声音+标题闪烁提醒（智能去重+页面过滤）
// @author       Shy
// @match        *://changjiang.yuketang.cn/*
// @match        *://*.yuketang.cn/*
// @match        *://yuketang.cn/*
// @grant        GM_notification
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
    let wsMessageLog = [];         // 记录最近的WS消息用于调试
    let quizCount = 0;             // 检测到的答题次数
    let checkCount = 0;
    let seenDOMHashes = new Set(); // 已提醒过的DOM内容指纹，防止重复提醒
    let lastURL = location.href;   // 用于检测页面跳转，跳转后清空指纹

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
                // 第一声高，后面递减，更有辨识度
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
        // 浏览器原生通知
        if ('Notification' in window && Notification.permission === 'granted') {
            const n = new Notification(title, {
                body,
                icon: 'https://changjiang.yuketang.cn/favicon.ico',
                requireInteraction: true,
            });
            n.onclick = () => { window.focus(); n.close(); };
        }
        // 油猴通知后备
        try {
            GM_notification({ title, text: body, timeout: 15000, onclick: () => window.focus() });
        } catch (e) { /* 忽略 */ }
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
    function triggerAlert(source, detail) {
        const now = Date.now();
        if (now - lastNotifyTime < CONFIG.COOLDOWN) return;
        lastNotifyTime = now;
        isQuizActive = true;
        quizCount++;

        console.log(`%c[YKT监控] ⚠️ 检测到答题！来源: ${source} | ${detail}`,
            'color: #ff4444; font-size: 16px; font-weight: bold; background: #fff3f3; padding: 4px 8px;');

        playAlertSound();
        sendNotification('⚠️ 雨课堂有题目了！', `${source}: ${detail}\n快去答题！`);
        startTitleFlash('有新题目！快去答题！');

        updatePanel();

        // 10秒后自动停止闪烁（避免忘了关）
        setTimeout(() => {
            stopTitleFlash();
            isQuizActive = false;
            updatePanel();
        }, 30000);
    }

    // ============================================================
    //  核心方法1: WebSocket 拦截（最可靠）
    //  雨课堂通过WS推送 unlockproblem / slidepage 等事件
    // ============================================================
    function hookWebSocket() {
        const RealWS = unsafeWindow.WebSocket || window.WebSocket;
        const origSend = RealWS.prototype.send;

        // 拦截 WebSocket 构造
        const ProxyWS = function (url, protocols) {
            const ws = protocols ? new RealWS(url, protocols) : new RealWS(url);
            console.log('[YKT监控] WebSocket连接:', url);

            // 拦截收到的消息
            ws.addEventListener('message', function (event) {
                try {
                    let data = event.data;
                    if (typeof data === 'string') {
                        // 记录到日志（调试用，最多保留50条）
                        wsMessageLog.push({ time: new Date().toLocaleTimeString(), data: data.substring(0, 200) });
                        if (wsMessageLog.length > 50) wsMessageLog.shift();

                        const lower = data.toLowerCase();

                        // 关键事件检测
                        // unlockproblem: 老师发送了新题目
                        if (lower.includes('unlockproblem') || lower.includes('unlock_problem')) {
                            triggerAlert('WebSocket', '老师发送了新题目 (unlockproblem)');
                            return;
                        }
                        // probleminfo: 题目信息推送（实测雨课堂真实事件）
                        if (lower.includes('"probleminfo"') || lower.includes('"problem_info"')) {
                            triggerAlert('WebSocket', '题目推送 (probleminfo)');
                            return;
                        }
                        // problemdata / sendproblem: 题目数据推送
                        if (lower.includes('sendproblem') || lower.includes('send_problem')) {
                            triggerAlert('WebSocket', '题目推送 (sendproblem)');
                            return;
                        }
                        // 发布习题
                        if (lower.includes('publishproblem') || lower.includes('publish_problem')) {
                            triggerAlert('WebSocket', '习题发布 (publishproblem)');
                            return;
                        }
                        // 试卷/考试相关
                        if (lower.includes('exam') && (lower.includes('start') || lower.includes('publish'))) {
                            triggerAlert('WebSocket', '考试/试卷推送');
                            return;
                        }
                        // slide问题页
                        if (lower.includes('slideproblem') || lower.includes('slide_problem')) {
                            triggerAlert('WebSocket', '课件习题页面 (slideproblem)');
                            return;
                        }

                        // 尝试JSON解析，检测op字段
                        try {
                            const json = JSON.parse(data);
                            const op = (json.op || json.type || json.action || '').toLowerCase();
                            if (['unlockproblem', 'unlock_problem', 'sendproblem',
                                 'send_problem', 'publishproblem', 'probleminfo',
                                 'problem_info', 'startquiz', 'start_quiz'].includes(op)) {
                                triggerAlert('WebSocket-JSON', `事件: ${op}`);
                            }
                        } catch (e) { /* 非JSON消息，已在上面做了字符串检测 */ }
                    }
                } catch (err) {
                    console.warn('[YKT监控] WS消息处理错误:', err);
                }
            });

            return ws;
        };

        // 复制原型和静态属性
        ProxyWS.prototype = RealWS.prototype;
        ProxyWS.CONNECTING = RealWS.CONNECTING;
        ProxyWS.OPEN = RealWS.OPEN;
        ProxyWS.CLOSING = RealWS.CLOSING;
        ProxyWS.CLOSED = RealWS.CLOSED;

        // 替换全局WebSocket
        try {
            unsafeWindow.WebSocket = ProxyWS;
        } catch (e) {
            window.WebSocket = ProxyWS;
        }

        console.log('%c[YKT监控] ✅ WebSocket拦截已启动', 'color: #4CAF50; font-weight: bold;');
    }

    // ============================================================
    //  核心方法2: DOM 监控（兜底检测）
    //  仅在正在上课的页面生效，课堂回顾/报告页面跳过
    // ============================================================

    // 不需要DOM监控的页面（历史记录、报告、个人中心等）
    const SKIP_URL_PATTERNS = [
        '/student-lesson-report',   // 课堂回顾
        '/lesson-report',           // 课堂报告
        '/homework',                // 作业列表
        '/user-center',             // 个人中心
        '/course-manage',           // 课程管理
        '/web/log',                 // 日志
    ];

    function isLivePage() {
        const path = location.pathname.toLowerCase();
        for (const pattern of SKIP_URL_PATTERNS) {
            if (path.includes(pattern)) return false;
        }
        return true;
    }

    // 仅检测弹出式答题（老师实时推送的题目通常以弹窗形式出现）
    const LIVE_QUIZ_SELECTORS = [
        '.el-dialog',
        '.el-message-box',
        '.v-modal',
        '[class*="modal"]',
        '[class*="popup"]',
        '[class*="overlay"]',
    ];

    // 严格的实时答题关键词（排除回顾页面常见文字）
    const LIVE_QUIZ_KEYWORDS = ['请作答', '限时答题', '答题时间', '开始答题', '提交答案', '剩余时间', '答题倒计时'];

    // 生成内容指纹
    function contentHash(text) {
        const s = text.replace(/\s+/g, '').substring(0, 100);
        let h = 0;
        for (let i = 0; i < s.length; i++) {
            h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        }
        return h.toString();
    }

    function checkDOM() {
        checkCount++;

        // 检测URL变化（SPA页面跳转），变化时清空已见指纹
        if (location.href !== lastURL) {
            console.log('[YKT监控] 页面跳转:', location.href);
            seenDOMHashes.clear();
            lastURL = location.href;
        }

        // 非直播/上课页面，跳过DOM检测（WebSocket检测仍然有效）
        if (!isLivePage()) {
            updatePanel();
            return;
        }

        // 检测弹出式答题元素
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
                            triggerAlert('DOM检测', `检测到「${kw}」`);
                            return;
                        }
                    }
                }
            } catch (e) { /* 选择器异常跳过 */ }
        }

        updatePanel();
    }

    // ============================================================
    //  核心方法3: XHR/Fetch 拦截（补充检测）
    //  监控API请求中的答题相关接口
    // ============================================================
    function hookFetchAndXHR() {
        // Hook fetch
        const origFetch = unsafeWindow.fetch || window.fetch;
        const hookedFetch = function (...args) {
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            const urlLower = url.toLowerCase();
            // 答题相关API
            if (urlLower.includes('/problem/') || urlLower.includes('/exercise/') ||
                urlLower.includes('/quiz/') || urlLower.includes('/unlock')) {
                console.log('[YKT监控] 检测到答题API请求:', url);
            }
            return origFetch.apply(this, args);
        };
        try { unsafeWindow.fetch = hookedFetch; } catch (e) { window.fetch = hookedFetch; }

        // Hook XMLHttpRequest
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this._ykt_url = url;
            const urlLower = (url || '').toLowerCase();
            if (urlLower.includes('/problem/detail') || urlLower.includes('/unlock_problem') ||
                urlLower.includes('/exercise/') || urlLower.includes('/quiz/')) {
                console.log('[YKT监控] 检测到答题XHR请求:', method, url);
            }
            return origOpen.call(this, method, url, ...rest);
        };

        console.log('[YKT监控] Fetch/XHR监控已启动');
    }

    // ============================================================
    //  控制面板（右下角浮窗）
    // ============================================================
    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'ykt-panel';
        panel.innerHTML = `
            <style>
                #ykt-panel {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    z-index: 2147483647;
                    background: linear-gradient(135deg, #1e3a5f 0%, #2d6a9f 100%);
                    color: #fff;
                    border-radius: 14px;
                    padding: 14px 18px;
                    font-size: 13px;
                    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
                    box-shadow: 0 4px 24px rgba(0,0,0,0.35);
                    cursor: move;
                    user-select: none;
                    min-width: 200px;
                    transition: box-shadow 0.3s, transform 0.2s;
                }
                #ykt-panel:hover { box-shadow: 0 6px 32px rgba(0,0,0,0.45); transform: translateY(-1px); }
                #ykt-panel .hdr { font-weight: 700; font-size: 15px; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
                #ykt-panel .row { display: flex; align-items: center; gap: 6px; margin: 5px 0; font-size: 12px; }
                #ykt-panel .dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
                #ykt-panel .dot.on { background: #4ade80; animation: ykt-pulse 2s infinite; }
                #ykt-panel .dot.off { background: #facc15; }
                #ykt-panel .dot.alert { background: #f87171; animation: ykt-blink 0.5s infinite; }
                @keyframes ykt-pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
                @keyframes ykt-blink { 0%,100%{opacity:1} 50%{opacity:0.1} }
                #ykt-panel .btns { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
                #ykt-panel button {
                    background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.25);
                    color: #fff; border-radius: 8px; padding: 5px 12px; font-size: 12px;
                    cursor: pointer; transition: background 0.2s;
                    font-family: inherit;
                }
                #ykt-panel button:hover { background: rgba(255,255,255,0.3); }
                #ykt-panel .info { font-size: 11px; opacity: 0.7; margin: 3px 0; }
                #ykt-panel .ws-status { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; }
                #ykt-panel .ws-ok { background: rgba(74,222,128,0.3); }
                #ykt-panel .ws-no { background: rgba(248,113,113,0.3); }
            </style>
            <div class="hdr">🔍 雨课堂答题监控 v2.2</div>
            <div class="row">
                <span class="dot on" id="ykt-dot"></span>
                <span id="ykt-status">监控中…</span>
                <span class="ws-status ws-ok" id="ykt-ws">WS已Hook</span>
                <span class="ws-status" id="ykt-page" style="background:rgba(74,222,128,0.3);">检测中</span>
            </div>
            <div class="info" id="ykt-info">DOM检测: 0次 | 答题提醒: 0次</div>
            <div class="info" id="ykt-ws-log">最近WS消息: 无</div>
            <div class="btns">
                <button id="ykt-test">🔔 测试提醒</button>
                <button id="ykt-pause">⏸ 暂停</button>
                <button id="ykt-reset">🔄 重置</button>
                <button id="ykt-log">📋 WS日志</button>
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
            panel.style.top = (e.clientY - oy) + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', () => dragging = false);

        // 测试提醒
        document.getElementById('ykt-test').addEventListener('click', () => {
            playAlertSound();
            sendNotification('🧪 测试提醒', '声音和通知正常工作！');
            startTitleFlash('测试提醒');
            setTimeout(stopTitleFlash, 5000);
        });

        // 重置检测记录（允许重新提醒）
        document.getElementById('ykt-reset').addEventListener('click', () => {
            seenDOMHashes.clear();
            quizCount = 0;
            checkCount = 0;
            isQuizActive = false;
            stopTitleFlash();
            updatePanel();
            console.log('[YKT监控] 已重置所有检测记录');
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

        // WS日志
        document.getElementById('ykt-log').addEventListener('click', () => {
            const log = wsMessageLog.length > 0
                ? wsMessageLog.map(m => `[${m.time}] ${m.data}`).join('\n')
                : '暂无WebSocket消息记录';
            console.log('[YKT监控] WebSocket消息日志:\n' + log);
            alert('WebSocket消息日志已输出到控制台 (F12)\n\n最近5条:\n' +
                  wsMessageLog.slice(-5).map(m => `[${m.time}] ${m.data.substring(0, 80)}`).join('\n'));
        });

        // 最小化
        let minimized = false;
        document.getElementById('ykt-min').addEventListener('click', () => {
            minimized = !minimized;
            document.getElementById('ykt-min').textContent = minimized ? '+' : '−';
            ['ykt-info', 'ykt-ws-log'].forEach(id => {
                document.getElementById(id).style.display = minimized ? 'none' : '';
            });
            panel.querySelectorAll('.btns button:not(#ykt-min)').forEach(b => {
                b.style.display = minimized ? 'none' : '';
            });
        });
    }

    function updatePanel() {
        const info = document.getElementById('ykt-info');
        const dot = document.getElementById('ykt-dot');
        const status = document.getElementById('ykt-status');
        const wsLog = document.getElementById('ykt-ws-log');
        const pageTag = document.getElementById('ykt-page');

        if (info) info.textContent = `DOM检测: ${checkCount}次 | 答题提醒: ${quizCount}次`;
        if (dot && status) {
            if (isQuizActive) {
                dot.className = 'dot alert';
                status.textContent = '⚠️ 检测到答题！';
            } else {
                dot.className = 'dot on';
                status.textContent = '监控中…';
            }
        }
        // 显示当前页面类型
        if (pageTag) {
            const live = isLivePage();
            pageTag.textContent = live ? 'DOM+WS' : '仅WS';
            pageTag.style.background = live ? 'rgba(74,222,128,0.3)' : 'rgba(250,204,21,0.3)';
        }
        if (wsLog && wsMessageLog.length > 0) {
            const last = wsMessageLog[wsMessageLog.length - 1];
            wsLog.textContent = `最近WS: [${last.time}] ${last.data.substring(0, 60)}…`;
        }
    }

    // ============================================================
    //  初始化
    // ============================================================

    // 第一步：立即Hook WebSocket（在document-start阶段，页面JS执行前）
    hookWebSocket();

    // 第二步：页面加载后启动DOM监控和面板
    function onReady() {
        originalTitle = document.title;
        console.log('%c[YKT监控] 🚀 长江雨课堂答题监控 v2.2 已启动！', 'color: #2d6a9f; font-size: 16px; font-weight: bold;');
        console.log('[YKT监控] 当前页面:', location.href);

        // 请求通知权限
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }

        // Hook Fetch/XHR
        hookFetchAndXHR();

        // 创建面板
        createPanel();

        // 启动DOM定时检测
        window._yktDOMTimer = setInterval(checkDOM, CONFIG.CHECK_INTERVAL);

        // MutationObserver实时监听
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

        // 切回页面时如果有活跃答题再响一次
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