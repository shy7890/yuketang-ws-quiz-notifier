# 参与开发

## 本地检查

需要 Node.js 20 或更高版本，不需要安装第三方依赖。

```bash
npm run check
```

该命令会重新生成 `dist/yuketang-quiz-notifier.user.js`、运行核心测试并检查发布脚本语法。

## 提交问题

平台事件格式可能随雨课堂更新而变化。报告漏报或误报时，请提供：

- 雨课堂域名与页面路径（请隐藏个人和课程标识）；
- 复现时间和操作步骤；
- 开启“🧰 日志”后与题目事件直接相关的少量日志；
- 脚本版本和浏览器版本。

请勿公开 Cookie、Authorization、API Key、完整课程数据或其他人的个人信息。

## 发布

1. 同步修改 `package.json` 与 `src/userscript.meta.js` 中的版本号。
2. 更新 `CHANGELOG.md`。
3. 运行 `npm run check` 并提交生成后的 `dist` 文件。
4. 创建并推送 `vX.Y.Z` 标签；GitHub Actions 会验证并创建 Release。
