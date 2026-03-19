/**
 * Cloudflare Worker Telegram Bot (结构优化版)
 * 目标：在保留 v1 功能与 UI 表现的前提下，进一步优化模块边界、复用逻辑与可维护性。
 */

export default {
  async fetch(request, env, ctx) {
    if (request.method === "POST") {
      try {
        const payload = await request.json();
        const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");

        if (env.TG_BOT_SECRET && secret !== env.TG_BOT_SECRET) {
          return new Response("Unauthorized", { status: 403 });
        }

        ctx.waitUntil(handleUpdate(payload, env, ctx));
        return new Response("OK", { status: 200 });
      } catch (_error) {
        return new Response("Error", { status: 500 });
      }
    }

    return new Response("Bot is running.", { status: 200 });
  },
};

// ==========================================
// ⚙️ 常量与内存态缓存
// ==========================================

// 统一维护各类超时、分页、并发、按钮布局等基础配置。
const CONST = {
  GROUP_LOCK_TTL_MS: 60 * 1000,
  NO_KV_CACHE_TTL_MS: 10 * 60 * 1000,
  CACHE_PRUNE_INTERVAL_MS: 2 * 60 * 1000,
  BATCH_WAIT_WITH_KV_MS: 800,
  BATCH_WAIT_NO_KV_MS: 600,
  TELEGRAM_TIMEOUT_MS: 12 * 1000,
  HTTP_TIMEOUT_MS: 20 * 1000,
  DELETE_API_TIMEOUT_MS: 8 * 1000,
  AUTO_DELETE_DELAY_MS: 7 * 1000,
  KV_DELETE_PARALLEL: 20,
  BROWSE_PAGE_SIZE: 6,
  UPLOAD_PANEL_CHANNELS_PER_ROW: 3,
  UPLOAD_PANEL_DIRS_PER_ROW: 2,
  DIRECTORY_PANEL_DIRS_PER_ROW: 2,
  RANDOM_DIRS_PER_ROW: 2,
};

// Telegram Bot API 根地址。
const TELEGRAM_API_BASE = "https://api.telegram.org";
// 访问图床及随机接口时使用的默认 UA。
const TELEGRAM_USER_AGENT = "TelegramBot/1.0";
// 未配置渠道列表时的默认渠道配置。
const DEFAULT_CHANNELS = "TG:telegram";
// 上传时兜底使用的渠道编码。
const DEFAULT_UPLOAD_CHANNEL = "telegram";
// 上传目录未指定时的默认目录名称。
const DEFAULT_DIR = "default";

// 统一收敛界面文案，避免散落硬编码。
const UI_TEXT = {
  pendingAlbum: "⏳ **正在接收并合并相册，请稍候...**",
  pendingAlbumNoKv: "⏳ **正在缓冲相册队列 (无 KV 模式)...**",
  batchModeChoose: "📚 **收到一组文件**\n请选择处理方式：",
  batchUnifiedConfig: "📦 <b>[批量统一]</b> 请确认渠道并选择目录：",
  unifiedUploadConfig: "⚙️ **上传配置**\n检测到链接/文件，请选择目录上传：",
  directoryBrowser: "📂 **图床文件管理**\n请选择要浏览的目录：",
  randomLoading: "⏳ <b>正在随机抽取...</b>",
  randomPickDir: "📂 <b>请选择随机范围：</b>",
};

// 相册处理锁，防止同一 media_group 被重复展开。
const groupLocks = new Map();
// 相册处理锁的自动释放定时器。
const groupLockTimers = new Map();
// 未接入 KV 时，相册消息的临时内存缓存。
const noKvCache = new Map();
// 未接入 KV 时，对应缓存的过期定时器。
const noKvCacheTimers = new Map();
// 未接入 KV 时，记录缓存最近一次活跃时间。
const noKvCacheTouchedAt = new Map();
// 对 env 解析后的配置缓存，减少重复 split/trim。
const envConfigCache = new WeakMap();
// 上次清理内存缓存的时间戳。
let lastCachePruneAt = 0;

// 私聊场景下注册给 Telegram 的命令列表。
const COMMANDS_PRIVATE = [
  { command: "list", description: "📂 浏览图床目录" },
  { command: "random", description: "🎲 随机图面板" },
  { command: "reset", description: "🔄 重置上传缓存" },
  { command: "init", description: "⚙️ 刷新命令菜单" },
];

// 群聊/频道场景下注册给 Telegram 的命令列表。
const COMMANDS_PUBLIC = [
  { command: "info", description: "ℹ️ 查看消息元数据" },
  { command: "delete", description: "🗑 删除文件" },
];

// ==========================================
// 🧰 通用工具
// ==========================================

/** 延迟指定毫秒，常用于等待相册消息收齐。 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 按固定大小切分数组，便于控制 KV 删除并发。 */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** 生成随机字符串，用于临时文件名或兜底标识。 */
function randomString(len) {
  return Math.random().toString(36).substring(2, 2 + len);
}

/** 转义 HTML 特殊字符，避免 Telegram HTML 模式下文本被错误解析。 */
function escapeHtml(text) {
  const amp = String.fromCharCode(38);
  const ampEntity = String.fromCharCode(38, 97, 109, 112, 59);
  const ltEntity = String.fromCharCode(38, 108, 116, 59);
  const gtEntity = String.fromCharCode(38, 103, 116, 59);
  const quoteEntity = String.fromCharCode(38, 113, 117, 111, 116, 59);
  const apostropheEntity = String.fromCharCode(38, 35, 51, 57, 59);

  return String(text ?? ``)
    .split(amp).join(ampEntity)
    .split(String.fromCharCode(60)).join(ltEntity)
    .split(String.fromCharCode(62)).join(gtEntity)
    .split(String.fromCharCode(34)).join(quoteEntity)
    .split(String.fromCharCode(39)).join(apostropheEntity);
}

/** 统一输出错误日志，便于按 scope 排查。 */
function logError(scope, error, extra = null) {
  const msg = error && error.message ? error.message : String(error);
  if (extra) {
    console.error(`[${scope}] ${msg}`, extra);
  } else {
    console.error(`[${scope}] ${msg}`);
  }
}

/** 安全解析 JSON，失败时返回备用值。 */
function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

/** 组装 Telegram API 方法地址。 */
function buildTelegramUrl(env, method) {
  return `${TELEGRAM_API_BASE}/bot${env.TG_BOT_TOKEN}/${method}`;
}

/** 解析渠道配置字符串，转成按钮与上传可复用的结构。 */
function parseChannels(rawChannelList) {
  const raw = rawChannelList || DEFAULT_CHANNELS;
  const list = raw.split(",").map(item => item.trim()).filter(Boolean);

  if (list.length === 0) {
    return [{ name: "TG", value: DEFAULT_UPLOAD_CHANNEL }];
  }

  return list.map(item => {
    const [nameRaw, providerRaw, subChannelRaw] = item.split(":");
    const name = nameRaw ? nameRaw.trim() : "Unknown";
    const provider = providerRaw ? providerRaw.trim() : name;
    const subChannel = subChannelRaw ? subChannelRaw.trim() : null;
    const value = subChannel ? `${provider}|${subChannel}` : provider;
    return { name, value };
  });
}

