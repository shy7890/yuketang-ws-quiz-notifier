# 雨课堂答题监控提醒

[![CI](https://github.com/shy7890/yuketang-ws-quiz-notifier/actions/workflows/ci.yml/badge.svg)](https://github.com/shy7890/yuketang-ws-quiz-notifier/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-3.7.0-blue.svg)](CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

一个面向 Tampermonkey 的雨课堂课堂题目提醒脚本。它通过 WebSocket 实时事件与可见 DOM 双通道检测新题，并提供声音、桌面通知、标题闪烁、ntfy 手机推送和可选的 DeepSeek 参考答案。

> 本项目只负责检测和提醒，不会自动选择或提交答案。AI 输出仅供参考，请遵守课程与院校的学术诚信要求。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 打开 [安装脚本](https://raw.githubusercontent.com/shy7890/yuketang-ws-quiz-notifier/main/dist/yuketang-quiz-notifier.user.js)。
3. 在 Tampermonkey 页面确认安装，然后进入雨课堂。
4. 页面右下角出现“雨课堂监控”面板即表示脚本已加载。

脚本包含 `@updateURL` 与 `@downloadURL`，Tampermonkey 可以检查仓库中的后续更新。

## 功能

- **WebSocket 实时检测**：在 `document-start` 阶段监听 `unlockproblem`、`sendproblem` 和 `publishproblem` 等事件。
- **DOM 兜底检测**：只检查可见的题目、弹窗和提交按钮容器，避免全页面关键词扫描。
- **独立去重**：不同 problem ID 不共享全局冷却，不会因连续推题互相吞掉提醒。
- **多重提醒**：提示音、Tampermonkey 桌面通知和页面标题闪烁。
- **手机推送**：用户自行设置私有 ntfy topic；仓库不包含默认 topic。
- **AI 参考答案**：等待当前题目对应的 PPT 文本后调用 DeepSeek V3 或 R1。
- **安全输出**：AI 与网络返回内容使用 `textContent` 渲染，不作为 HTML 执行。
- **SPA 状态隔离**：切换课堂或演示文稿后清空旧的 PPT、题目、去重和 AI 请求状态。
- **调试开关**：默认不打印完整 WebSocket 消息，需要排查时再从面板开启。

## 面板按钮

| 按钮 | 说明 |
| --- | --- |
| 🧪 测试 | 测试声音、桌面通知；已开启托管时也会测试 ntfy |
| 🔄 重试 AI | 对最近一次已提取题目重新请求参考答案 |
| 📵 / 📲 托管 | 关闭或开启 ntfy 手机推送 |
| 📡 ntfy | 设置或清除 ntfy topic |
| 🔑 Key | 设置或清除 DeepSeek API Key |
| 💬 V3 / ⚡ R1 | 切换 DeepSeek 模型 |
| ⏸ 暂停 | 暂停 DOM 检测；WebSocket 仍保持监听 |
| 🧰 日志 | 开关详细调试日志 |

设置保存在 Tampermonkey 的脚本存储中。API Key 不会写入仓库，但会被脚本发送到 DeepSeek API；题目文本也会随请求发送给 DeepSeek。

## ntfy 配置

1. 在 [ntfy](https://ntfy.sh/) App 或网页端订阅一个难以猜测的 topic。
2. 点击面板中的“📡 ntfy”，输入 8–64 位的字母、数字、下划线或连字符。
3. 点击“📵 托管关”将其切换为“📲 托管开”。
4. 点击“🧪 测试”验证手机是否收到通知。

topic 相当于接收密钥。不要使用 `test`、姓名或课程名等容易猜到的值，也不要在 Issue 或截图里公开它。

## AI 功能的边界

AI 能否正确回答首先取决于脚本能否拿到当前题目的完整文本：

- 纯文本选择题通常可以从 presentation 数据提取。
- 图片、复杂公式、图表或特殊富文本可能没有可用文本，脚本会明确跳过，不会拿旧题代替。
- 平台先推送事件、后返回 PPT 时，脚本最多等待约 8 秒再决定是否跳过。
- 模型可能回答错误，且 API 可能出现余额不足、限流、超时或服务异常。

后续若要支持图片题，需要结合真实课堂日志确认图片资源接口，再单独设计图片提取和多模态模型链路。

## 检测设计

```text
WebSocket 新题事件 ─┐
                   ├─> problem ID 去重 ─> 提醒 ─> 等待对应 PPT ─> AI 参考
可见 DOM 题目容器 ─┘

presentation Fetch / XHR ─> 幻灯片文本索引
```

首次收到的完整题目列表会被视为历史基线。后续列表新增项和实时推题事件才会触发 WebSocket 提醒；如果脚本在题目已经开始后才加载，可见 DOM 检测负责补报。

## 开发

仓库不依赖第三方 npm 包，需要 Node.js 20 或更高版本：

```bash
npm test
npm run build
npm run check
```

目录结构：

```text
src/
  core.js                  可测试的解析、状态和安全辅助逻辑
  app.js                   Tampermonkey 浏览器运行层
  userscript.meta.js       Userscript 元数据
scripts/
  build.mjs                零依赖构建脚本
tests/                     Node.js 自动测试
dist/
  yuketang-quiz-notifier.user.js  可直接安装的发布文件
```

平台协议变化需要真实课堂数据验证。提交日志前请先隐藏用户标识、课程标识、Cookie、Authorization 和 API Key。更多说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE) © Shy
