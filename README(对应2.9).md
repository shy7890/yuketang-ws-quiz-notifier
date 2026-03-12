# 🔍 雨课堂答题监控提醒（AI）

> Tampermonkey 脚本 · 实时检测雨课堂答题推送 · DeepSeek AI 参考答案 · ntfy 手机推送

![version](https://img.shields.io/badge/version-2.9-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/platform-Tampermonkey-orange)

---

## ✨ 功能特性

- **WebSocket 拦截**：在底层拦截雨课堂与服务器的实时通信，题目推送瞬间捕获，零延迟
- **DOM 兜底监控**：每 5 秒扫描页面弹窗，防止 WS 消息漏检
- **多重提醒方式**：浏览器弹窗通知 + 页面标题闪烁 + 提示音（三连哔）
- **🤖 AI 参考答案**：调用 DeepSeek R1 / V3，题目检测到后自动给出参考答案
- **📱 手机推送（ntfy）**：托管模式下，手机同步收到推送，离开电脑也不漏题
- **智能去重**：同一道题冷却 15 秒，不会重复轰炸
- **页面过滤**：自动跳过课后报告、作业等非课堂页面，减少误报
- **可拖拽面板**：悬浮在页面右下角，支持最小化，不影响正常使用

---

## 📦 安装方式

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 点击本仓库脚本文件 → 点击右上角「Raw」
3. Tampermonkey 会自动弹出安装确认页面，点击「安装」即可

---

## ⚙️ 配置说明

安装后打开任意雨课堂页面，右下角会出现悬浮控制面板。

### 🔑 DeepSeek AI 答案（可选）

1. 前往 [platform.deepseek.com](https://platform.deepseek.com/) 注册并获取 API Key
2. 点击面板中的「🔑 Key」按钮，输入你的 `sk-xxx` Key
3. 点击「⚡ R1 / 💬 V3」按钮可切换模型（R1 推理更强，V3 速度更快）

> Key 存储在本地 Tampermonkey 存储中，不会上传任何服务器。

### 📡 手机推送（ntfy，可选）

手机推送依赖开源推送服务 [ntfy.sh](https://ntfy.sh)，**完全免费，无需注册**。

**配置步骤：**

1. 手机下载 ntfy App（[Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) / [iOS](https://apps.apple.com/app/ntfy/id1625396347)）
2. 在 App 中订阅一个频道，频道名自取，**建议加入随机字符**，例如：`yourname_ykt_8x3k`
3. 点击面板中的「📡 ntfy」按钮，输入你设置的频道名
4. 点击「📵 托管: 关」开启托管模式，按钮变绿即表示已激活

> ⚠️ **频道名相当于密钥，请勿使用过于简单的名字**，否则他人也能订阅到你的推送。

---

## 🖥️ 面板说明

| 按钮 | 功能 |
|------|------|
| 🧪 测试 | 触发一次测试提醒（声音 + 通知 + AI 答案测试） |
| 📵 托管: 关 | 开启/关闭 ntfy 手机推送（需先配置频道） |
| 📡 ntfy | 设置你的 ntfy 推送频道名 |
| 🔑 Key | 设置 DeepSeek API Key |
| ⚡ R1 / 💬 V3 | 切换 AI 模型 |
| ⏸ 暂停 | 暂停/恢复 DOM 轮询监控 |
| − / + | 最小化/展开面板 |

---

## 🔧 兼容性

| 平台 | 支持 |
|------|------|
| changjiang.yuketang.cn | ✅ |
| *.yuketang.cn | ✅ |
| yuketang.cn | ✅ |

---

## 📝 更新日志

### v2.9
- 移除硬编码 ntfy 频道，改为用户自行配置，**正式支持通用分发**
- 新增「📡 ntfy」面板按钮，已配置时按钮高亮，开启托管但未配置时面板内提示
- 通知图标改为动态读取当前站点 `favicon`，适配所有雨课堂子域
- 中文变量名 `托管模式` 重命名为 `isHosted`，提升兼容性

### v2.8
- 新增 DeepSeek R1 / V3 AI 参考答案，题目触发后自动调用
- WS JSON 解析优先提取题目文本，DOM 刮题兜底
- 面板新增模型切换按钮

### v2.x 以前
- WebSocket 拦截核心逻辑
- DOM 轮询 + MutationObserver 双重检测
- 浏览器通知 + 标题闪烁 + 提示音三重提醒

---

## ⚖️ 免责声明

本脚本仅用于**辅助提醒**，AI 参考答案仅供参考，请独立判断后作答。请遵守所在院校的学术诚信规范。

---

## 📄 License

MIT © [Shy](https://github.com/shy7890)