/** 解析目录配置字符串，得到目录列表。 */
function parseDirs(rawDirList) {
  return (rawDirList || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

/** 解析并缓存 env 中的渠道、目录、白名单配置。 */
function getEnvConfig(env) {
  const rawChannels = env.CHANNEL_LIST || "";
  const rawDirs = env.DIR_LIST || "";
  const rawUsers = env.ALLOWED_USERS || "";
  const fingerprint = `${rawChannels}\n${rawDirs}\n${rawUsers}`;

  const cached = envConfigCache.get(env);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.value;
  }

  const value = {
    channels: parseChannels(rawChannels),
    dirs: parseDirs(rawDirs),
    allowedUsers: new Set((rawUsers || "").split(",").map(id => id.trim())),
  };

  envConfigCache.set(env, { fingerprint, value });
  return value;
}

/** 获取当前环境下可用的上传渠道列表。 */
function getChannels(env) {
  return getEnvConfig(env).channels;
}

/** 获取当前环境下可用的目录列表。 */
function getDirs(env) {
  return getEnvConfig(env).dirs;
}

/** 判断消息发送者是否在允许名单中。 */
function isUserAllowed(userId, env) {
  return getEnvConfig(env).allowedUsers.has(String(userId));
}

/** 获取默认上传渠道，通常取渠道列表第一项。 */
function getDefaultChannelValue(env) {
  const channels = getChannels(env);
  return (channels[0] && channels[0].value) || DEFAULT_UPLOAD_CHANNEL;
}

/** 包装 Telegram inline keyboard 数据结构。 */
function createInlineKeyboard(rows) {
  return { inline_keyboard: rows };
}

/** 解析 callback_data 中的固定前缀与参数片段。 */
function parseCallbackParts(data, prefix) {
  return String(data || "").slice(prefix.length).split(":");
}

/** 从 Telegram update 中提取统一上下文，便于后续分发。 */
function getUpdateContext(update) {
  if (update.message) {
    return {
      type: "message",
      msg: update.message,
      chatId: update.message.chat.id,
      userId: update.message.from.id,
      chatType: update.message.chat.type,
    };
  }

  if (update.channel_post) {
    return {
      type: "channel_post",
      msg: update.channel_post,
      chatId: update.channel_post.chat.id,
      userId: update.channel_post.chat.id,
      chatType: "channel",
    };
  }

  if (update.callback_query) {
    return {
      type: "callback_query",
      query: update.callback_query,
    };
  }

  return null;
}

/** 根据文件名后缀推断 MIME 类型。 */
function getMimeType(fileName) {
  const ext = String(fileName || "").split(".").pop().toLowerCase();
  return {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    mov: "video/quicktime",
  }[ext] || "application/octet-stream";
}

/** 将字节数格式化为更适合展示的单位。 */
function formatFileSize(bytes) {
  const num = Number(bytes);
  if (isNaN(num) || num === 0) return "0 B";

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(num) / Math.log(k));

  if (i < 0) return `${num} B`;
  if (i >= sizes.length) return ">PB";
  return `${parseFloat((num / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/** 将时间戳转成东八区可读时间字符串。 */
function formatTimestamp(ts) {
  const num = Number(ts);
  if (isNaN(num) || num <= 0) return "Unknown Time";

  const date = new Date(num);
  const offset = 8 * 60 * 60 * 1000;
  const localDate = new Date(date.getTime() + offset);

  const y = localDate.getUTCFullYear();
  const m = String(localDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(localDate.getUTCDate()).padStart(2, "0");
  const h = String(localDate.getUTCHours()).padStart(2, "0");
  const min = String(localDate.getUTCMinutes()).padStart(2, "0");
  const s = String(localDate.getUTCSeconds()).padStart(2, "0");

  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

/** 从 Telegram 消息中提取文件信息，统一后续上传输入结构。 */
function getMediaInfo(msg) {
  if (!msg) return null;

  let fileId = null;
  let type = "document";
  let fileName = `tg_${Date.now()}_${randomString(5)}`;
  let isUrl = false;

  if (msg.photo && msg.photo.length > 0) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
    fileName += ".jpg";
    type = "photo";
  } else if (msg.video || msg.animation) {
    const media = msg.video || msg.animation;
    fileId = media.file_id;
    fileName += ".mp4";
    type = "video";
  } else if (msg.document) {
    fileId = msg.document.file_id;
    type = "document";
    if (msg.document.file_name) {
      fileName = `tg_${randomString(4)}_${msg.document.file_name}`;
    } else {
      fileName += ".dat";
    }
  } else {
    const text = msg.text || msg.caption || "";
    const urlMatch = text.match(/https?:\/\/[^\s]+/);

    if (urlMatch) {
      const url = urlMatch[0];
      isUrl = true;
      fileId = url;
      type = "photo";

      try {
        const urlObj = new URL(url);
        const pathName = urlObj.pathname.split("/").pop();
        if (pathName && pathName.includes(".")) {
          fileName = pathName;
        } else {
          const format = urlObj.searchParams.get("format");
          if (format) fileName += `.${format}`;
          else fileName += ".jpg";
        }
      } catch (_error) {
        fileName += ".jpg";
      }
    }
  }

  if (!fileId) return null;
  return { fileId, type, fileName, isUrl };
}

// ==========================================
// 🧠 缓存与锁
// ==========================================

/** 获取相册处理锁，避免同一组文件被并发重复处理。 */
function acquireGroupLock(groupId, ttlMs = CONST.GROUP_LOCK_TTL_MS) {
  const now = Date.now();
  const previous = groupLocks.get(groupId);

  if (previous && now - previous < ttlMs) {
    return false;
  }

  groupLocks.set(groupId, now);

  const oldTimer = groupLockTimers.get(groupId);
  if (oldTimer) clearTimeout(oldTimer);

  const timer = setTimeout(() => releaseGroupLock(groupId), ttlMs);
  groupLockTimers.set(groupId, timer);
  return true;
}

/** 释放相册处理锁并清理对应定时器。 */
function releaseGroupLock(groupId) {
  groupLocks.delete(groupId);
  const timer = groupLockTimers.get(groupId);
  if (timer) clearTimeout(timer);
  groupLockTimers.delete(groupId);
}

/** 刷新无 KV 模式下相册缓存的活跃时间。 */
function touchNoKvCache(groupId) {
  noKvCacheTouchedAt.set(groupId, Date.now());

  const oldTimer = noKvCacheTimers.get(groupId);
  if (oldTimer) clearTimeout(oldTimer);

  const timer = setTimeout(() => clearNoKvCache(groupId), CONST.NO_KV_CACHE_TTL_MS);
  noKvCacheTimers.set(groupId, timer);
}

/** 清理无 KV 模式的相册缓存，并同步释放锁。 */
function clearNoKvCache(groupId) {
  noKvCache.delete(groupId);
  noKvCacheTouchedAt.delete(groupId);

  const timer = noKvCacheTimers.get(groupId);
  if (timer) clearTimeout(timer);
  noKvCacheTimers.delete(groupId);

  releaseGroupLock(groupId);
}

/** 定时裁剪内存缓存，避免 Worker 常驻时缓存无限增长。 */
function pruneMemoryCaches() {
  const now = Date.now();
  if (now - lastCachePruneAt < CONST.CACHE_PRUNE_INTERVAL_MS) {
    return;
  }

  lastCachePruneAt = now;

  for (const [groupId, lockedAt] of groupLocks.entries()) {
    if (now - lockedAt > CONST.GROUP_LOCK_TTL_MS) {
      releaseGroupLock(groupId);
    }
  }

  for (const [groupId, touchedAt] of noKvCacheTouchedAt.entries()) {
    if (now - touchedAt > CONST.NO_KV_CACHE_TTL_MS) {
      clearNoKvCache(groupId);
    }
  }
}

// ==========================================
// 🌐 网络与 Telegram API 封装
// ==========================================

/** 对 fetch 增加超时控制，避免外部接口长时间挂起。 */
async function fetchWithTimeout(url, options = {}, timeoutMs = CONST.HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 统一封装 Telegram API 请求、超时与错误处理。 */
async function callTelegramApi(method, payload, env, opts = {}) {
  const timeoutMs = opts.timeoutMs || CONST.TELEGRAM_TIMEOUT_MS;
  const muteError = opts.muteError === true;

  try {
    const res = await fetchWithTimeout(
      buildTelegramUrl(env, method),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      timeoutMs,
    );

    const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));

    if (!res.ok || data.ok === false) {
      if (!muteError) {
        console.error(`[tg:${method}]`, data.description || `HTTP ${res.status}`);
      }
      return { ok: false, ...data };
    }

    return data;
  } catch (error) {
    const desc = error && error.name === "AbortError" ? "请求超时" : (error.message || String(error));
    if (!muteError) {
      console.error(`[tg:${method}]`, desc);
    }
    return { ok: false, description: desc };
  }
}

/** 发送普通文本消息。 */
async function sendTelegramMessage(chatId, text, env, extra = {}) {
  return callTelegramApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    ...extra,
  }, env, { muteError: true });
}

/** 编辑纯文本消息内容。 */
async function editMessageText(chatId, messageId, text, env, extra = {}) {
  return callTelegramApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...extra,
  }, env, { muteError: true });
}

/** 编辑媒体消息说明文字。 */
async function editMessageCaption(chatId, messageId, caption, env, extra = {}) {
  return callTelegramApi("editMessageCaption", {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: "Markdown",
    reply_markup: createInlineKeyboard([]),
    ...extra,
  }, env, { muteError: true });
}

/** 单独更新消息的内联按钮，不修改正文。 */
async function editMessageReplyMarkup(chatId, messageId, inlineKeyboard, env) {
  return callTelegramApi("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: createInlineKeyboard(inlineKeyboard),
  }, env, { muteError: true });
}

/** 删除指定聊天中的某条消息。 */
async function deleteMessage(chatId, messageId, env) {
  return callTelegramApi("deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  }, env, { muteError: true });
}

/** 应答按钮点击，避免 Telegram 客户端一直转圈。 */
async function answerCallbackQuery(id, text, env) {
  const payload = { callback_query_id: id };
  if (typeof text === "string" && text.length > 0) {
    payload.text = text;
  }
  return callTelegramApi("answerCallbackQuery", payload, env, { muteError: true });
}

/** 发送媒体消息，供图片/视频/文件面板复用。 */
async function sendTelegramMedia(method, payload, env) {
  return callTelegramApi(method, payload, env, { muteError: true });
}

/** 根据消息类型判断应该编辑文本还是 caption。 */
function getMessageEditMethod(message) {
  if (message && (message.photo || message.video || message.animation || message.document)) {
    return "editMessageCaption";
  }
  return "editMessageText";
}

/** 统一更新面板消息，自动兼容文本消息与媒体消息。 */
async function updatePanelMessage(chatId, message, content, env, extra = {}) {
  const method = getMessageEditMethod(message);
  const messageId = message.message_id;

  if (method === "editMessageCaption") {
    return callTelegramApi(method, {
      chat_id: chatId,
      message_id: messageId,
      caption: content,
      ...extra,
    }, env, { muteError: true });
  }

  return callTelegramApi(method, {
    chat_id: chatId,
    message_id: messageId,
    text: content,
    ...extra,
  }, env, { muteError: true });
}

/** 生成命令路由器，简化 if/else 命令分发。 */
function createCommandRouter(routes) {
  return async (text, context) => {
    for (const route of routes) {
      if (route.match(text, context)) {
        await route.handler(context);
        return true;
      }
    }
    return false;
  };
}

/** 生成 callback 路由器，集中管理按钮事件分发。 */
function createPrefixCallbackRouter(routes) {
  return async (data, context) => {
    for (const route of routes) {
      if (route.match(data, context)) {
        await route.handler(context);
        return true;
      }
    }
    return false;
  };
}

// ==========================================
// 🎹 UI 键盘构建
// ==========================================

/** 构建单文件/批量上传共用的渠道与目录选择面板。 */
function buildUnifiedKeyboard(channels, dirs, selectedChannel, isBatch) {
  const keyboard = [];
  let channelRow = [];

  channels.forEach(channel => {
    const isSelected = channel.value === selectedChannel;
    const icon = isSelected ? "✅" : "⬜";
    const label = `${icon} ${channel.name}`;
    const callbackData = `switch_chan:${channel.value}:${isBatch ? "batch" : "single"}`;

    channelRow.push({ text: label, callback_data: callbackData });
    if (channelRow.length === CONST.UPLOAD_PANEL_CHANNELS_PER_ROW) {
      keyboard.push(channelRow);
      channelRow = [];
    }
  });

  if (channelRow.length > 0) {
    keyboard.push(channelRow);
  }

  const actionPrefix = isBatch ? "batch_upload" : "upload";
  keyboard.push([
    {
      text: `📂 默认 (${DEFAULT_DIR})`,
      callback_data: `${actionPrefix}:${DEFAULT_DIR}:${selectedChannel}`,
    },
  ]);

  let dirRow = [];
  dirs.forEach((dir, index) => {
    dirRow.push({
      text: dir,
      callback_data: `${actionPrefix}:${dir}:${selectedChannel}`,
    });

    if (dirRow.length === CONST.UPLOAD_PANEL_DIRS_PER_ROW || index === dirs.length - 1) {
      keyboard.push(dirRow);
      dirRow = [];
    }
  });

  keyboard.push([
    { text: "❌ 取消操作", callback_data: isBatch ? "batch_cancel" : "upload_cancel" },
    { text: "🗑 关闭面板", callback_data: "close_panel" },
  ]);

  return keyboard;
}

/** 构建目录浏览入口面板。 */
function buildDirKeyboard(dirs, cmdId = "") {
  const keyboard = [];
  let row = [];

  dirs.forEach((dir, index) => {
    row.push({ text: `📂 ${dir}`, callback_data: `browse:${dir}:0:${cmdId}` });
    if (row.length === CONST.DIRECTORY_PANEL_DIRS_PER_ROW || index === dirs.length - 1) {
      keyboard.push(row);
      row = [];
    }
  });

  keyboard.push([{ text: "❌ 关闭面板", callback_data: `close_panel:${cmdId}` }]);
  return keyboard;
}

/** 构建随机图模块的目录切换面板。 */
function buildRandomDirKeyboard(dirs, currentDir, cmdId = "") {
  const keyboard = [];
  keyboard.push([
    {
      text: `${currentDir === "all" ? "✅ " : ""}🌟 所有目录 (All)`,
      callback_data: `rnd:set:all:${cmdId}`,
    },
  ]);

  let row = [];
  dirs.forEach((dir, index) => {
    row.push({
      text: `${dir === currentDir ? "✅ " : ""}${dir}`,
      callback_data: `rnd:set:${dir}:${cmdId}`,
    });

    if (row.length === CONST.RANDOM_DIRS_PER_ROW || index === dirs.length - 1) {
      keyboard.push(row);
      row = [];
    }
  });

  keyboard.push([{ text: "🔙 返回", callback_data: `rnd:next:${currentDir}:${cmdId}` }]);
  return keyboard;
}

/** 构建相册收到后选择统一/分别上传的面板。 */
function buildBatchModeKeyboard() {
  return [
    [{ text: "📦 统一上传 (推荐)", callback_data: "mode:unify" }],
    [{ text: "📑 分别上传 (繁琐)", callback_data: "mode:separate" }],
    [{ text: "❌ 取消", callback_data: "batch_cancel" }],
  ];
}

/** 构建无 KV 模式下的降级操作面板。 */
function buildNoKvKeyboard(groupId, count) {
  return [
    [{ text: `📑 分别单独上传 (${count}个文件)`, callback_data: `nokv_sep:${groupId}` }],
    [{ text: "❌ 取消本次上传", callback_data: `nokv_cancel:${groupId}` }],
  ];
}

/** 构建随机图查看面板。 */
function buildRandomViewerKeyboard(dir, cmdId = "") {
  return [
    [
      { text: "📂 切换目录", callback_data: `rnd:pick:${dir}:${cmdId}` },
      { text: "🔄 下一张", callback_data: `rnd:next:${dir}:${cmdId}` },
    ],
    [{ text: "🗑 关闭面板", callback_data: `close_panel:${cmdId}` }],
  ];
}

/** 构建随机图获取失败时的兜底按钮。 */
function buildRandomErrorKeyboard(dir, cmdId = "") {
  return [
    [{ text: "📂 切换目录", callback_data: `rnd:pick:${dir}:${cmdId}` }],
    [{ text: "🗑 关闭面板", callback_data: `close_panel:${cmdId}` }],
  ];
}

// ==========================================
// 📩 更新入口
// ==========================================

/** 统一分发 Telegram update，并在入口处顺带清理过期内存缓存。 */
async function handleUpdate(update, env, ctx) {
  pruneMemoryCaches();

  const context = getUpdateContext(update);
  if (!context) return;

  if (context.type === "callback_query") {
    await handleCallback(context.query, env, ctx);
    return;
  }

  const { msg, userId, chatId, chatType } = context;
  if (!isUserAllowed(userId, env)) {
    return;
  }

  const text = msg.text || msg.caption || "";

  if (chatType === "private") {
    await handlePrivateChatMessage(msg, text, chatId, env, ctx);
    return;
  }

  await handlePublicChatMessage(msg, text, chatId, env, ctx);
}

const handlePrivateCommand = createCommandRouter([
  {
    match: text => text === "/init",
    handler: async ({ chatId, env }) => {
      await handleInitCommand(chatId, env);
    },
  },
  {
    match: text => text.startsWith("/list"),
    handler: async ({ chatId, env, msg }) => {
      const dirs = getDirs(env);
      if (dirs.length === 0) {
        await sendTelegramMessage(chatId, "❌ 未配置 `DIR_LIST`", env);
        return;
      }
      await sendDirectoryBrowser(chatId, dirs, env, msg.message_id);
    },
  },
  {
    match: text => text === "/reset",
    handler: async ({ chatId, env }) => {
      await sendTelegramMessage(chatId, "⏳ 正在重置上传状态...", env);
      const count = await clearAllKV(env);
      await sendTelegramMessage(chatId, `✅ 上传已重置。\n🗑 已清理 ${count} 条临时缓存。`, env);
    },
  },
  {
    match: text => text === "/random",
    handler: async ({ chatId, env, msg }) => {
      await sendRandomPanel(chatId, "all", env, msg.message_id);
    },
  },
]);

/** 处理私聊消息，优先命令分发，其次进入单文件或相册上传流程。 */
async function handlePrivateChatMessage(msg, text, chatId, env, ctx) {
  const commandHandled = await handlePrivateCommand(text, { msg, text, chatId, env, ctx });
  if (commandHandled) {
    return;
  }

  const mediaInfo = getMediaInfo(msg);
  if (!mediaInfo) {
    return;
  }

  if (msg.media_group_id) {
    if (env.TG_KV) {
      await handleBatchPreProcess(msg, mediaInfo, env);
      return;
    }

    ctx.waitUntil(handleNoKvBatch(msg, mediaInfo, env));
    return;
  }

  await sendUnifiedPanel(chatId, mediaInfo, getDefaultChannelValue(env), env);
}

const handlePublicCommand = createCommandRouter([
  {
    match: text => text === "/info",
    handler: async ({ msg, chatId, env, ctx }) => {
      await handleInfoCommand(msg, chatId, env, ctx);
    },
  },
  {
    match: text => text === "/delete",
    handler: async ({ msg, chatId, env, ctx }) => {
      if (!msg.reply_to_message) {
        const res = await callTelegramApi("sendMessage", {
          chat_id: chatId,
          text: "❌ 请回复一张要删除的图片消息",
          reply_to_message_id: msg.message_id,
        }, env, { muteError: true });

        if (res.ok && res.result && res.result.message_id) {
          ctx.waitUntil(delayDelete(chatId, [msg.message_id, res.result.message_id], env));
        }
        return;
      }

      await handleDeleteCommand(msg, chatId, env, ctx);
    },
  },
]);

/** 处理群组或频道中的公开命令，目前主要承载查询与删除能力。 */
async function handlePublicChatMessage(msg, text, chatId, env, ctx) {
  await handlePublicCommand(text, { msg, text, chatId, env, ctx });
}

// ==========================================
// 🧾 命令处理
// ==========================================

/** 手动刷新机器人命令菜单，便于私聊和群聊命令及时生效。 */
async function handleInitCommand(chatId, env) {
  await sendTelegramMessage(chatId, "🔄 正在强制刷新命令菜单...", env);

  try {
    const success = await setupBotCommands(env, chatId);
    if (success) {
      await sendTelegramMessage(
        chatId,
        "✅ **刷新成功！**\n\n如果菜单未变化，请尝试：\n1. 完全关闭 Telegram App 进程并重启。\n2. 删除与机器人的对话框重新进入。",
        env,
      );
    } else {
      await sendTelegramMessage(chatId, "❌ 部分接口调用失败，请检查日志。", env);
    }
  } catch (error) {
    await sendTelegramMessage(chatId, `❌ 出错: ${error.message}`, env);
  }
}

/** 按不同聊天作用域批量注册 Telegram 命令菜单。 */
async function setupBotCommands(env, targetChatId = null) {
  const url = buildTelegramUrl(env, "setMyCommands");
  const requests = [];

  requests.push(fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands: COMMANDS_PRIVATE, scope: { type: "all_private_chats" } }),
  }));

  requests.push(fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands: COMMANDS_PUBLIC, scope: { type: "all_chat_administrators" } }),
  }));

  requests.push(fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands: COMMANDS_PUBLIC, scope: { type: "all_group_chats" } }),
  }));

  requests.push(fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands: COMMANDS_PUBLIC, scope: { type: "default" } }),
  }));

  if (targetChatId) {
    requests.push(fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: COMMANDS_PRIVATE, scope: { type: "chat", chat_id: targetChatId } }),
    }));
  }

  const results = await Promise.all(requests);
  return results.every(item => item.ok);
}

// ==========================================
// 📦 批量处理
// ==========================================

/** 基于 TG_KV 预处理相册消息，等待收齐后展示统一批量操作面板。 */
async function handleBatchPreProcess(msg, mediaInfo, env) {
  const groupId = msg.media_group_id;
  const chatId = msg.chat.id;
  const fileKey = `batch:${groupId}:file:${mediaInfo.fileId}`;

  await env.TG_KV.put(fileKey, JSON.stringify(mediaInfo), { expirationTtl: 3600 });

  if (!acquireGroupLock(groupId)) {
    return;
  }

  const pending = await sendTelegramMessage(chatId, UI_TEXT.pendingAlbum, env, {
    reply_to_message_id: msg.message_id,
  });
  const pendingMsgId = pending.ok ? pending.result.message_id : null;

  await sleep(CONST.BATCH_WAIT_WITH_KV_MS);

  const panelKey = `batch:${groupId}:panel`;
  const hasPanel = await env.TG_KV.get(panelKey);

  if (!hasPanel) {
    await env.TG_KV.put(panelKey, "pending", { expirationTtl: 3600 });

    const keyboard = buildBatchModeKeyboard();
    const panelMessageId = await ensureBatchModePanel(chatId, msg.message_id, pendingMsgId, keyboard, env);

    if (panelMessageId) {
      await env.TG_KV.put(`map:${chatId}:${panelMessageId}`, groupId, { expirationTtl: 3600 });
    }
    return;
  }

  if (pendingMsgId) {
    await deleteMessage(chatId, pendingMsgId, env);
  }
}

/** 优先复用等待中的提示消息，不可复用时再补发批量模式选择面板。 */
async function ensureBatchModePanel(chatId, replyToMessageId, pendingMsgId, keyboard, env) {
  if (pendingMsgId) {
    const editRes = await callTelegramApi("editMessageText", {
      chat_id: chatId,
      message_id: pendingMsgId,
      text: UI_TEXT.batchModeChoose,
      parse_mode: "Markdown",
      reply_markup: createInlineKeyboard(keyboard),
    }, env, { muteError: true });

    if (editRes.ok) {
      return pendingMsgId;
    }
  }

  const sendRes = await callTelegramApi("sendMessage", {
    chat_id: chatId,
    text: UI_TEXT.batchModeChoose,
    parse_mode: "Markdown",
    reply_to_message_id: replyToMessageId,
    reply_markup: createInlineKeyboard(keyboard),
  }, env, { muteError: true });

  return sendRes.ok ? sendRes.result.message_id : null;
}

/** 在未配置 TG_KV 时退化为内存缓存方案，并提示用户选择如何拆分相册。 */
async function handleNoKvBatch(msg, mediaInfo, env) {
  const groupId = msg.media_group_id;
  const chatId = msg.chat.id;

  if (!noKvCache.has(groupId)) {
    noKvCache.set(groupId, []);
  }
  noKvCache.get(groupId).push({ msg, mediaInfo });
  touchNoKvCache(groupId);

  if (!acquireGroupLock(groupId)) {
    return;
  }

  const pending = await sendTelegramMessage(chatId, UI_TEXT.pendingAlbumNoKv, env, {
    reply_to_message_id: msg.message_id,
  });
  const pendingMsgId = pending.ok ? pending.result.message_id : null;

  await sleep(CONST.BATCH_WAIT_NO_KV_MS);

  const cache = noKvCache.get(groupId) || [];
  const count = cache.length;
  const keyboard = buildNoKvKeyboard(groupId, count);

  const payload = {
    chat_id: chatId,
    text: `⚠️ **未配置 TG_KV 数据库**\n\n检测到您发送了一组包含 **${count}** 个文件的相册。\n由于未绑定 \`TG_KV\`，机器人无法合并它们。\n\n请选择后续操作：`,
    parse_mode: "Markdown",
    reply_markup: createInlineKeyboard(keyboard),
  };

  if (pendingMsgId) {
    await callTelegramApi("editMessageText", {
      ...payload,
      message_id: pendingMsgId,
    }, env, { muteError: true });
  } else {
    await callTelegramApi("sendMessage", {
      ...payload,
      reply_to_message_id: msg.message_id,
    }, env, { muteError: true });
  }

  touchNoKvCache(groupId);
}

