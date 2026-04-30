# Telegram Bot ReMSG Worker

## 1. 功能说明

[`tgBotReMSG.js`](tgBotReMSG.js) 是一个基于 Cloudflare Workers 的 Telegram Bot 消息标记与拉取脚本。

它实现的流程如下：

1. Telegram Bot 继续按 webhook 方式接收消息。
2. 当你想“标记”某条消息时，直接**回复那条原消息**并发送 [`/remsg`](tgBotReMSG.js:126)。
3. Worker 收到这条回复命令后，会把“被回复的原消息”记录到待拉取列表中。
4. 外部系统请求 [`GET /marked`](tgBotReMSG.js:26) 时，接口只返回“原消息数组”，不再返回额外包装字段。
5. Worker 成功返回这些原消息后，会删除这些“标记记录”，但**不会删除 Telegram 原消息**。

也就是说：

- Telegram 原始消息仍保留在群里或私聊里。
- 只清除 Worker 内部的“待拉取标记”。
- 拉取接口只返回原消息数组，便于下游系统直接消费。

---

## 2. 文件位置

主程序文件：[`tg/bot-remsg/tgBotReMSG.js`](tgBotReMSG.js)

部署方式改为：**直接复制 [`tgBotReMSG.js`](tgBotReMSG.js) 内容，到 Cloudflare Workers 控制台中创建并发布。**

---

## 3. 需要准备的内容

在部署前，需要准备以下内容：

### 3.1 Telegram Bot Token

通过 Telegram 的 BotFather 创建机器人，拿到 token。

环境变量名：`BOT_TOKEN`

### 3.2 Webhook Secret（可选）

用于校验 Telegram 发给 Worker 的 webhook 是否可信。

环境变量名：`BOT_SECRET`

如果不配置，Worker 也可以运行，但安全性会弱一些。

### 3.3 拉取接口鉴权 Token

外部系统访问 [`/marked`](tgBotReMSG.js:26) 时使用。

环境变量名：`PULL_TOKEN`

支持两种方式传递：

1. 请求头：`Authorization: Bearer your_token`
2. 查询参数：`?token=your_token`

### 3.4 Cloudflare KV（推荐）

推荐绑定一个 KV 命名空间，用来持久化保存已标记消息。

绑定名：`REMSG_KV`

如果不绑定 KV，脚本会退回使用内存存储。这样在 Worker 实例重启后，标记数据可能丢失，不适合正式环境。

---

## 4. 通过 Cloudflare 控制台直接部署

### 4.1 登录 Cloudflare

