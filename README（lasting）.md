# 🔍 雨课堂答题监控提醒（AI）

> Tampermonkey 脚本 · 实时检测雨课堂答题推送 · DeepSeek AI 参考答案 · ntfy 手机推送

![version](https://img.shields.io/badge/version-2.9-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/platform-Tampermonkey-orange)

---

## 🤔 为什么需要这个脚本？

上课摸鱼、切到别的窗口、或者干脆低头玩手机——老师突然推题，你完全没注意到，等回过神来答题时间已经过了一半。

这个脚本会在**老师推送答题的瞬间**，用声音 + 弹窗通知 + 标题闪烁同时叫醒你，还能把题目自动发给 AI 给出参考答案，以及把提醒推送到你的手机。

---

## ✨ 功能特性

- **⚡ WebSocket 拦截**：在底层拦截雨课堂与服务器的实时通信，题目推送瞬间捕获，零延迟
- **🔍 DOM 兜底监控**：每 5 秒扫描页面弹窗，防止 WS 消息漏检
- **🔔 多重提醒**：浏览器弹窗通知 + 页面标题闪烁 + 提示音（三连哔）
- **🤖 AI 参考答案**：调用 DeepSeek R1 / V3，检测到题目后自动给出参考答案
- **📱 手机推送**：托管模式下通过 ntfy 将提醒推送到手机，离开电脑也不漏题
- **🧠 智能去重**：同一道题冷却 15 秒，不会重复轰炸
- **🚫 页面过滤**：自动跳过课后报告、作业等非课堂页面，减少误报
- **🖱️ 可拖拽面板**：悬浮在页面右下角，支持最小化，不影响正常使用

---

## 📦 安装方式

### 第一步：安装 Tampermonkey

根据你的浏览器选择对应版本安装：

- [Chrome](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- [Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)
- [Firefox](https://addons.mozilla.org/firefox/addon/tampermonkey/)

### 第二步：安装脚本

1. 打开本仓库，点击脚本文件 `雨课堂答题监控提醒_ai_-2_9_user.js`
2. 点击右上角「**Raw**」按钮
3. Tampermonkey 会自动弹出安装确认页面，点击「**安装**」即可

### 第三步：验证安装

打开任意雨课堂页面（如 `changjiang.yuketang.cn`），右下角出现蓝色悬浮面板，说明安装成功。点击「🧪 测试」按钮可以验证声音和通知是否正常。

> **注意**：首次运行时浏览器会请求通知权限，请点击「允许」，否则弹窗通知不会生效。

---

## ⚙️ 功能配置

### 🤖 DeepSeek AI 参考答案（可选）

AI 答案功能需要你自己申请 DeepSeek API Key（注册即送额度，答题场景消耗极少）。

**申请步骤：**

1. 前往 [platform.deepseek.com](https://platform.deepseek.com/) 注册账号
2. 登录后点击左侧「API Keys」→「创建 API Key」
3. 复制生成的 Key（格式为 `sk-xxxxxxxxxxxxxxxx`）

**填入脚本：**

1. 点击面板中的「🔑 Key」按钮
2. 在弹出的输入框中粘贴你的 Key，点击确定
3. Key 保存成功后，下次检测到题目时会自动调用 AI

**切换模型：**

点击面板中的「⚡ R1 / 💬 V3」按钮可以在两个模型之间切换：

| 模型 | 特点 | 适合场景 |
|------|------|----------|
| DeepSeek-R1 | 推理能力强，思考更严谨 | 逻辑题、计算题 |
| DeepSeek-V3 | 速度更快，响应迅速 | 选择题、判断题 |

> Key 仅存储在本地 Tampermonkey 存储中，不会上传至任何服务器。

---

### 📱 手机推送 ntfy（可选）

ntfy 是一个开源免费的推送通知服务，无需注册账号即可使用。

#### 第一步：手机安装 ntfy App

| 平台 | 下载地址 |
|------|----------|
| Android（Google Play） | [下载](https://play.google.com/store/apps/details?id=io.heckel.ntfy) |
| Android（F-Droid） | [下载](https://f-droid.org/packages/io.heckel.ntfy/) |
| iOS（App Store） | [下载](https://apps.apple.com/app/ntfy/id1625396347) |

> 国内 Android 用户如无法访问 Google Play，推荐使用 F-Droid 版本，或直接在 [ntfy GitHub Releases](https://github.com/binwiederhier/ntfy/releases) 下载 APK 安装。

#### 第二步：创建并订阅你的频道

1. 打开 ntfy App，点击右下角「**+**」按钮
2. 在「Topic」输入框中输入你自定义的频道名
3. 点击「**Subscribe**」完成订阅，频道出现在列表中即成功

**频道名命名规则：**
- 只能包含**英文字母、数字、下划线、连字符**，不能有中文或空格
- 建议在末尾加入随机字符，防止他人猜到并订阅你的频道
- 示例：`myname_ykt_a7k2`、`zhang_yuketang_9x3`

> 也可以在电脑浏览器直接访问 `https://ntfy.sh/你的频道名` 网页版接收推送，无需登录。

#### 第三步：在脚本中配置频道

1. 点击面板中的「**📡 ntfy**」按钮
2. 输入你在 App 中订阅的频道名（必须完全一致，区分大小写）
3. 点击确定，按钮变绿表示配置成功

#### 第四步：开启托管模式

1. 点击面板中的「**📵 托管: 关**」按钮
2. 按钮变为「📲 托管: 开」并高亮，说明已激活
3. 此后检测到答题时，手机会同步收到推送通知

**验证推送：** 配置完成后点击「🧪 测试」按钮，如果手机收到通知，说明配置正确。

> ⚠️ **安全提示**：频道名相当于你的推送"密钥"。ntfy 是公开服务，任何知道你频道名的人都可以订阅接收推送。请不要使用 `test`、`yuketang`、`yourname` 这类过于简单的名字。

---

## 🖥️ 面板按钮说明

| 按钮 | 功能 |
|------|------|
| 🧪 测试 | 触发一次完整测试（声音 + 通知 + 手机推送 + AI 答案） |
| 📵/📲 托管 | 开启或关闭 ntfy 手机推送（需先配置频道） |
| 📡 ntfy | 设置 ntfy 推送频道名 |
| 🔑 Key | 设置 DeepSeek API Key |
| ⚡ R1 / 💬 V3 | 切换 AI 模型 |
| ⏸ 暂停 / ▶ 恢复 | 暂停或恢复 DOM 轮询监控 |
| − / + | 最小化或展开面板 |

面板可以用鼠标拖拽到屏幕任意位置。

---

## 🔧 兼容性

支持所有 `yuketang.cn` 域名下的页面：

| 域名 | 状态 |
|------|------|
| `changjiang.yuketang.cn` | ✅ 支持 |
| `*.yuketang.cn` | ✅ 支持 |
| `yuketang.cn` | ✅ 支持 |

---

## ❓ 常见问题

**Q：安装后没有出现面板？**  
A：检查 Tampermonkey 是否已启用该脚本（点击浏览器右上角 Tampermonkey 图标查看）。部分页面有安全限制，可尝试刷新页面或重新进入课堂。

**Q：声音和通知没有反应？**  
A：浏览器首次使用需要授权通知权限。点击地址栏左侧的锁形图标，将「通知」设为允许，并确保浏览器音量未被系统静音。

**Q：AI 答案显示"Key 无效"？**  
A：确认 Key 格式正确（以 `sk-` 开头），并检查 DeepSeek 账户余额是否充足。

**Q：手机没有收到推送？**  
A：① 确认频道名拼写与 App 中一致（区分大小写）；② 确认 ntfy App 已获得系统通知权限；③ 确认托管模式已开启（按钮显示"📲 托管: 开"）；④ 点击「🧪 测试」按钮手动触发一次验证。

**Q：面板标签显示"仅WS"是什么意思？**  
A：当前页面（如课后报告、成绩页）不适合 DOM 扫描，脚本自动只保留 WebSocket 监听。在直播课堂页面会显示 `DOM+WS`，两种检测方式同时运行。

---

## 📝 更新日志

### v2.9（当前版本）
- 移除硬编码 ntfy 频道，改为用户自行配置，正式支持通用分发
- 新增「📡 ntfy」面板按钮，已配置时高亮显示
- 托管模式开启但未配置频道时，面板内给出提示
- 通知图标改为动态读取当前站点 favicon，适配所有子域
- 变量名规范化，提升代码兼容性

### v2.8
- 新增 DeepSeek R1 / V3 AI 参考答案
- WS JSON 解析优先提取题目文本，DOM 兜底
- 面板新增模型切换按钮

### v2.2
- WebSocket 拦截核心逻辑稳定版
- DOM 轮询 + MutationObserver 双重检测
- 浏览器通知 + 标题闪烁 + 提示音三重提醒
- 智能去重与页面过滤

---

## ⚖️ 免责声明

本脚本仅用于辅助提醒，AI 参考答案仅供参考，请独立判断后作答。请遵守所在院校的学术诚信规范，合理使用。

---

## 📄 License

MIT © [Shy](https://github.com/shy7890)