// ==========================================
// 🖱️ 回调交互总入口
// ==========================================

const handleCallbackRoute = createPrefixCallbackRouter([
  {
    match: data => data.startsWith("switch_chan:"),
    handler: async ({ query, env }) => handleSwitchChannelCallback(query, env),
  },
  {
    match: data => data.startsWith("mode:"),
    handler: async ({ query, env }) => handleBatchModeSelection(query, env),
  },
  {
    match: data => data.startsWith("batch_upload:"),
    handler: async ({ query, env }) => handleBatchUploadCallback(query, env),
  },
  {
    match: data => data.startsWith("upload:"),
    handler: async ({ query, env }) => handleSingleUploadCallback(query, env),
  },
  {
    match: data => data === "upload_cancel" || data === "batch_cancel",
    handler: async ({ query, env, chatId, messageId }) => {
      await answerCallbackQuery(query.id, "已取消", env);
      await deleteMessage(chatId, messageId, env);
    },
  },
  {
    match: data => data.startsWith("nokv_sep:"),
    handler: async ({ query, env }) => handleNoKvSeparateCallback(query, env),
  },
  {
    match: data => data.startsWith("nokv_cancel:"),
    handler: async ({ query, env }) => handleNoKvCancelCallback(query, env),
  },
  {
    match: data => data.startsWith("close_panel"),
    handler: async ({ query, env }) => handleClosePanelCallback(query, env),
  },
  {
    match: data => data.startsWith("rnd:"),
    handler: async ({ query, env }) => handleRandomCallback(query, env),
  },
  {
    match: data => data.startsWith("browse:"),
    handler: async ({ query, env }) => handleBrowseCallback(query, env),
  },
  {
    match: data => data.startsWith("list_refresh_root"),
    handler: async ({ query, env }) => handleListRefreshRootCallback(query, env),
  },
  {
    match: data => data.startsWith("confirm_del:"),
    handler: async ({ query, env, ctx }) => handleConfirmDeleteCallback(query, env, ctx),
  },
  {
    match: data => data === "ignore",
    handler: async ({ query, env }) => answerCallbackQuery(query.id, "处理中，请稍候...", env),
  },
]);

