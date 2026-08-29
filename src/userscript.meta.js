// ==UserScript==
// @name         雨课堂答题监控提醒
// @namespace    https://github.com/shy7890/yuketang-ws-quiz-notifier
// @version      3.7.0
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
// @updateURL    https://raw.githubusercontent.com/shy7890/yuketang-ws-quiz-notifier/main/dist/yuketang-quiz-notifier.user.js
// @downloadURL  https://raw.githubusercontent.com/shy7890/yuketang-ws-quiz-notifier/main/dist/yuketang-quiz-notifier.user.js
// @homepageURL  https://github.com/shy7890/yuketang-ws-quiz-notifier
// @supportURL   https://github.com/shy7890/yuketang-ws-quiz-notifier/issues
// @license      MIT
// ==/UserScript==
