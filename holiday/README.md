# holiday Worker 使用说明

[`holiday/holiday.js`](holiday/holiday.js) 是一个运行在 Cloudflare Workers 上的节假日管理与查询服务，包含管理后台、登录鉴权、节假日数据存储、时区设置，以及对外开放的节假日查询接口。

## 功能概览

当前 [`holiday/holiday.js`](holiday/holiday.js) 提供以下功能：

- 节假日管理后台页面
- 登录 / 登出
- 新增或覆盖某一年的节假日数据
- 直接查看和编辑指定年份的 JSON 数据
- 删除指定年份的节假日数据
- 设置系统时区
- 公开查询接口：
  - `/open/dateInfo`
  - `/open/yearInfo`
  - `/open/monthInfo`
- API 调用次数统计展示

## 运行环境

该脚本面向 Cloudflare Workers。

### 需要绑定的变量

在 Worker 中至少需要配置以下环境变量与 KV：

- `HOLIDAYS_KV`
- `USERNAME`
- `PASSWORD`

其中：

- `HOLIDAYS_KV`：用于存储节假日数据和系统设置
- `USERNAME`：后台登录用户名
- `PASSWORD`：后台登录密码

## KV 数据说明

[`holiday/holiday.js`](holiday/holiday.js) 会在 [`HOLIDAYS_KV`](holiday/holiday.js) 中使用以下数据：

### 1. 节假日数据

按年份存储，key 格式为：

- `holiday_2025`
- `holiday_2026`

value 为 JSON 字符串，结构示例：

```json
[
  {
    "name": "元旦",
    "startDate": "2025-01-01",
    "endDate": "2025-01-01",
    "daysOff": 1,
    "workAdjustmentDates": []
  },
  {
    "name": "春节",
    "startDate": "2025-01-28",
    "endDate": "2025-02-04",
    "daysOff": 8,
    "workAdjustmentDates": ["2025-01-26", "2025-02-08"]
  }
]
```

字段说明：

- `name`：节假日名称
- `startDate`：放假开始日期，格式 `YYYY-MM-DD`
- `endDate`：放假结束日期，格式 `YYYY-MM-DD`
- `daysOff`：放假天数
- `workAdjustmentDates`：调休上班日期数组

### 2. 系统设置

固定 key：`system_setting`

示例：

```json
{
  "time_zone": "Asia/Shanghai",
  "call_counters": {
    "dateInfo": 10,
    "yearInfo": 3,
    "monthInfo": 5
  }
}
```

字段说明：

- `time_zone`：系统当前使用的时区
- `call_counters`：开放接口调用计数

## 页面路由说明

### 1. 管理首页

路径：`/`

功能：

- 查看已保存的年度节假日数据
- 查看 API 调用统计
- 登录后可进行新增、删除、编辑等操作

### 2. 登录页

路径：`/login`

功能：

- 输入用户名和密码登录后台
- 登录成功后会写入 cookie

### 3. 登出

路径：`/logout`

功能：

- 清除登录状态
- 返回首页

### 4. 设置页

路径：`/settings`

功能：

- 选择系统时区
- 保存后影响默认日期、默认年份、默认月份等查询行为

## 后台管理使用方法

### 1. 登录后台

1. 打开 `/login`
2. 输入配置好的 `USERNAME` 和 `PASSWORD`
3. 登录成功后返回 `/`

### 2. 新增或更新某一年节假日

在首页点击“设置节假日”按钮，填写：

- 年份
- 节假日原始文本

提交后，[`parseHolidayText()`](holiday/holiday.js:329) 会将文本解析为 JSON 并写入 KV。

适合输入类似国务院办公厅节假日通知正文的内容，例如：

```text
一、元旦：1月1日(周三)放假1天，不调休。
二、春节：1月28日(农历除夕、周二)至2月4日(农历正月初七、周二)放假调休，共8天。1月26日(周日)、2月8日(周六)上班。
三、清明节：4月4日(周五)至6日(周日)放假，共3天。
四、劳动节：5月1日(周四)至5日(周一)放假调休，共5天。4月27日(周日)上班。
```

### 3. 查看某一年的详细 JSON

首页列表中点击“查看详情”，可查看该年份当前保存的完整 JSON 数据。

### 4. 直接编辑 JSON

登录后，在详情弹窗中点击“编辑JSON”：

- 可直接修改当前年份的原始 JSON
- 点击“保存修改”后写回 KV