/** 回调总入口，仅负责提取上下文并交给路由器分发。 */
async function handleCallback(query, env, ctx) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data || "";

  await handleCallbackRoute(data, { query, env, ctx, chatId, messageId });
}

/** 切换上传渠道时，仅刷新当前面板键盘，不改动正文内容。 */
async function handleSwitchChannelCallback(query, env) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const [newChannel, modeFlag] = parseCallbackParts(query.data, "switch_chan:");
  const isBatch = modeFlag === "batch";
  const channels = getChannels(env);
  const dirs = getDirs(env);
  const keyboard = buildUnifiedKeyboard(channels, dirs, newChannel, isBatch);
  const channelName = channels.find(item => item.value === newChannel)?.name || newChannel;

  const res = await editMessageReplyMarkup(chatId, messageId, keyboard, env);
  if (res.ok) {
    await answerCallbackQuery(query.id, `已切换到: ${channelName}`, env);
  } else {
    await answerCallbackQuery(query.id, "当前已选中该渠道", env);
  }
}

/** 处理相册模式选择，决定进入统一上传或拆分为独立面板。 */
async function handleBatchModeSelection(query, env) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const [mode] = parseCallbackParts(query.data, "mode:");
  const groupId = await env.TG_KV.get(`map:${chatId}:${messageId}`);

  if (!groupId) {
    await answerCallbackQuery(query.id, "任务已过期", env);
    return;
  }

  if (mode === "unify") {
    const channels = getChannels(env);
    const dirs = getDirs(env);
    const defaultChannel = (channels[0] && channels[0].value) || DEFAULT_UPLOAD_CHANNEL;
    const keyboard = buildUnifiedKeyboard(channels, dirs, defaultChannel, true);

    await callTelegramApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: UI_TEXT.batchUnifiedConfig,
      parse_mode: "HTML",
      reply_markup: createInlineKeyboard(keyboard),
    }, env, { muteError: true });

    await answerCallbackQuery(query.id, "请选择设置", env);
    return;
  }

  if (mode === "separate") {
    await answerCallbackQuery(query.id, "正在展开...", env);
    await editMessageText(chatId, messageId, "📑 已转换为单独处理模式，请查看下方新消息。", env);

    const listResult = await env.TG_KV.list({ prefix: `batch:${groupId}:file:` });
    const defaultChannel = getDefaultChannelValue(env);

    for (const key of listResult.keys) {
      const raw = await env.TG_KV.get(key.name);
      if (!raw) continue;
      const mediaInfo = safeJsonParse(raw);
      if (!mediaInfo) continue;
      await sendUnifiedPanel(chatId, mediaInfo, defaultChannel, env);
    }
  }
}