打开 Cloudflare 控制台，进入 [`Workers & Pages`](https://dash.cloudflare.com/)。

### 4.2 创建 Worker

1. 点击创建 Worker。
2. 选择从 Hello World 或默认模板进入编辑界面。
3. 将编辑器中的默认代码全部删除。
4. 把 [`tg/bot-remsg/tgBotReMSG.js`](tgBotReMSG.js) 的完整内容复制进去。
5. 点击保存。

### 4.3 发布 Worker

点击 Cloudflare 页面中的“部署”或“保存并部署”，发布后会生成一个 Worker 地址，例如：

```text
https://tg-bot-remsg.<your-subdomain>.workers.dev
```

后文统一称为：

```text
https://your-worker.workers.dev
```

---

## 5. 配置环境变量与 KV 绑定

在 Cloudflare Worker 的设置页面中，进入变量配置。

### 5.1 配置 Secrets / Variables

在 Worker 设置里添加以下变量：

- `BOT_TOKEN`：Telegram Bot Token
- `BOT_SECRET`：可选，Telegram webhook secret
- `PULL_TOKEN`：拉取 `/marked` 接口时使用的鉴权 token

Cloudflare 面板中通常可以在 Worker 的 [`Settings > Variables`](https://dash.cloudflare.com/) 页面配置。

建议：

- [`BOT_TOKEN`](tgBotReMSG.js:227) 使用 Secret
- [`BOT_SECRET`](tgBotReMSG.js:47) 使用 Secret
- [`PULL_TOKEN`](tgBotReMSG.js:172) 使用 Secret

### 5.2 配置 KV（推荐）

如果你希望标记数据持久化保存：

1. 在 Cloudflare 控制台创建一个 KV Namespace。
2. 回到 Worker 设置页面。
3. 在绑定中添加 KV。
4. 绑定名称填写：`REMSG_KV`
5. 选择你刚创建的 KV Namespace。

如果不绑定 [`REMSG_KV`](tgBotReMSG.js:189)，脚本会使用内存存储，仅适合测试。

---

## 6. 设置 Telegram Webhook

脚本中提供了 [`POST /telegram/setWebhook`](tgBotReMSG.js:30) 接口，可以直接调用来设置 Telegram webhook。

### 6.1 请求示例

```powershell
Invoke-RestMethod -Method Post `
  -Uri "https://your-worker.workers.dev/telegram/setWebhook" `
  -ContentType "application/json" `
  -Body '{"url":"https://your-worker.workers.dev/telegram/webhook"}'
```

设置成功后，Telegram 会把消息推送到 [`/telegram/webhook`](tgBotReMSG.js:22)。

### 6.2 也可以直接调用 Telegram 官方接口

```text
https://api.telegram.org/bot<你的BOT_TOKEN>/setWebhook?url=https://your-worker.workers.dev/telegram/webhook
```

如果配置了 [`BOT_SECRET`](tgBotReMSG.js:47)，脚本会自动在内部设置 [`secret_token`](tgBotReMSG.js:105)。

---

## 7. 使用方法

### 7.1 标记某条消息

在 Telegram 群组或私聊里：

1. 找到你要标记的原消息。
2. **回复这条消息**。
3. 发送：`/remsg`

脚本会检查：

- 这条消息是不是 [`/remsg`](tgBotReMSG.js:126)
- 它是否带有 [`reply_to_message`](tgBotReMSG.js:67)

满足条件后，Worker 会把“被回复的那条原消息”保存起来。

### 7.2 拉取已标记消息

外部系统请求：

```text
GET https://your-worker.workers.dev/marked
```

带 `Bearer Token` 的 PowerShell 示例：

```powershell
Invoke-RestMethod -Method Get `
  -Uri "https://your-worker.workers.dev/marked" `
  -Headers @{ Authorization = "Bearer your_pull_token" }
```

或使用查询参数：

```text
https://your-worker.workers.dev/marked?token=your_pull_token
```

返回结果将是一个 JSON 数组，每一项都是被标记的**原始 Telegram 消息对象**。

---

## 8. 返回结果示例

[`GET /marked`](tgBotReMSG.js:26) 返回示例：

```json
[
  {
    "message_id": 456,
    "from": {
      "id": 654321,
      "is_bot": false,
      "first_name": "Source",
      "username": "source_user",
      "language_code": "zh-hans"
    },
    "chat": {
      "id": -1001234567890,
      "title": "test-group",
      "type": "supergroup"
    },
    "date": 1711111111,
    "text": "这是被标记的原消息"
  }
]
```

说明：

- 返回值是数组，不是对象。
- 数组中的每一项，都是原始 Telegram 消息内容。
- 不再返回 `ok`、`count`、`items`、`markCommand` 等包装字段。

---

## 9. 拉取后删除标记的机制

[`handleMarkedPull()`](tgBotReMSG.js:89) 的逻辑是：

1. 先读取当前所有已标记消息。
2. 提取每条记录中的原始消息 [`targetMessage.raw`](tgBotReMSG.js:154)。
3. 将这些原始消息组成数组直接返回。
4. 在返回前，逐条调用 [`deleteMarkedItem()`](tgBotReMSG.js:212) 删除对应标记。

因此效果是：

- 本次请求会拿到当前所有积累的原消息数组。
- 返回成功后，这些消息不会在下次 [`/marked`](tgBotReMSG.js:26) 再次出现。
- Telegram 原消息不会被删除。

注意：当前实现属于“读取即清空”模型。如果你的下游系统在拿到响应后处理失败，需要它自己做重试或二次入库。

---

## 10. 代码中的关键函数

### 10.1 webhook 入口

- [`handleTelegramWebhook()`](tgBotReMSG.js:46)

负责：

- 校验 Telegram webhook secret
- 接收更新数据
- 判断是否为标记命令
- 保存被标记的原消息

### 10.2 标记命令判断

- [`isMarkCommand()`](tgBotReMSG.js:121)

目前只允许一种标记方式：`/remsg`

### 10.3 拉取已标记消息

- [`handleMarkedPull()`](tgBotReMSG.js:89)

负责：

- 校验拉取请求 token
- 返回所有标记消息对应的原始消息数组
- 返回后删除标记记录

### 10.4 存储与删除

- [`saveMarkedItem()`](tgBotReMSG.js:183)
- [`listMarkedItems()`](tgBotReMSG.js:193)
- [`deleteMarkedItem()`](tgBotReMSG.js:212)

---

## 11. 常见问题

### 11.1 为什么我发送 `/remsg` 没有入库？

通常有以下几种原因：

1. 你不是“回复原消息”发送的，而是直接单独发送了 [`/remsg`](tgBotReMSG.js:126)
2. Telegram webhook 没有正确设置到 [`/telegram/webhook`](tgBotReMSG.js:22)
3. [`BOT_SECRET`](tgBotReMSG.js:47) 配置了，但 Telegram 请求头不匹配
4. Worker 没有配置 [`BOT_TOKEN`](tgBotReMSG.js:227)

### 11.2 为什么 `/marked` 返回空数组？

可能原因：

1. 还没有任何消息被成功标记
2. 之前已经拉取过一次，标记已被清空
3. 没有使用 KV，Worker 实例重启后内存数据丢失

### 11.3 为什么推荐使用 KV？

因为内存存储只适合测试环境。正式环境中，Cloudflare Worker 可能会重启、切换实例或回收内存，这时 [`MEMORY_STORE`](tgBotReMSG.js:17) 中的数据无法保证保留。

---

## 12. 推荐的生产使用方式

正式环境建议：

1. 使用 [`REMSG_KV`](tgBotReMSG.js:189) 持久化存储。
2. 配置 [`BOT_SECRET`](tgBotReMSG.js:47) 提高 webhook 安全性。
3. 配置 [`PULL_TOKEN`](tgBotReMSG.js:172) 保护 [`/marked`](tgBotReMSG.js:26) 拉取接口。
4. 下游系统在拉取后立即保存数据，避免因“读取即清空”导致遗漏。

---

## 13. 最简操作步骤

如果你只想最快跑起来，可以按下面顺序：

1. 准备好 Telegram Bot Token。
2. 登录 Cloudflare 控制台，创建一个 Worker。
3. 复制 [`tgBotReMSG.js`](tgBotReMSG.js) 内容到 Worker 编辑器并发布。
4. 在 Worker 设置中配置 `BOT_TOKEN`、`PULL_TOKEN`。
5. 如需更安全，可补充配置 `BOT_SECRET`。
6. 如需持久化，可绑定 `REMSG_KV`。
7. 调用 [`POST /telegram/setWebhook`](tgBotReMSG.js:30) 设置 webhook。
8. 在 Telegram 中回复某条消息并发送 `/remsg`。
9. 外部系统调用 [`GET /marked`](tgBotReMSG.js:26) 获取原消息数组。

---

## 14. 当前实现总结

当前脚本已经满足以下要求：

- Telegram Bot 接收推送消息
- 通过单一命令 [`/remsg`](tgBotReMSG.js:126) 标记目标消息
- 请求 URL 获取已标记原消息数组
- 返回成功后清除标记
- 保留 Telegram 原消息不删除
