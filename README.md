# 长江雨课堂答题监控提醒 / YuKeTang Quiz Alert Monitor

> 🔔 再也不错过老师推送的课堂题目！  
> 🔔 Never miss a quiz pushed by your teacher again!

---

## 中文说明

### 简介

这是一个 [Tampermonkey](https://www.tampermonkey.net/) 用户脚本，专为**长江雨课堂**（changjiang.yuketang.cn）设计。

老师在课堂上推送答题时，你可能正在划水、看别的窗口，或者根本没注意到——这个脚本会第一时间用**声音 + 弹窗通知 + 标题闪烁**叫醒你。

### 功能特性

- **🔌 WebSocket 拦截**：在页面 JS 执行前拦截 WebSocket，监听 `unlockproblem`、`probleminfo`、`sendproblem` 等关键事件，是最可靠的检测手段
- **🔍 DOM 监控**：每 5 秒轮询 + MutationObserver 实时监听，检测答题弹窗中的关键词（请作答、限时答题、答题倒计时等）
- **🌐 Fetch / XHR 拦截**：补充监控答题相关 API 请求（`/problem/`、`/quiz/`、`/unlock` 等），输出到控制台供调试
- **🔔 三重提醒**：渐降频率提示音（Web Audio API）+ 浏览器原生通知 + 标题闪烁，切换标签页也不会错过
- **🧠 智能去重**：DOM 内容哈希指纹防止同一道题重复提醒；页面跳转后自动重置
- **📄 页面过滤**：课堂回顾、作业列表、个人中心等非直播页面自动跳过 DOM 检测，减少误报
- **🖥️ 悬浮控制面板**：右下角可拖拽面板，显示监控状态、检测次数；支持测试提醒、暂停/恢复、重置、查看 WS 消息日志、最小化

### 安装方法

1. 安装浏览器扩展 [Tampermonkey](https://www.tampermonkey.net/)（支持 Chrome、Edge、Firefox）
2. 点击 Tampermonkey 图标 → **新建脚本**
3. 将本仓库中的 `.js` 文件内容完整粘贴进去，保存（`Ctrl+S`）
4. 打开 [长江雨课堂](https://changjiang.yuketang.cn) 并进入课堂，右下角出现监控面板即表示安装成功

> **首次使用**：进入课堂后浏览器会请求通知权限，请点击**允许**，否则弹窗通知无法显示。

### 使用说明

| 面板按钮 | 说明 |
|--------|------|
| 🔔 测试提醒 | 测试声音和通知是否正常工作 |
| ⏸ 暂停 / ▶ 恢复 | 暂停或恢复 DOM 轮询检测（WebSocket 检测始终运行） |
| 🔄 重置 | 清空去重记录，允许对同一道题重新提醒 |
| 📋 WS 日志 | 将最近 50 条 WebSocket 消息输出到控制台（F12 查看） |
| − / + | 最小化 / 展开面板 |

### 适用范围

- `*://changjiang.yuketang.cn/*`
- `*://*.yuketang.cn/*`

### 注意事项

- 脚本不会修改任何答题数据，仅做**只读监听**
- 声音提醒依赖浏览器 Web Audio API，部分情况下需要用户先与页面交互才能播放
- 如遇漏报，可点击"WS 日志"查看原始消息，用于排查平台 WebSocket 协议变动

### 版本历史

| 版本 | 更新内容 |
|------|--------|
| v2.2 | 当前版本：增加页面跳转后自动重置指纹；优化面板 WS 状态显示；修复部分边界情况 |
| v2.x | DOM 去重哈希指纹；页面过滤跳过非直播页；MutationObserver 防抖 |
| v1.x | 初始版本：WebSocket 拦截 + DOM 轮询 + 基础提醒 |

### 许可证

[MIT License](LICENSE)

---

## English Documentation

### Overview

A [Tampermonkey](https://www.tampermonkey.net/) userscript for **Changjiang YuKeTang** (长江雨课堂), a Chinese university classroom platform.

When a teacher pushes a quiz during class, you might be on another tab or simply not paying attention. This script instantly alerts you with a **sound + browser notification + flashing tab title** the moment a quiz is detected.

### Features

- **🔌 WebSocket Interception**: Hooks into WebSocket at `document-start` (before page JS runs) and listens for key events: `unlockproblem`, `probleminfo`, `sendproblem`, `publishproblem`, etc. — the most reliable detection method
- **🔍 DOM Polling**: 5-second interval polling + MutationObserver for real-time detection of quiz modal keywords (e.g. "请作答" / "answer now", "限时答题" / "timed quiz")
- **🌐 Fetch / XHR Interception**: Monitors quiz-related API calls (`/problem/`, `/quiz/`, `/unlock`) and logs them to the console for debugging
- **🔔 Triple Alert**: Descending-pitch beep (Web Audio API) + browser native notification + tab title flashing — you'll notice even on another tab
- **🧠 Smart Deduplication**: Content hash fingerprinting prevents repeated alerts for the same quiz; fingerprints reset on page navigation
- **📄 Page Filtering**: Automatically skips DOM detection on non-live pages (lesson reports, homework, user center) to reduce false positives
- **🖥️ Floating Control Panel**: Draggable panel in the bottom-right corner showing monitoring status, detection count; includes test, pause/resume, reset, WS log viewer, and minimize controls

### Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension (Chrome, Edge, or Firefox)
2. Click the Tampermonkey icon → **Create a new script**
3. Paste the entire contents of the `.js` file from this repository, then save (`Ctrl+S`)
4. Open [Changjiang YuKeTang](https://changjiang.yuketang.cn) and enter a classroom — the monitoring panel in the bottom-right corner confirms successful installation

> **First run**: The browser will request notification permission when you enter a classroom. Click **Allow**, otherwise popup notifications won't work.

### Panel Controls

| Button | Function |
|--------|----------|
| 🔔 Test Alert | Test whether sound and notifications are working |
| ⏸ Pause / ▶ Resume | Pause or resume DOM polling (WebSocket detection always runs) |
| 🔄 Reset | Clear deduplication records to allow re-alerting for the same quiz |
| 📋 WS Log | Output the last 50 WebSocket messages to the console (open with F12) |
| − / + | Minimize / expand the panel |

### Matched URLs

- `*://changjiang.yuketang.cn/*`
- `*://*.yuketang.cn/*`

### Notes

- This script is **read-only** — it does not modify any quiz data or submissions
- Sound alerts depend on the browser's Web Audio API; some browsers require prior user interaction with the page before audio can play
- If alerts are missed, use the WS Log button to inspect raw WebSocket messages and check for protocol changes

### Changelog

| Version | Changes |
|---------|---------|
| v2.2 | Current: Auto-reset fingerprints on page navigation; improved WS status display in panel; edge case fixes |
| v2.x | DOM deduplication via content hashing; non-live page filtering; debounced MutationObserver |
| v1.x | Initial release: WebSocket hook + DOM polling + basic alerts |

### License

[MIT License](LICENSE)