/** 执行整组相册的批量上传，并在原面板中汇总展示结果。 */
async function handleBatchUploadCallback(query, env) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const [targetDir, channelCode] = parseCallbackParts(query.data, "batch_upload:");
  const groupId = await env.TG_KV.get(`map:${chatId}:${messageId}`);

  if (!groupId) {
    await answerCallbackQuery(query.id, "任务过期", env);
    return;
  }

  await callTelegramApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: `⏳ <b>正在发起批量上传...</b>\n📂 目录: <code>${escapeHtml(targetDir)}</code>\n📡 渠道: <code>${escapeHtml(channelCode)}</code>\n\n请稍后，正在处理队列...`,
    parse_mode: "HTML",
    reply_markup: createInlineKeyboard([[{ text: "⏳ 正在上传中，请稍后...", callback_data: "ignore" }]]),
  }, env, { muteError: true });
  await answerCallbackQuery(query.id, "上传任务已启动", env);

  const listResult = await env.TG_KV.list({ prefix: `batch:${groupId}:file:` });
  if (listResult.keys.length === 0) {
    await editMessageText(chatId, messageId, "❌ 未找到文件或任务已过期", env);
    return;
  }

  const results = await Promise.all(listResult.keys.map(async key => {
    let mediaInfo = { fileName: "未知文件" };

    try {
      const rawData = await env.TG_KV.get(key.name);
      if (!rawData) throw new Error("缓存数据已过期");
      mediaInfo = JSON.parse(rawData);
      const res = await processUploadInternal(mediaInfo, targetDir, channelCode, env);
      return { ok: res.success, name: mediaInfo.fileName, url: res.accessUrl, error: res.error };
    } catch (error) {
      return { ok: false, name: mediaInfo.fileName, error: error.message };
    }
  }));

  let successCount = 0;
  let failCount = 0;
  let resultText = `✅ <b>批量上传完成</b>\n📂 <b>目录:</b> ${escapeHtml(targetDir)}\n📡 <b>渠道:</b> ${escapeHtml(channelCode)}\n━━━━━━━━━━━━━━━\n`;

  results.forEach((item, index) => {
    const safeName = escapeHtml(item.name || "未知文件");
    if (item.ok) {
      successCount += 1;
      resultText += `<b>${index + 1}. ${safeName}</b>\n<a href="${item.url}">🔗 点击预览或复制</a>\n\n`;
    } else {
      failCount += 1;
      resultText += `<b>${index + 1}. ${safeName}</b> ❌ 失败\n\n`;
    }
  });

  resultText += `📊 成功: ${successCount} | 失败: ${failCount}`;

  await callTelegramApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: resultText,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  }, env, { muteError: true });
}

/** 处理单文件上传按钮，更新面板状态后进入正式上传流程。 */
async function handleSingleUploadCallback(query, env) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const [targetDir, channelCode] = parseCallbackParts(query.data, "upload:");

  await answerCallbackQuery(query.id, "🚀 开始上传...", env);
  await updatePanelMessage(
    chatId,
    query.message,
    `⏳ <b>正在上传至 [${escapeHtml(targetDir)}]</b>\n📡 渠道: <code>${escapeHtml(channelCode)}</code>\n\n请稍候，正在传输数据...`,
    env,
    {
      parse_mode: "HTML",
      reply_markup: createInlineKeyboard([]),
    },
  );

  let mediaInfo = getMediaInfo(query.message);
  if (!mediaInfo && query.message.reply_to_message) {
    mediaInfo = getMediaInfo(query.message.reply_to_message);
  }

  if (mediaInfo) {
    await processUpload(chatId, mediaInfo, targetDir, channelCode, env, messageId, query.message);
    return;
  }

  await updatePanelMessage(chatId, query.message, "❌ 文件信息过期，请重新发送文件", env, {
    parse_mode: "HTML",
    reply_markup: createInlineKeyboard([]),
  });
}

/** 未启用 TG_KV 时，将相册中的每个文件展开成独立上传面板。 */
async function handleNoKvSeparateCallback(query, env) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const [groupId] = parseCallbackParts(query.data, "nokv_sep:");
  const cache = noKvCache.get(groupId);

  if (!cache || cache.length === 0) {
    await callTelegramApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: "❌ **临时缓存已过期**\n\n请重新发送文件，或者前往 Cloudflare 绑定 `TG_KV` 数据库以彻底解决此问题。",
      parse_mode: "Markdown",
    }, env, { muteError: true });
    await answerCallbackQuery(query.id, "缓存已过期", env);
    return;
  }

  await callTelegramApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: `✅ **正在为您展开 ${cache.length} 个独立的上传面板...**\n\n💡 提示：强烈建议绑定 \`TG_KV\` 开启无感合并体验！`,
    parse_mode: "Markdown",
  }, env, { muteError: true });

  const defaultChannel = getDefaultChannelValue(env);
  for (const item of cache) {
    await sendUnifiedPanel(chatId, item.mediaInfo, defaultChannel, env);
    await sleep(150);
  }

  clearNoKvCache(groupId);
  await answerCallbackQuery(query.id, "面板已展开", env);
}

/** 取消无 KV 相册处理，并清理内存中的临时聚合数据。 */
async function handleNoKvCancelCallback(query, env) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const [groupId] = parseCallbackParts(query.data, "nokv_cancel:");

  clearNoKvCache(groupId);
  await deleteMessage(chatId, messageId, env);
  await answerCallbackQuery(query.id, "已取消操作", env);
}

/** 关闭交互面板，并在需要时顺带删除对应的命令消息。 */
async function handleClosePanelCallback(query, env) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const [, cmdId = ""] = String(query.data || "").split(":");

  await deleteMessage(chatId, messageId, env);
  if (cmdId) {
    await deleteMessage(chatId, cmdId, env);
  }
}

/** 处理随机图面板中的翻页、切目录与目录选择等交互。 */
async function handleRandomCallback(query, env) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const parts = parseCallbackParts(query.data, "rnd:");
  const action = parts[0];
  const currentDir = parts[1] || "all";
  const cmdId = parts[2] || "";

  if (action === "next") {
    await renderRandomImage(chatId, messageId, currentDir, env, true, cmdId);
    await answerCallbackQuery(query.id, "", env);
    return;
  }

  if (action === "pick") {
    const keyboard = buildRandomDirKeyboard(getDirs(env), currentDir, cmdId);
    await callTelegramApi("editMessageCaption", {
      chat_id: chatId,
      message_id: messageId,
      caption: UI_TEXT.randomPickDir,
      parse_mode: "HTML",
      reply_markup: createInlineKeyboard(keyboard),
    }, env, { muteError: true });
    await answerCallbackQuery(query.id, "选择目录", env);
    return;
  }

  if (action === "set") {
    const targetDir = parts[1] || "all";
    await answerCallbackQuery(query.id, `🔄 正在切换: ${targetDir}`, env);

    await callTelegramApi("editMessageCaption", {
      chat_id: chatId,
      message_id: messageId,
      caption: `⏳ <b>正在切换目录...</b>\n\n📂 目标: <code>${escapeHtml(targetDir)}</code>\n📡 状态: 资源获取中...`,
      parse_mode: "HTML",
      reply_markup: createInlineKeyboard([[{ text: "⏳ 加载中...", callback_data: "ignore" }]]),
    }, env, { muteError: true });

    await renderRandomImage(chatId, messageId, targetDir, env, true, cmdId);
  }
}

/** 处理文件浏览分页请求，并按页渲染指定目录内容。 */
async function handleBrowseCallback(query, env) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const [dir, pageRaw, cmdId = ""] = parseCallbackParts(query.data, "browse:");
  const page = parseInt(pageRaw || "0", 10);

  await answerCallbackQuery(query.id, "加载中...", env);
  await renderFilePage(chatId, messageId, dir, page, env, cmdId);
}