要求：

- JSON 必须合法
- 顶层必须是数组
- 每一项应尽量符合当前数据结构

### 5. 删除某一年数据

登录后，在首页点击对应年份的“删除”按钮即可删除该年份数据。

## 开放接口说明

以下接口无需登录即可访问。

---

### 1. 查询某一天信息

路径：`/open/dateInfo`

参数：

- `date`：可选，格式 `YYYY-MM-DD`

如果不传 `date`，则使用当前系统时区下的当天日期。

#### 示例

```text
/open/dateInfo?date=2025-10-01
```

#### 返回示例

```json
{
  "date": "2025-10-01",
  "week": "周三",
  "isWorkDay": 0,
  "isOfficialHoliday": 1,
  "isWorkAdjustmentDay": 0,
  "holidayName": "国庆节、中秋节"
}
```

#### 字段说明

- `date`：查询日期
- `week`：星期几
- `isWorkDay`：是否工作日，`1` 表示是，`0` 表示否
- `isOfficialHoliday`：是否法定/配置假日，`1` 表示是，`0` 表示否
- `isWorkAdjustmentDay`：是否调休上班日，`1` 表示是，`0` 表示否
- `holidayName`：节日名称、周末或调休说明

---

### 2. 查询某一年的全部节假日

路径：`/open/yearInfo`

参数：

- `year`：可选，格式 `YYYY`

如果不传 `year`，则使用当前系统时区下的年份。

#### 示例

```text
/open/yearInfo?year=2025
```

#### 返回示例

```json
[
  {
    "name": "元旦",
    "startDate": "2025-01-01",
    "endDate": "2025-01-01",
    "daysOff": 1,
    "workAdjustmentDates": []
  }
]
```

---

### 3. 查询某个月涉及的节假日

路径：`/open/monthInfo`

参数：

- `month`：可选，格式 `YYYY-MM`

如果不传 `month`，则使用当前系统时区下的月份。

#### 示例

```text
/open/monthInfo?month=2025-10
```

#### 返回说明

返回与该月份有重叠的节假日数组，包括：

- 开始日期落在该月内的节假日
- 结束日期落在该月内的节假日
- 跨越该月的节假日

## 接口返回状态说明

[`handleDateInfo()`](holiday/holiday.js:1609)、[`handleYearInfo()`](holiday/holiday.js:1689)、[`handleMonthInfo()`](holiday/holiday.js:1714) 以及保存类接口会根据情况返回不同状态码。

常见情况：

- `200`：请求成功
- `400`：参数格式错误或提交内容不合法
- `401`：未登录访问受保护接口
- `404`：未找到对应年份数据或路由不存在
- `500`：服务内部错误或 KV 中数据格式异常

## 时区说明

系统支持在设置页选择时区。

时区会影响：

- `/open/dateInfo` 未传 `date` 时的默认日期
- `/open/yearInfo` 未传 `year` 时的默认年份
- `/open/monthInfo` 未传 `month` 时的默认月份
- 日期对应的星期显示

相关逻辑见 [`getTimeZone()`](holiday/holiday.js:1412) 与 [`getCurrentDateInTimeZone()`](holiday/holiday.js:1422)。

## 节假日文本解析说明

当通过后台文本方式录入时，[`parseHolidayText()`](holiday/holiday.js:329) 会尝试解析：

- 节日名称
- 起止日期
- 放假天数
- 调休上班日期

适合解析包含类似以下格式的通知内容：

- `一、元旦：1月1日(周三)放假1天，不调休。`
- `二、春节：1月28日至2月4日放假调休，共8天。1月26日、2月8日上班。`
- `三、清明节：4月4日至6日放假，共3天。`

如果原始文本格式特殊，建议先解析后在后台通过 JSON 编辑功能进行人工校正。

## 部署提示

部署 [`holiday/holiday.js`](holiday/holiday.js) 到 Cloudflare Workers 时，请确保：

1. 已绑定 `HOLIDAYS_KV`
2. 已设置 `USERNAME`
3. 已设置 `PASSWORD`
4. 路由已正确指向当前 Worker

## 使用建议

- 推荐先通过后台录入某一年的通知文本，再检查生成的 JSON 是否正确
- 如遇个别节日解析不完整，可直接用后台 JSON 编辑进行修正
- 若只需要查询接口，可录入数据后直接调用 `/open/...` 路由
- 建议定期备份 KV 中的年度节假日数据
