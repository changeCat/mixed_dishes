# proxy-rule

基于 Cloudflare Workers 与 Telegram Bot 的规则管理脚本，用于维护 `PROXY` / `DIRECT` 两类规则列表，并通过 HTTP 接口输出规则文件。

## 功能特性

- 支持 Telegram 指令管理规则
- 支持批量执行 `set`、`move`、`delete`
- 统一规则解析与标准化，便于后续扩展新命令
- 自动去重：同一域名只会保留一条最终规则
- 启动时兼容读取 KV 中的旧数据，遇到异常规则行会自动忽略并在处理结果中提示
- 支持通过 HTTP 获取当前规则列表

## 文件说明

- [`proxyRule.js`](./proxyRule.js)：Cloudflare Worker 主脚本

## 环境变量 / 绑定要求

在 Cloudflare Worker 中至少需要配置以下内容：

### 1. 环境变量

- `TELEGRAM_BOT_TOKEN`
  - Telegram Bot Token
- `AUTHORIZED_USERS`
  - 允许操作机器人的 Telegram 用户 ID 列表，多个用户使用英文逗号分隔
  - 示例：`123456789,987654321`
- `SUPPORTED_TYPES`（可选）
  - 支持的规则类型数组
  - 未配置时默认使用：`DOMAIN`、`DOMAIN-SUFFIX`、`DOMAIN-KEYWORD`

### 2. KV 绑定

需要绑定一个 KV Namespace，并在代码中以 `RULE_STORE` 名称访问。

KV 中会使用以下两个 Key：

- `proxy_rules`
- `direct_rules`

## HTTP 接口

部署后可通过以下接口直接获取规则文本：

- `/proxyList.list`
  - 返回 `proxy_rules` 内容
- `/directList.list`
  - 返回 `direct_rules` 内容

当列表为空时，会返回对应的空列表提示。

## Telegram 命令说明

### `/start`

显示帮助说明。

### `/proxyList`

查看当前 `PROXY` 列表。

### `/directList`

查看当前 `DIRECT` 列表。

### `/set`

批量新增或修改规则。

格式：

```text
/set
<类型>,<域名>,<PROXY|DIRECT>
<类型>,<域名>,<PROXY|DIRECT>
```

示例：

```text
/set
DOMAIN,google.com,PROXY
DOMAIN-SUFFIX,openai.com,DIRECT
```

行为说明：

- 如果域名不存在，则新增
- 如果域名已存在，则会先从两个列表中移除旧规则，再写入新规则
- 可用于同时修改规则类型和归属列表

### `/move`

批量移动规则所在列表，不改变原规则类型。

格式：

```text
/move
<域名>,<PROXY|DIRECT>
<域名>,<PROXY|DIRECT>
```

示例：

```text
/move
google.com,DIRECT
openai.com,PROXY
```

行为说明：

- 仅移动列表归属
- 规则类型保持不变
- 如果域名不存在，会在结果中提示失败

### `/delete`

批量删除规则。

格式：

```text
/delete
<域名>
<域名>
```

示例：

```text
/delete
google.com
openai.com
```

行为说明：

- 会同时在 `PROXY` 与 `DIRECT` 中查找
- 找到即删除
- 未找到会在结果中提示

## 优化说明

本次优化后的 [`proxyRule.js`](./proxyRule.js) 主要包含以下改进：

### 1. 拆分职责，便于后续新增功能

将原有逻辑拆分为多组独立函数：

- Telegram API 请求封装
- 规则解析与标准化
- 列表读写与内存处理
- 普通命令处理
- 批量命令处理

这样后续如果要新增例如 `/find`、`/import`、`/export`、`/stats` 等功能，可以直接复用现有规则解析和 KV 读写能力。

### 2. 修复潜在 bug

#### Telegram 消息发送结果处理更稳健

旧版本 [`proxyRule.js`](./proxyRule.js) 中 [`sendMessage()`](./proxyRule.js) 直接返回 `fetch` 响应，业务层需要自己判断是否成功；同时 [`editMessage()`](./proxyRule.js) 也没有校验 Telegram API 返回体。

优化后统一通过 Telegram API 封装函数处理：

- 检查 HTTP 状态码
- 检查 Telegram 返回的 `ok` 字段
- 在异常时抛出明确错误，便于排查问题

#### 避免污染 `env`

旧版本会把 `ctx.waitUntil` 挂到 `env` 上再向下传递。优化后直接通过参数传递 `waitUntil`，避免修改运行时对象带来的隐患。

#### 修复旧规则中异常行导致的兼容性问题

旧版本直接按文本分行处理，如果 KV 中存在格式错误的历史数据，后续逻辑可能出现不可预测行为。

优化后：

- 读取时统一解析规则
- 非法行自动跳过
- 在执行结果中提示检测到的异常规则
- 保存时只写回有效规则

#### 去重与覆盖逻辑更明确

旧版本通过字符串后缀匹配删除旧规则，逻辑可读性和扩展性较弱。

优化后使用 `Map<domain, rule>` 按域名管理规则，具备以下好处：

- 同域名天然去重
- 查找 / 删除 / 覆盖更直接
- 便于以后扩展更多字段

### 3. 数据处理结构更利于扩展

目前命令处理已经拆分为：

- `processSetCommand`
- `processMoveCommand`
- `processDeleteCommand`

如果以后新增命令，保持同样结构即可，不需要在一个大函数里继续堆积判断分支。

## 使用建议

### 1. 首次部署后配置 Telegram Webhook

将 Telegram Webhook 指向：

```text
https://你的-worker-域名/bot<TELEGRAM_BOT_TOKEN>
```

### 2. 建议初始化空规则

可先在 KV 中写入空字符串，或者直接在首次使用 `/set` 时由程序自动创建内容。

### 3. 建议保留统一书写规范

例如：

- 类型统一大写
- 列表名统一使用 `PROXY` / `DIRECT`
- 每条规则仅管理一个域名

虽然程序已做标准化处理，但保持输入一致性更利于长期维护。

## 后续扩展方向

基于当前结构，后续可以较容易增加：

- 按域名查询规则
- 导入整段规则文本
- 导出 JSON / YAML
- 增加操作日志
- 增加管理员命令分级
- 增加规则类型校验策略

## 部署说明

将 [`proxyRule.js`](./proxyRule.js) 部署到 Cloudflare Workers，并绑定：

- 环境变量
- `RULE_STORE` KV Namespace
- Telegram Webhook

完成后即可通过 Telegram 管理规则，并通过 HTTP 接口对外提供规则列表。