/** 从分页视图返回目录根列表，便于重新选择浏览路径。 */
async function handleListRefreshRootCallback(query, env) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const [, cmdId = ""] = String(query.data || "").split(":");

  await answerCallbackQuery(query.id, "刷新目录...", env);
  await editToDirectoryBrowser(chatId, messageId, getDirs(env), env, cmdId);
}

/** 处理图床删除确认弹窗，负责真正执行删除或取消任务。 */
async function handleConfirmDeleteCallback(query, env, ctx) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const [, action, targetMsgId] = String(query.data || "").split(":");
  const tempKey = `del_task:${chatId}:${targetMsgId}`;

  if (action === "no") {
    await answerCallbackQuery(query.id, "已取消", env);

    const taskData = env.TG_KV ? await env.TG_KV.get(tempKey) : null;
    if (taskData) {
      const parsed = safeJsonParse(taskData, {});
      await deleteMessage(chatId, messageId, env);
      if (parsed.cmdId) {
        await deleteMessage(chatId, parsed.cmdId, env);
      }
      await env.TG_KV.delete(tempKey);
    } else {
      await deleteMessage(chatId, messageId, env);
    }
    return;
  }

  if (action !== "yes") {
    return;
  }

  await answerCallbackQuery(query.id, "执行图床删除中...", env);

  const taskData = env.TG_KV ? await env.TG_KV.get(tempKey) : null;
  if (!taskData) {
    await editMessageText(chatId, messageId, "❌ 任务过期，请重新发起 /delete", env);
    ctx.waitUntil(delayDelete(chatId, [messageId], env));
    return;
  }

  const parsed = safeJsonParse(taskData, {});
  const deleteResult = await deleteFromImageHost(parsed.path, env);

  if (deleteResult.success) {
    await deleteMessage(chatId, targetMsgId, env);
    await editMessageText(chatId, messageId, "✅ <b>图床删除成功</b>\n\n文件已从存储中移除。\n\n相关提示将在 12 秒内自动清理。", env);
    ctx.waitUntil(delayDelete(chatId, [parsed.cmdId, messageId], env));
    await env.TG_KV.delete(tempKey);
    return;
  }

  await editMessageText(chatId, messageId, `❌ <b>删除失败</b>\n原因: <code>${escapeHtml(deleteResult.error)}</code>`, env);
  ctx.waitUntil(delayDelete(chatId, [messageId], env));
}

// ==========================================
// 📤 上传能力
// ==========================================

/** 根据媒体类型选择 Telegram 发送方法及其对应参数名。 */
function resolveTelegramMediaMethod(mediaInfo) {
  if (mediaInfo.type === "photo" || (mediaInfo.isUrl && mediaInfo.type === "photo")) {
    return { method: "sendPhoto", paramName: "photo" };
  }

  if (mediaInfo.type === "video") {
    return { method: "sendVideo", paramName: "video" };
  }

  return { method: "sendDocument", paramName: "document" };
}

/** 生成上传中的面板文案，统一展示目标目录与上传渠道。 */
function buildUploadProgressText(targetDir, channelCode) {
  return `⏳ <b>正在上传至 [${escapeHtml(targetDir)}]</b>\n📡 渠道: <code>${escapeHtml(channelCode)}</code>\n\n请稍候，正在传输数据...`;
}

/** 生成上传成功后的结果文案，便于用户直接复制或核对链接。 */
function buildUploadSuccessText(targetDir, channelCode, uploadResult) {
  return `✅ <b>上传成功!</b>\n\n📂 目录: <code>${escapeHtml(targetDir)}</code>\n📡 渠道: <code>${escapeHtml(channelCode)}</code>\n\n🏠 <b>源链</b>: <code>${escapeHtml(uploadResult.originUrl)}</code>\n🚀 <b>外链</b>: <code>${escapeHtml(uploadResult.accessUrl)}</code>`;
}

/** 生成上传失败文案，统一对错误信息做 HTML 转义。 */
function buildUploadErrorText(errorMessage) {
  return `❌ <b>上传失败</b>: <code>${escapeHtml(errorMessage)}</code>`;
}

/** 为单个媒体发送统一配置面板，供用户选择渠道与目录后上传。 */
async function sendUnifiedPanel(chatId, mediaInfo, defaultChannel, env) {
  const channels = getChannels(env);
  const dirs = getDirs(env);
  const keyboard = buildUnifiedKeyboard(channels, dirs, defaultChannel, false);
  const { method, paramName } = resolveTelegramMediaMethod(mediaInfo);

  await sendTelegramMedia(method, {
    chat_id: chatId,
    [paramName]: mediaInfo.fileId,
    caption: UI_TEXT.unifiedUploadConfig,
    parse_mode: "Markdown",
    reply_markup: createInlineKeyboard(keyboard),
  }, env);
}

/** 负责上传结果的展示层逻辑，可选择回写原面板或额外发送结果消息。 */
async function processUpload(chatId, mediaInfo, targetDir, channelCode, env, messageIdToEdit = null, originalMessage = null) {
  if (!messageIdToEdit) {
    await sendTelegramMessage(chatId, "⏳ 正在处理...", env);
  }

  const uploadResult = await processUploadInternal(mediaInfo, targetDir, channelCode, env);

  if (uploadResult.success) {
    const successText = buildUploadSuccessText(targetDir, channelCode, uploadResult);
    if (messageIdToEdit && originalMessage) {
      await updatePanelMessage(chatId, originalMessage, successText, env, {
        parse_mode: "HTML",
        reply_markup: createInlineKeyboard([]),
      });
    } else {
      await callTelegramApi("sendMessage", {
        chat_id: chatId,
        text: successText,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }, env, { muteError: true });
    }
    return;
  }

  const errText = buildUploadErrorText(uploadResult.error);
  if (messageIdToEdit && originalMessage) {
    await updatePanelMessage(chatId, originalMessage, errText, env, {
      parse_mode: "HTML",
      reply_markup: createInlineKeyboard([]),
    });
  } else {
    await callTelegramApi("sendMessage", {
      chat_id: chatId,
      text: errText,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }, env, { muteError: true });
  }
}

