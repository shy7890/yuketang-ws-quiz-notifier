# 更新日志

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## 3.7.1 - 2026-10-30

### 安全

- 用户脚本更新改为只从 GitHub Release 发布资产获取，main 分支的提交不再直接推送给已安装用户。

## 3.7.0 - 2026-08-30

### 新增

- 标准化 `src`、`dist`、`tests` 和自动构建结构。
- GitHub Actions 持续集成与标签 Release 流程。
- 可配置并持久保存的 ntfy topic；不再内置公共 topic。
- 可开关的调试日志和 Tampermonkey 菜单配置入口。
- PPT 文本等待机制、AI 请求去重和明确的 API 错误提示。

### 修复

- 修复暂停 DOM 轮询后 MutationObserver 仍继续触发提醒的问题。
- 修复全局 5 秒冷却可能吞掉不同题目提醒的问题。
- 修复“已提醒”和“已请求 AI”状态混用导致旧题被发送给 AI 的问题。
- 修复跨课堂导航后 PPT、题目与 AI 状态残留的问题。
- 修复 Fetch 调用上下文和 XMLHttpRequest Hook 上下文不一致的问题。
- 修复 AI 返回文本通过 `innerHTML` 写入所带来的页面注入风险。
- 缩小 DOM 检测范围，避免页面其他位置的“已提交”等文字造成误判。

### 变更

- 首次收到的 `unlockedproblem` 列表只作为历史基线，不再猜测最后一题是否为新题。
- 默认关闭详细 WebSocket 日志，降低控制台噪音与课堂数据暴露风险。
- AI 找不到当前 problem ID 对应的幻灯片时等待数据，不再立即使用旧题兜底。

## 3.6.0

- 3.6 单文件脚本的最后一个未标准化版本。