/** 执行真实上传链路：先下载媒体，再提交到图床接口。 */
async function processUploadInternal(mediaInfo, targetDir, channelCode, env) {
  try {
    const fileBlob = await downloadMediaAsBlob(mediaInfo, env);
    return await uploadToImageHost(fileBlob, mediaInfo.fileName, targetDir, channelCode, env);
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/** 将 Telegram 文件或外部 URL 下载为 Blob，供后续上传接口复用。 */
async function downloadMediaAsBlob(mediaInfo, env) {
  if (mediaInfo.isUrl) {
    const fileRes = await fetch(mediaInfo.fileId, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    if (!fileRes.ok) {
      throw new Error(`下载外部链接失败: ${fileRes.status}`);
    }
    return await fileRes.blob();
  }

  const fileLinkRes = await fetch(`${buildTelegramUrl(env, "getFile")}?file_id=${encodeURIComponent(mediaInfo.fileId)}`);
  if (!fileLinkRes.ok) {
    throw new Error(`获取文件信息接口异常 (${fileLinkRes.status})`);
  }

  const fileLinkData = await fileLinkRes.json();
  if (!fileLinkData.ok) {
    throw new Error(fileLinkData.description || "获取 TG 文件链接失败");
  }

  const downloadUrl = `${TELEGRAM_API_BASE}/file/bot${env.TG_BOT_TOKEN}/${fileLinkData.result.file_path}`;
  const fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) {
    throw new Error(`下载 TG 文件失败 (${fileRes.status})`);
  }

  const originalBlob = await fileRes.blob();
  const correctMimeType = getMimeType(mediaInfo.fileName);
  return originalBlob.slice(0, originalBlob.size, correctMimeType);
}

/** 解析上传渠道配置，兼容 `provider|channelName` 这种复合写法。 */
function resolveUploadChannel(channel) {
  let provider = channel || DEFAULT_UPLOAD_CHANNEL;
  let channelName = null;

  if (provider.includes("|")) {
    const parts = provider.split("|");
    provider = parts[0];
    channelName = parts[1] || null;
  }

  return { provider, channelName };
}

/** 将文件提交到图床上传接口，并整理源地址与对外访问地址。 */
async function uploadToImageHost(fileBlob, fileName, directory, channel, env) {
  const formData = new FormData();
  formData.append("file", fileBlob, fileName);

  const uploadUrlObj = new URL(env.API_UPLOAD_URL);
  if (env.API_UPLOAD_TOKEN) {
    uploadUrlObj.searchParams.append("authCode", env.API_UPLOAD_TOKEN);
  }
  if (directory) {
    uploadUrlObj.searchParams.append("uploadFolder", directory);
  }

  const { provider, channelName } = resolveUploadChannel(channel);
  uploadUrlObj.searchParams.append("uploadChannel", provider);
  if (channelName) {
    uploadUrlObj.searchParams.append("channelName", channelName);
  }

  const response = await fetch(uploadUrlObj.toString(), {
    method: "POST",
    headers: { "User-Agent": TELEGRAM_USER_AGENT },
    body: formData,
  });

  const result = await response.json();
  if (Array.isArray(result) && result.length > 0 && result[0].src) {
    const rawSrc = result[0].src;
    const cleanPath = (rawSrc.startsWith("/") ? rawSrc.slice(1) : rawSrc).replace(/^file\//, "");
    const originUrl = `${uploadUrlObj.origin}/file/${cleanPath}`;
    let accessUrl = originUrl;

    if (env.ACCESS_URL) {
      try {
        const targetUrl = new URL(originUrl);
        const accessBase = new URL(env.ACCESS_URL);
        targetUrl.protocol = accessBase.protocol;
        targetUrl.host = accessBase.host;
        targetUrl.port = accessBase.port;
        accessUrl = targetUrl.toString();
      } catch (_error) {
        // ignore
      }
    }

    return { success: true, originUrl, accessUrl };
  }

  return { success: false, error: JSON.stringify(result) };
}

// ==========================================
// 📂 浏览功能
// ==========================================

/** 发送目录浏览入口面板，供用户选择要查看的目录。 */
async function sendDirectoryBrowser(chatId, dirs, env, cmdId = "") {
  await callTelegramApi("sendMessage", {
    chat_id: chatId,
    text: UI_TEXT.directoryBrowser,
    parse_mode: "Markdown",
    reply_markup: createInlineKeyboard(buildDirKeyboard(dirs, cmdId)),
  }, env, { muteError: true });
}

/** 将现有消息切换回目录浏览入口，避免反复新发消息。 */
async function editToDirectoryBrowser(chatId, messageId, dirs, env, cmdId = "") {
  await callTelegramApi("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: UI_TEXT.directoryBrowser,
    parse_mode: "Markdown",
    reply_markup: createInlineKeyboard(buildDirKeyboard(dirs, cmdId)),
  }, env, { muteError: true });
}

/** 拉取指定目录分页数据，并将文件列表渲染到浏览面板。 */
async function renderFilePage(chatId, messageId, dir, page, env, cmdId = "") {
  const listToken = env.API_LIST_TOKEN;
  if (!listToken) {
    await sendTelegramMessage(chatId, "❌ 未配置 API_LIST_TOKEN", env);
    return;
  }

  const pageSize = CONST.BROWSE_PAGE_SIZE;
  const start = page * pageSize;

  try {
    const uploadUrlObj = new URL(env.API_UPLOAD_URL);
    const params = new URLSearchParams({
      dir,
      start: String(start),
      count: String(pageSize),
      recursive: "true",
    });

    const res = await fetch(`${uploadUrlObj.origin}/api/manage/list?${params.toString()}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${listToken}`,
        "User-Agent": TELEGRAM_USER_AGENT,
      },
    });

    if (!res.ok) {
      throw new Error(`API Error: ${res.status}`);
    }

    const data = await res.json();
    const files = data.files || [];
    const totalCount = data.totalCount || 0;
    const totalPages = Math.ceil(totalCount / pageSize);

    const envChannelMap = {};
    getChannels(env).forEach(channel => {
      envChannelMap[String(channel.value).toLowerCase()] = channel.name;
    });

    let text = `📂 <b>目录: ${escapeHtml(dir)}</b>\n📄 页码: ${page + 1} / ${totalPages || 1} (共 ${totalCount} 个文件)\n━━━━━━━━━━━━━━━\n`;
    if (files.length === 0) {
      text += "\n📭 当前目录为空。\n";
    }

    files.forEach((file, index) => {
      const fileName = file.name;
      const simpleName = fileName.split("/").pop();
      const ext = simpleName.split(".").pop().toLowerCase();
      const meta = file.metadata || {};

      let finalSizeBytes = 0;
      if (meta.FileSizeBytes !== undefined && meta.FileSizeBytes !== null) {
        finalSizeBytes = Number(meta.FileSizeBytes);
      } else if (meta.FileSize !== undefined && meta.FileSize !== null) {
        const mbValue = parseFloat(meta.FileSize);
        if (!isNaN(mbValue)) {
          finalSizeBytes = mbValue * 1024 * 1024;
        }
      } else {
        finalSizeBytes = file.size || 0;
      }

      let pathDir = "UNKNOWN";
      if (meta.Directory !== undefined && meta.Directory !== null && meta.Directory !== "") {
        pathDir = meta.Directory;
      } else if (meta.Folder !== undefined && meta.Folder !== null && meta.Folder !== "") {
        pathDir = `${meta.Folder}/`;
      }

      const rawChannel = meta.Channel || meta.channel || file.channel || DEFAULT_UPLOAD_CHANNEL;
      const lowerRaw = String(rawChannel).toLowerCase();
      let displayChannel = "UNKNOWN";
      if (envChannelMap[lowerRaw]) {
        displayChannel = envChannelMap[lowerRaw];
      } else if (lowerRaw.includes("telegram")) {
        displayChannel = "TG";
      } else {
        displayChannel = lowerRaw.toUpperCase();
      }

      const rawTime = meta.TimeStamp || meta.timestamp || 0;
      const timeStr = formatTimestamp(rawTime);

      const cleanPath = fileName.startsWith("/") ? fileName.slice(1) : fileName;
      const originUrl = `${uploadUrlObj.origin}/file/${cleanPath}`;
      let accessUrl = originUrl;
      if (env.ACCESS_URL) {
        try {
          const accessBase = new URL(env.ACCESS_URL);
          const target = new URL(originUrl);
          target.hostname = accessBase.hostname;
          target.protocol = accessBase.protocol;
          target.port = accessBase.port || "";
          accessUrl = target.toString();
        } catch (_error) {
          // ignore
        }
      }

      const num = start + index + 1;
      let icon = "📄";
      if (["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext)) icon = "🖼";
      else if (["mp4", "mov", "webm", "mkv"].includes(ext)) icon = "📹";
      else if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) icon = "📦";

      text += `\n<b>${num}. ${icon} <a href="${accessUrl}">${escapeHtml(simpleName)}</a></b>`;
      text += `\n└ 🕒 <code>${escapeHtml(timeStr)}</code> · 📡 <code>${escapeHtml(displayChannel)}</code> · 📏 <code>${escapeHtml(formatFileSize(finalSizeBytes))}</code>`;
      text += `\n└ 🔗 <a href="${originUrl}">查看源地址</a> · 📂 <code>${escapeHtml(pathDir)}</code>\n`;
    });

    const keyboard = [];
    const navRow = [];
    if (page > 0) {
      navRow.push({ text: "⬅️ 上一页", callback_data: `browse:${dir}:${page - 1}:${cmdId}` });
    }
    if (page < totalPages - 1) {
      navRow.push({ text: "下一页 ➡️", callback_data: `browse:${dir}:${page + 1}:${cmdId}` });
    }
    if (navRow.length > 0) {
      keyboard.push(navRow);
    }

    keyboard.push([{ text: "🔙 返回目录列表", callback_data: `list_refresh_root:${cmdId}` }]);
    keyboard.push([{ text: "❌ 关闭面板", callback_data: `close_panel:${cmdId}` }]);

    await callTelegramApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: createInlineKeyboard(keyboard),
    }, env, { muteError: true });
  } catch (error) {
    await sendTelegramMessage(chatId, `❌ 获取列表失败: ${error.message}`, env);
  }
}

// ==========================================
// 🎲 随机图模块
// ==========================================

/** 发送随机图加载面板，并在消息创建成功后继续渲染具体媒体。 */
async function sendRandomPanel(chatId, dir, env, userCmdId = "") {
  const sent = await callTelegramApi("sendMessage", {
    chat_id: chatId,
    text: UI_TEXT.randomLoading,
    parse_mode: "HTML",
    reply_markup: createInlineKeyboard([[{ text: "🗑 关闭面板", callback_data: `close_panel:${userCmdId}` }]]),
  }, env, { muteError: true });

  if (sent.ok && sent.result && sent.result.message_id) {
    await renderRandomImage(chatId, sent.result.message_id, dir, env, false, userCmdId);
  }
}

/** 拉取随机图片或视频，并以发送或编辑媒体的方式刷新展示内容。 */
async function renderRandomImage(chatId, messageId, dir, env, isEditMedia, userCmdId = "") {
  const errorKeyboard = buildRandomErrorKeyboard(dir, userCmdId);

  try {
    const uploadUrlObj = new URL(env.API_UPLOAD_URL);
    const apiUrl = new URL(`${uploadUrlObj.origin}/random`);
    apiUrl.searchParams.append("form", "json");
    apiUrl.searchParams.append("type", "url");
    if (dir && dir !== "all") {
      apiUrl.searchParams.append("dir", dir);
    }

    const fetchRandom = async (forceVideo = false) => {
      if (forceVideo) apiUrl.searchParams.set("content", "video");
      else apiUrl.searchParams.delete("content");

      const res = await fetch(apiUrl.toString(), {
        method: "GET",
        headers: { "User-Agent": TELEGRAM_USER_AGENT },
      });
      if (!res.ok) return null;

      const json = await res.json();
      return json.url || (json.data && json.data.url) || null;
    };

    let finalUrl = await fetchRandom(false);
    if (!finalUrl) finalUrl = await fetchRandom(true);
    if (!finalUrl) {
      throw new Error("该目录下没有文件");
    }

    if (!finalUrl.startsWith("http")) {
      const path = finalUrl.startsWith("/") ? finalUrl : `/${finalUrl}`;
      finalUrl = `${uploadUrlObj.origin}${path}`;
    }

    const cleanUrl = finalUrl.split("?")[0].split("#")[0];
    const ext = cleanUrl.split(".").pop().toLowerCase();
    const isVideo = ["mp4", "webm", "mov", "mkv", "gif", "avi", "m4v", "flv"].includes(ext);
    const mediaType = isVideo ? "video" : "photo";
    const caption = `🎲 **随机漫游**\n\n📂 范围: \`${dir === "all" ? "全部" : dir}\``;
    const keyboard = buildRandomViewerKeyboard(dir, userCmdId);

    if (isEditMedia) {
      await callTelegramApi("editMessageMedia", {
        chat_id: chatId,
        message_id: messageId,
        media: {
          type: mediaType,
          media: finalUrl,
          caption,
          parse_mode: "Markdown",
          supports_streaming: true,
        },
        reply_markup: createInlineKeyboard(keyboard),
      }, env, { muteError: true });
      return;
    }

    const method = isVideo ? "sendVideo" : "sendPhoto";
    const paramName = isVideo ? "video" : "photo";
    const payload = {
      chat_id: chatId,
      [paramName]: finalUrl,
      caption,
      parse_mode: "Markdown",
      reply_markup: createInlineKeyboard(keyboard),
    };

    if (isVideo) {
      payload.supports_streaming = true;
    }

    const mediaRes = await callTelegramApi(method, payload, env, { muteError: true });
    if (mediaRes.ok) {
      await deleteMessage(chatId, messageId, env);
      return;
    }

    throw new Error(mediaRes.description || "发送失败");
  } catch (error) {
    const errText = `❌ **获取失败**: ${error.message}\n请尝试切换目录或重试。`;
    const method = isEditMedia ? "editMessageCaption" : "editMessageText";
    const bodyKey = isEditMedia ? "caption" : "text";

    await callTelegramApi(method, {
      chat_id: chatId,
      message_id: messageId,
      [bodyKey]: errText,
      parse_mode: "Markdown",
      reply_markup: createInlineKeyboard(errorKeyboard),
    }, env, { muteError: true });
  }
}

// ==========================================
// ℹ️ /info 与 🗑 /delete
// ==========================================

/** 输出消息与媒体元数据，便于排查上传、索引或文件映射问题。 */
async function handleInfoCommand(msg, chatId, env, ctx) {
  const targetMsg = msg.reply_to_message || msg;
  const mediaInfo = getMediaInfo(targetMsg);
  const sentDate = new Date(targetMsg.date * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

  const jsonStr = JSON.stringify(targetMsg, null, 2);
  const safeJson = jsonStr.length > 3000 ? `${jsonStr.substring(0, 3000)}...(truncated)` : jsonStr;

  let displayText = "ℹ️ <b>消息元数据</b>\n\n";
  displayText += `🆔 <b>Msg ID:</b> <code>${targetMsg.message_id}</code>\n`;
  displayText += `📅 <b>时间:</b> <code>${escapeHtml(sentDate)}</code>\n`;

  if (mediaInfo) {
    displayText += `📎 <b>File Name:</b> <code>${escapeHtml(mediaInfo.fileName)}</code>\n`;
    displayText += `🔑 <b>File ID:</b> <code>${escapeHtml(mediaInfo.fileId)}</code>\n`;
    displayText += `📂 <b>Type:</b> <code>${escapeHtml(mediaInfo.type)}</code>\n`;
  }

  displayText += `\n📋 <b>原始 JSON:</b>\n<pre><code class="language-json">${escapeHtml(safeJson)}</code></pre>`;

  const res = await callTelegramApi("sendMessage", {
    chat_id: chatId,
    text: displayText,
    parse_mode: "HTML",
    reply_to_message_id: targetMsg.message_id,
  }, env, { muteError: true });

  if (res.ok && res.result && res.result.message_id) {
    ctx.waitUntil(delayDelete(chatId, [res.result.message_id, msg.message_id], env));
  }
}

/** 根据回复的媒体消息查找图床索引，并弹出删除确认面板。 */
async function handleDeleteCommand(msg, chatId, env, ctx) {
  const targetMsg = msg.reply_to_message;
  const mediaInfo = getMediaInfo(targetMsg);
  const tgFileId = mediaInfo?.fileId;

  const feedback = await callTelegramApi("sendMessage", {
    chat_id: chatId,
    text: "🔍 正在匹配图床索引...",
    reply_to_message_id: msg.message_id,
  }, env, { muteError: true });

  if (!feedback.ok || !feedback.result || !feedback.result.message_id) {
    return;
  }

  const feedbackId = feedback.result.message_id;

  try {
    if (!env.img_url) {
      throw new Error("未绑定 img_url KV");
    }

    const rawData = await env.img_url.get("manage@index_0");
    const indexArray = rawData ? JSON.parse(rawData) : [];
    const matches = indexArray.filter(item => {
      const topId = item.TgFileId || item.fileId;
      const metaId = item.metadata ? (item.metadata.TgFileId || item.metadata.fileId) : null;
      return topId === tgFileId || metaId === tgFileId;
    });

    if (matches.length === 0) {
      await editMessageText(chatId, feedbackId, "❌ 匹配失败：图床索引中不存在此文件。", env);
      ctx.waitUntil(delayDelete(chatId, [msg.message_id, feedbackId], env));
      return;
    }

    const targetData = matches[0];
    const deletePath = targetData.id;
    const fileName = (targetData.metadata && targetData.metadata.FileName) || "未知文件名";

    if (env.TG_KV) {
      await env.TG_KV.put(`del_task:${chatId}:${targetMsg.message_id}`, JSON.stringify({
        path: deletePath,
        cmdId: msg.message_id,
      }), { expirationTtl: 600 });
    }

    const confirmText = `⚠️ <b>确认从图床删除？</b>\n\n🆔 <b>文件路径 (ID):</b>\n<code>${escapeHtml(deletePath)}</code>\n\n📄 <b>原始名称:</b> <code>${escapeHtml(fileName)}</code>\n\n确认后将物理删除文件并撤回此消息。`;

    await callTelegramApi("editMessageText", {
      chat_id: chatId,
      message_id: feedbackId,
      text: confirmText,
      parse_mode: "HTML",
      reply_markup: createInlineKeyboard([[
        { text: "✅ 确认删除", callback_data: `confirm_del:yes:${targetMsg.message_id}` },
        { text: "❌ 取消操作", callback_data: `confirm_del:no:${targetMsg.message_id}` },
      ]]),
    }, env, { muteError: true });
  } catch (error) {
    await editMessageText(chatId, feedbackId, `❌ 处理出错: ${escapeHtml(error.message)}`, env);
    ctx.waitUntil(delayDelete(chatId, [msg.message_id, feedbackId], env));
  }
}

/** 调用图床删除接口，删除指定存储路径对应的文件。 */
async function deleteFromImageHost(path, env) {
  if (!env.API_DELETE_TOKEN) {
    return { success: false, error: "未配置 API_DELETE_TOKEN" };
  }

  try {
    const uploadUrl = new URL(env.API_UPLOAD_URL);
    const safePath = String(path || "")
      .split("/")
      .map(part => encodeURIComponent(part))
      .join("/");

    const finalUrl = `${uploadUrl.origin}/api/manage/delete/${safePath}`;
    const response = await fetchWithTimeout(finalUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.API_DELETE_TOKEN}`,
        "User-Agent": TELEGRAM_USER_AGENT,
        Accept: "application/json",
      },
    }, CONST.DELETE_API_TIMEOUT_MS);

    const resJson = await response.json().catch(() => ({}));
    const msg = String(resJson.message || "").toLowerCase();
    const isSuccess = response.ok && (
      resJson.success === true ||
      resJson.code === 200 ||
      resJson.status === "success" ||
      msg.includes("success")
    );

    if (isSuccess) {
      return { success: true };
    }

    const errMsg = resJson.message || resJson.error || resJson.detail || `HTTP ${response.status}`;
    return { success: false, error: errMsg };
  } catch (error) {
    const errorDesc = error && error.name === "AbortError" ? "API 请求超时" : (error.message || String(error));
    return { success: false, error: `网络异常: ${errorDesc}` };
  }
}

// ==========================================
// 🧹 延迟清理与 KV 重置
// ==========================================

/** 延迟清理一组消息，常用于短暂提示信息的自动回收。 */
async function delayDelete(chatId, messageIds, env) {
  await sleep(CONST.AUTO_DELETE_DELAY_MS);

  await Promise.all((messageIds || []).filter(Boolean).map(async msgId => {
    try {
      await deleteMessage(chatId, msgId, env);
    } catch (_error) {
      // ignore
    }
  }));
}

/** 清空 TG_KV 中的临时状态数据，供 `/reset` 命令统一调用。 */
async function clearAllKV(env) {
  if (!env.TG_KV) {
    return 0;
  }

  let keysDeleted = 0;
  let cursor = null;

  do {
    const list = await env.TG_KV.list({ cursor, limit: 1000 });
    const keyNames = (list.keys || []).map(key => key.name);

    for (const batch of chunkArray(keyNames, CONST.KV_DELETE_PARALLEL)) {
      await Promise.all(batch.map(async name => {
        try {
          await env.TG_KV.delete(name);
          keysDeleted += 1;
        } catch (error) {
          logError("clearAllKV", error, { key: name });
        }
      }));
    }

    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);

  return keysDeleted;
}
