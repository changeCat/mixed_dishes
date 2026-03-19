/**
 * Cloudflare Worker Telegram Bot (UI 交互优化版)
 * 特性：渠道与目录合并显示，支持动态勾选渠道，单选逻辑
 */

export default {
  async fetch(request, env, ctx) {
    if (request.method === "POST") {
      try {
        const payload = await request.json();
        if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_BOT_SECRET && env.TG_BOT_SECRET) {
          return new Response("Unauthorized", { status: 403 });
        }
        ctx.waitUntil(handleUpdate(payload, env, ctx));
        return new Response("OK", { status: 200 });
      } catch (e) {
        return new Response("Error", { status: 500 });
      }
    }
    return new Response("Bot is running.", { status: 200 });
  },
};

// ==========================================
// ⚙️ 全局常量与内存态缓存
// ==========================================

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
};

const TELEGRAM_API_BASE = "https://api.telegram.org";

// 内存级全局缓存：锁 / 无KV缓存 / 计时器 / 配置快照
const groupLocks = new Map();
const groupLockTimers = new Map();
const noKvCache = new Map();
const noKvCacheTimers = new Map();
const noKvCacheTouchedAt = new Map();
const envConfigCache = new WeakMap();
let lastCachePruneAt = 0;

// ==========================================
// 🧰 通用工具
// ==========================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "\x26amp;")
    .replace(/</g, "\x26lt;")
    .replace(/>/g, "\x26gt;")
    .replace(/\"/g, "\x26quot;")
    .replace(/'/g, "\x26#39;");
}

function logError(scope, error, extra = null) {
  const msg = error && error.message ? error.message : String(error);
  if (extra) {
    console.error(`[${scope}] ${msg}`, extra);
  } else {
    console.error(`[${scope}] ${msg}`);
  }
}

function parseChannels(rawChannelList) {
  const raw = rawChannelList || "TG:telegram";
  const list = raw.split(",").map(item => item.trim()).filter(Boolean);

  if (list.length === 0) {
    return [{ name: "TG", value: "telegram" }];
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

function parseDirs(rawDirList) {
  return (rawDirList || "")
    .split(",")
    .map(d => d.trim())
    .filter(Boolean);
}

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
    // 为兼容旧逻辑：不做 filter(Boolean)，空值会保留 ""，从而在未配置时默认拒绝
    allowedUsers: new Set((rawUsers || "").split(",").map(id => id.trim())),
  };

  envConfigCache.set(env, { fingerprint, value });
  return value;
}

function getChannels(env) {
  return getEnvConfig(env).channels;
}

function getDirs(env) {
  return getEnvConfig(env).dirs;
}

function isUserAllowed(userId, env) {
  const allowedUsers = getEnvConfig(env).allowedUsers;
  return allowedUsers.has(String(userId));
}

function acquireGroupLock(groupId, ttlMs = CONST.GROUP_LOCK_TTL_MS) {
  const now = Date.now();
  const prev = groupLocks.get(groupId);

  if (prev && (now - prev) < ttlMs) {
    return false;
  }

  groupLocks.set(groupId, now);

  const oldTimer = groupLockTimers.get(groupId);
  if (oldTimer) clearTimeout(oldTimer);

  const timer = setTimeout(() => {
    releaseGroupLock(groupId);
  }, ttlMs);

  groupLockTimers.set(groupId, timer);
  return true;
}

function releaseGroupLock(groupId) {
  groupLocks.delete(groupId);
  const timer = groupLockTimers.get(groupId);
  if (timer) clearTimeout(timer);
  groupLockTimers.delete(groupId);
}

function touchNoKvCache(groupId) {
  noKvCacheTouchedAt.set(groupId, Date.now());
  const oldTimer = noKvCacheTimers.get(groupId);
  if (oldTimer) clearTimeout(oldTimer);

  const timer = setTimeout(() => {
    clearNoKvCache(groupId);
  }, CONST.NO_KV_CACHE_TTL_MS);

  noKvCacheTimers.set(groupId, timer);
}

function clearNoKvCache(groupId) {
  noKvCache.delete(groupId);
  noKvCacheTouchedAt.delete(groupId);

  const timer = noKvCacheTimers.get(groupId);
  if (timer) clearTimeout(timer);
  noKvCacheTimers.delete(groupId);

  releaseGroupLock(groupId);
}

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

async function fetchWithTimeout(url, options = {}, timeoutMs = CONST.HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const mergedOptions = {
      ...options,
      signal: options.signal || controller.signal,
    };
    return await fetch(url, mergedOptions);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callTelegramApi(method, payload, env, opts = {}) {
  const timeoutMs = opts.timeoutMs || CONST.TELEGRAM_TIMEOUT_MS;
  const muteError = opts.muteError === true;

  try {
    const res = await fetchWithTimeout(
      `${TELEGRAM_API_BASE}/bot${env.TG_BOT_TOKEN}/${method}`,
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
  } catch (e) {
    const desc = e && e.name === "AbortError" ? "请求超时" : (e.message || String(e));
    if (!muteError) {
      console.error(`[tg:${method}]`, desc);
    }
    return { ok: false, description: desc };
  }
}

// --- 核心逻辑 ---

async function handleUpdate(update, env, ctx) {
  // 轻量内存清理，避免长生命周期 Worker 累积缓存
  pruneMemoryCaches();

  // ==============================
  // 1. 初始解析与鉴权
  // ==============================
  let userId = null;
  let chatId = null;
  let chatType = null;
  let msg = null;

  // 解析消息来源
  if (update.message) {
    msg = update.message;
    userId = msg.from.id;
    chatId = msg.chat.id;
    chatType = msg.chat.type; // "private", "group", "supergroup"
  } else if (update.channel_post) {
    msg = update.channel_post;
    chatId = msg.chat.id;
    userId = chatId;
    chatType = "channel";
  } else if (update.callback_query) {
    // 回调分支直接转交
    await handleCallback(update.callback_query, env, ctx);
    return;
  } else {
    return; // 未知更新类型，忽略
  }

  // 鉴权 (检查 ALLOWED_USERS)
  // 注意：如果是频道消息，这里的 userId 就是频道 ID
  if (!isUserAllowed(userId, env)) {
    return;
  }

  // 提取文本，防止后续重复提取
  const text = msg.text || msg.caption || "";
  const channels = getChannels(env);
  const dirs = getDirs(env);

  // ==============================
  // 2. 核心分流逻辑 (If / Else)
  // ==============================

  if (chatType === "private") {
    // 0. /init - 初始化/更新命令提示
    if (text === "/init") {
      await sendTelegramMessage(chatId, "🔄 正在强制刷新命令菜单...", env);
      try {
        const success = await setupBotCommands(env, chatId);
        if (success) {
          await sendTelegramMessage(chatId, "✅ **刷新成功！**\n\n如果菜单未变化，请尝试：\n1. 完全关闭 Telegram App 进程并重启。\n2. 删除与机器人的对话框重新进入。", env);
        } else {
          await sendTelegramMessage(chatId, "❌ 部分接口调用失败，请检查日志。", env);
        }
      } catch (e) {
        await sendTelegramMessage(chatId, `❌ 出错: ${e.message}`, env);
      }
      return;
    }

    // 1. /list - 浏览目录
    if (text.startsWith("/list")) {
      if (dirs.length === 0) {
        await sendTelegramMessage(chatId, "❌ 未配置 `DIR_LIST`", env);
        return;
      }
      await sendDirectoryBrowser(chatId, dirs, env, msg.message_id);
      return;
    }

    // 2. /reset - 重置 KV
    if (text === "/reset") {
      await sendTelegramMessage(chatId, "⏳ 正在重置上传状态...", env);
      const count = await clearAllKV(env);
      await sendTelegramMessage(chatId, `✅ 上传已重置。\n🗑 已清理 ${count} 条临时缓存。`, env);
      return;
    }

    // 4. /random - 随机图面板
    if (text === "/random") {
      await sendRandomPanel(chatId, "all", env, msg.message_id);
      return;
    }

    // 5. 文件/链接上传检测 (默认行为)
    const mediaInfo = getMediaInfo(msg);
    if (mediaInfo) {
      if (msg.media_group_id) {
        if (env.TG_KV) {
          await handleBatchPreProcess(msg, mediaInfo, env);
          return;
        }
        // 无 KV 模式异步化，避免 webhook 超时
        ctx.waitUntil(handleNoKvBatch(msg, mediaInfo, env));
        return;
      }

      const defaultChannel = (channels[0] && channels[0].value) || "telegram";
      await sendUnifiedPanel(chatId, mediaInfo, defaultChannel, env);
    }

    return;
  }

  // 非私聊分支 (Channel / Group)
  if (text === "/info") {
    await handleInfoCommand(msg, chatId, env, ctx);
    return;
  }

  if (text === "/delete") {
    if (!msg.reply_to_message) {
      const resData = await callTelegramApi("sendMessage", {
        chat_id: chatId,
        text: "❌ 请回复一张要删除的图片消息",
        reply_to_message_id: msg.message_id,
      }, env, { muteError: true });

      if (resData.ok && resData.result && resData.result.message_id) {
        ctx.waitUntil(delayDelete(chatId, [msg.message_id, resData.result.message_id], env));
      }
      return;
    }

    await handleDeleteCommand(msg, chatId, env, ctx);
    return;
  }

  // 非命令消息直接忽略，避免回路
}

// --- 批量逻辑 (KV 依赖)[极致秒回优化版] ---
async function handleBatchPreProcess(msg, mediaInfo, env) {
    const groupId = msg.media_group_id;
    const chatId = msg.chat.id;
    const fileKey = `batch:${groupId}:file:${mediaInfo.fileId}`;

    // 1) 落盘当前媒体
    await env.TG_KV.put(fileKey, JSON.stringify(mediaInfo), { expirationTtl: 3600 });

    // 2) 内存锁防抖：同一批次只放行一次面板渲染
    if (!acquireGroupLock(groupId)) {
        return;
    }

    // 3) 即时反馈
    const pendingJson = await callTelegramApi("sendMessage", {
        chat_id: chatId,
        text: "⏳ **正在接收并合并相册，请稍候...**",
        parse_mode: "Markdown",
        reply_to_message_id: msg.message_id,
    }, env, { muteError: true });
    const pendingMsgId = pendingJson.ok ? pendingJson.result.message_id : null;

    // 4) 短等待，吸收并发消息
    await sleep(CONST.BATCH_WAIT_WITH_KV_MS);

    // 5) KV 级兜底：只允许一个面板
    const panelKey = `batch:${groupId}:panel`;
    const hasPanel = await env.TG_KV.get(panelKey);

    if (!hasPanel) {
        await env.TG_KV.put(panelKey, "pending", { expirationTtl: 3600 });

        const keyboard = [
          [{ text: "📦 统一上传 (推荐)", callback_data: "mode:unify" }],
          [{ text: "📑 分别上传 (繁琐)", callback_data: "mode:separate" }],
          [{ text: "❌ 取消", callback_data: "batch_cancel" }],
        ];

        let panelMessageId = null;

        if (pendingMsgId) {
            const editRes = await callTelegramApi("editMessageText", {
                chat_id: chatId,
                message_id: pendingMsgId,
                text: "📚 **收到一组文件**\n请选择处理方式：",
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: keyboard },
            }, env, { muteError: true });

            if (editRes.ok) {
                panelMessageId = pendingMsgId;
            }
        }

        if (!panelMessageId) {
            const sendRes = await callTelegramApi("sendMessage", {
                chat_id: chatId,
                text: "📚 **收到一组文件**\n请选择处理方式：",
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: keyboard },
                reply_to_message_id: msg.message_id,
            }, env, { muteError: true });

            if (sendRes.ok) {
                panelMessageId = sendRes.result.message_id;
            }
        }

        if (panelMessageId) {
            await env.TG_KV.put(`map:${chatId}:${panelMessageId}`, groupId, { expirationTtl: 3600 });
        }
        return;
    }

    // 其它并发分支：删除多余“加载中”消息
    if (pendingMsgId) {
        await callTelegramApi("deleteMessage", {
            chat_id: chatId,
            message_id: pendingMsgId,
        }, env, { muteError: true });
    }
}

// --- 无 KV 批量兜底逻辑 [极致秒回优化版] ---
async function handleNoKvBatch(msg, mediaInfo, env) {
    const groupId = msg.media_group_id;
    const chatId = msg.chat.id;

    if (!noKvCache.has(groupId)) {
      noKvCache.set(groupId, []);
    }
    noKvCache.get(groupId).push({ msg, mediaInfo });
    touchNoKvCache(groupId);

    // 同一 media_group 只展示一个提示面板
    if (!acquireGroupLock(groupId)) {
      return;
    }

    // 瞬间反馈
    const pendingJson = await callTelegramApi("sendMessage", {
      chat_id: chatId,
      text: "⏳ **正在缓冲相册队列 (无 KV 模式)...**",
      parse_mode: "Markdown",
      reply_to_message_id: msg.message_id,
    }, env, { muteError: true });
    const pendingMsgId = pendingJson.ok ? pendingJson.result.message_id : null;

    await sleep(CONST.BATCH_WAIT_NO_KV_MS);

    const cache = noKvCache.get(groupId) || [];
    const count = cache.length;

    const keyboard = [
      [{ text: `📑 分别单独上传 (${count}个文件)`, callback_data: `nokv_sep:${groupId}` }],
      [{ text: "❌ 取消本次上传", callback_data: `nokv_cancel:${groupId}` }],
    ];

    const finalMsgData = {
      chat_id: chatId,
      text: `⚠️ **未配置 TG_KV 数据库**\n\n检测到您发送了一组包含 **${count}** 个文件的相册。\n由于未绑定 \`TG_KV\`，机器人无法合并它们。\n\n请选择后续操作：`,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    };

    // 无缝替换面板
    if (pendingMsgId) {
      finalMsgData.message_id = pendingMsgId;
      await callTelegramApi("editMessageText", finalMsgData, env, { muteError: true });
    } else {
      finalMsgData.reply_to_message_id = msg.message_id;
      await callTelegramApi("sendMessage", finalMsgData, env, { muteError: true });
    }

    // 刷新缓存过期时间
    touchNoKvCache(groupId);
}

// ----------------------------------------------------------------
// ⚠️ 核心交互逻辑：handleCallback
// ----------------------------------------------------------------
async function handleCallback(query, env, ctx) { 
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data; 

  // --- 1. 纯UI交互：切换渠道 (switch_chan) ---
  // 逻辑：用户点击了某个渠道 -> 重新生成键盘(更新勾选状态) -> 编辑消息 -> 完成
  if (data.startsWith("switch_chan:")) {
      const newChannel = data.split(":")[1];
      const isBatch = data.split(":")[2] === "batch"; // 标记是否为批量模式面板
      
      const channels = getChannels(env);
      const dirs = getDirs(env);
      
      // 重新构建键盘，传入新的选中渠道
      const keyboard = buildUnifiedKeyboard(channels, dirs, newChannel, isBatch);
      
      // 更新文字 (可选，提示当前选中)
      const channelName = channels.find(c => c.value === newChannel)?.name || newChannel;
      const typeText = isBatch ? "📦 <b>[批量模式]</b>" : "📄 <b>[单文件]</b>";
      
      try {
        await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageReplyMarkup`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId, 
                message_id: messageId, 
                reply_markup: { inline_keyboard: keyboard }
            })
        });
        await answerCallbackQuery(query.id, `已切换到: ${channelName}`, env);
      } catch (e) {
          // 忽略 "message is not modified" 错误
          await answerCallbackQuery(query.id, "当前已选中该渠道", env);
      }
      return;
  }

  // --- 2. 批量模式：初始化选择 ---
  if (data.startsWith("mode:")) {
      const mode = data.split(":")[1];
      const mapKey = `map:${chatId}:${messageId}`;
      const groupId = await env.TG_KV.get(mapKey);

      if (!groupId) return answerCallbackQuery(query.id, "任务已过期", env);

      if (mode === "unify") {
          // 进入统一面板，默认选中第一个渠道
          const channels = getChannels(env);
          const dirs = getDirs(env);
          const defaultChannel = channels[0].value;
          const keyboard = buildUnifiedKeyboard(channels, dirs, defaultChannel, true); // true 表示 batch 模式

          await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`, {
             method: "POST", headers: { "Content-Type": "application/json" },
             body: JSON.stringify({
                 chat_id: chatId, message_id: messageId,
                 text: "📦 <b>[批量统一]</b> 请确认渠道并选择目录：", 
                 parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard }
             })
          });
          await answerCallbackQuery(query.id, "请选择设置", env);

      } else if (mode === "separate") {
          await answerCallbackQuery(query.id, "正在展开...", env);
          await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`, {
             method: "POST", headers: { "Content-Type": "application/json" },
             body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: "📑 已转换为单独处理模式，请查看下方新消息。", parse_mode: "HTML" })
          });
          
          const listResult = await env.TG_KV.list({ prefix: `batch:${groupId}:file:` });
          const channels = getChannels(env);
          const defaultChannel = channels[0].value;

          for (const key of listResult.keys) {
              const fileDataStr = await env.TG_KV.get(key.name);
              if (fileDataStr) {
                  const mediaInfo = JSON.parse(fileDataStr);
                  // 为每个文件发送独立的统一面板
                  await sendUnifiedPanel(chatId, mediaInfo, defaultChannel, env);
              }
          }
      }
      return;
  }

  // --- 3. 批量上传执行 (batch_upload:dir:channel) ---
  if (data.startsWith("batch_upload:")) {
      const parts = data.split(":");
      const targetDir = parts[1];
      const channelCode = parts[2];

      const mapKey = `map:${chatId}:${messageId}`;
      const groupId = await env.TG_KV.get(mapKey);
      
      if (!groupId) return answerCallbackQuery(query.id, "任务过期", env);
      
      // 【优化点】：立即修改界面为加载状态，并清空所有按钮防止重复点击
      await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
              chat_id: chatId, message_id: messageId,
              text: `⏳ <b>正在发起批量上传...</b>\n📂 目录: <code>${targetDir}</code>\n📡 渠道: <code>${channelCode}</code>\n\n请稍后，正在处理队列...`, 
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: [[{ text: "⏳ 正在上传中，请稍后...", callback_data: "ignore" }]] }
          })
      });
      await answerCallbackQuery(query.id, "上传任务已启动", env);

      const listResult = await env.TG_KV.list({ prefix: `batch:${groupId}:file:` });
      if (listResult.keys.length === 0) {
          await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: "❌ 未找到文件或任务已过期", parse_mode: "HTML" })
          });
          return;
      }

      let successCount = 0; 
      let failCount = 0;
      let resultText = `✅ <b>批量上传完成</b>\n📂 <b>目录:</b> ${targetDir}\n📡 <b>渠道:</b> ${channelCode}\n━━━━━━━━━━━━━━━\n`;
      
      const uploadPromises = listResult.keys.map(async (key) => {
          let mInfo = { fileName: "未知文件" };
          try {
              const rawData = await env.TG_KV.get(key.name);
              if (!rawData) throw new Error("缓存数据已过期");
              mInfo = JSON.parse(rawData);
              const res = await processUploadInternal(mInfo, targetDir, channelCode, env);
              return { ok: res.success, name: mInfo.fileName, url: res.accessUrl, error: res.error };
          } catch(e) { 
              return { ok: false, name: mInfo.fileName, error: e.message }; 
          }
      });

      const results = await Promise.all(uploadPromises);
      results.forEach((res, i) => {
          const safeName = res.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          if (res.ok) { 
              successCount++; 
              resultText += `<b>${i+1}. ${safeName}</b>\n<a href="${res.url}">🔗 点击预览或复制</a>\n\n`; 
          } else { 
              failCount++;
              resultText += `<b>${i+1}. ${safeName}</b> ❌ 失败\n\n`; 
          }
      });
      resultText += `📊 成功: ${successCount} | 失败: ${failCount}`;

      await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
              chat_id: chatId, message_id: messageId,
              text: resultText, parse_mode: "HTML", disable_web_page_preview: true
          })
      });
      return;
  }

  // --- 4. 单文件上传执行 (upload:dir:channel) ---
  if (data.startsWith("upload:")) {
    const parts = data.split(":");
    const targetDir = parts[1];
    const channelCode = parts[2];

    // 【优化点】：立即响应并修改界面，移除按钮防止二次触发
    await answerCallbackQuery(query.id, "🚀 开始上传...", env);
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageCaption`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId, message_id: messageId,
            caption: `⏳ <b>正在上传至 [${targetDir}]</b>\n📡 渠道: <code>${channelCode}</code>\n\n请稍候，正在传输数据...`,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [] } // 立即清空按钮
        })
    });
    
    let mediaInfo = getMediaInfo(query.message);
    if (!mediaInfo && query.message.reply_to_message) {
      mediaInfo = getMediaInfo(query.message.reply_to_message);
    }
    
    if (mediaInfo) {
      // 执行真正的上传逻辑 (里面会再次更新 caption 为成功或失败)
      await processUpload(chatId, mediaInfo, targetDir, channelCode, env, messageId);
    } else {
      await editMessageCaption(chatId, messageId, "❌ 文件信息过期，请重新发送文件", env);
    }
    return;
  }

  // --- 5. 通用操作 ---
  if (data === "upload_cancel" || data === "batch_cancel") {
      await answerCallbackQuery(query.id, "已取消", env);
      await deleteMessage(chatId, messageId, env);
      return;
  }

  // --- 无 KV 模式临时缓存交互 ---
  if (data.startsWith("nokv_sep:")) {
      const groupId = data.split(":")[1];
      const cache = noKvCache.get(groupId);

      // 如果用户过了一天再点，或者请求漂移到了其他节点导致缓存丢失
      if (!cache || cache.length === 0) {
          await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                  chat_id: chatId, message_id: messageId,
                  text: "❌ **临时缓存已过期**\n\n请重新发送文件，或者前往 Cloudflare 绑定 `TG_KV` 数据库以彻底解决此问题。",
                  parse_mode: "Markdown"
              })
          });
          await answerCallbackQuery(query.id, "缓存已过期", env);
          return;
      }

      // 修改原提示语为进行中的状态
      await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
              chat_id: chatId, message_id: messageId,
              text: `✅ **正在为您展开 ${cache.length} 个独立的上传面板...**\n\n💡 提示：强烈建议绑定 \`TG_KV\` 开启无感合并体验！`,
              parse_mode: "Markdown"
          })
      });

      const channels = getChannels(env);
      const defaultChannel = channels[0].value;

      // 循环读取内存缓存，为每一张图片弹出上传面板
      for (const item of cache) {
          await sendUnifiedPanel(chatId, item.mediaInfo, defaultChannel, env);
          await new Promise(resolve => setTimeout(resolve, 150)); // 微小延迟，防止触发 TG 的防刷屏限制
      }

      // 用完即删，释放内存
      noKvCache.delete(groupId);
      groupLocks.delete(groupId);
      await answerCallbackQuery(query.id, "面板已展开", env);
      return;
  }

  if (data.startsWith("nokv_cancel:")) {
      const groupId = data.split(":")[1];
      noKvCache.delete(groupId);
      groupLocks.delete(groupId);
      await deleteMessage(chatId, messageId, env);
      await answerCallbackQuery(query.id, "已取消操作", env);
      return;
  }

  if (data.startsWith("close_panel")) {
      // 1. 删除面板消息
      await deleteMessage(chatId, messageId, env);

      // 2. 尝试删除用户的 /random 指令
      const parts = data.split(":");
      if (parts.length > 1 && parts[1]) {
          await deleteMessage(chatId, parts[1], env);
      }
      return;
  }

  // --- 新增: 随机图交互逻辑 (rnd:action:dir:cmdId) ---
  if (data.startsWith("rnd:")) {
      const parts = data.split(":");
      const action = parts[1]; 
      const currentDir = parts[2] || "all";
      const cmdId = parts[3] || ""; 

      // 1. 下一张 (刷新)
      if (action === "next") {
          // 这里也可以加 loading，但为了连贯性通常不加，直接刷新
          await renderRandomImage(chatId, messageId, currentDir, env, true, cmdId);
          await answerCallbackQuery(query.id, "", env); 
          return;
      }
      
      // 2. 打开目录选择面板
      if (action === "pick") {
          const dirs = getDirs(env);
          const keyboard = buildRandomDirKeyboard(dirs, currentDir, cmdId);
          
          await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageCaption`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                  chat_id: chatId, message_id: messageId,
                  caption: "📂 <b>请选择随机范围：</b>", // 使用 HTML
                  parse_mode: "HTML",
                  reply_markup: { inline_keyboard: keyboard }
              })
          });
          await answerCallbackQuery(query.id, "选择目录", env);
          return;
      }

      // 3. 选中目录并刷新 (修复无变化问题)
      if (action === "set") {
          const targetDir = parts[2];
          
          // Step A: 立即给弹窗反馈
          await answerCallbackQuery(query.id, `🔄 正在切换: ${targetDir}`, env);

          // Step B: 强制先修改界面为 "加载中"
          // 使用 HTML 避免 Markdown 解析报错，确保请求一定成功
          const loadingText = `⏳ <b>正在切换目录...</b>\n\n📂 目标: <code>${targetDir}</code>\n📡 状态: 资源获取中...`;
          
          try {
              const loadRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageCaption`, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                      chat_id: chatId, 
                      message_id: messageId,
                      caption: loadingText, 
                      parse_mode: "HTML", // 关键：使用 HTML 防止特殊字符报错
                      reply_markup: { 
                          inline_keyboard: [[{ text: "⏳ 加载中...", callback_data: "ignore" }]] 
                      }
                  })
              });
              // 这里的 await 确保了界面变了之后，才执行下面的代码
          } catch (e) {
              console.error("Loading state failed:", e);
          }

          // Step C: 发起真正的网络请求 (2秒左右的耗时操作)
          await renderRandomImage(chatId, messageId, targetDir, env, true, cmdId);
          return;
      }
      return;
  }

  // --- 6. 浏览功能 (browse) ---
  if (data.startsWith("browse:")) {
    await answerCallbackQuery(query.id, "加载中...", env);
    const parts = data.split(":");
    // 格式: browse:dir:page:cmdId
    const dir = parts[1];
    const page = parseInt(parts[2] || "0");
    const cmdId = parts[3] || ""; // 获取传递的 cmdId

    await renderFilePage(chatId, messageId, dir, page, env, cmdId);
    return;
  }
  
  // 修改匹配逻辑以支持参数
  if (data.startsWith("list_refresh_root")) {
    await answerCallbackQuery(query.id, "刷新目录...", env);
    // 格式: list_refresh_root:cmdId
    const parts = data.split(":");
    const cmdId = parts[1] || ""; // 获取传递的 cmdId
    
    const dirs = getDirs(env);
    await editToDirectoryBrowser(chatId, messageId, dirs, env, cmdId);
    return;
  }

  // --- 删除二次确认回调处理 ---
  if (data.startsWith("confirm_del:")) {
      const [_, action, targetMsgId] = data.split(":");
      const tempKey = `del_task:${chatId}:${targetMsgId}`;

      // A. 取消操作
      if (action === "no") {
          await answerCallbackQuery(query.id, "已取消", env);
          const taskData = env.TG_KV ? await env.TG_KV.get(tempKey) : null;
          if (taskData) {
              const { cmdId } = JSON.parse(taskData);
              // 立即删除确认面板，清理用户指令
              await deleteMessage(chatId, messageId, env);
              await deleteMessage(chatId, cmdId, env);
              await env.TG_KV.delete(tempKey);
          } else {
              await deleteMessage(chatId, messageId, env);
          }
          return;
      }

      // B. 确认删除分支内部
      if (action === "yes") {
          await answerCallbackQuery(query.id, "执行图床删除中...", env);
          const taskData = env.TG_KV ? await env.TG_KV.get(tempKey) : null;
          
          if (!taskData) {
              await editMessageText(chatId, messageId, "❌ 任务过期，请重新发起 /delete", env);
              ctx.waitUntil(delayDelete(chatId, [messageId], env));
              return;
          }

          const { path, cmdId } = JSON.parse(taskData);
          const deleteResult = await deleteFromImageHost(path, env);

          if (deleteResult.success) {
              // 1. 物理删除成功后，立即撤回频道原图 (targetMsgId)
              await deleteMessage(chatId, targetMsgId, env);
              
              // 2. 更新提示面板文字
              await editMessageText(chatId, messageId, `✅ <b>图床删除成功</b>\n\n文件已从存储中移除。\n\n相关提示将在 12 秒内自动清理。`, env);
              
              // 3. 【完全复用 /info 逻辑】
              // 传入命令消息 ID (cmdId) 和 面板消息 ID (messageId)
              ctx.waitUntil(delayDelete(chatId, [cmdId, messageId], env));
              
              // 4. 清理临时 KV (这个操作很快，直接执行即可)
              await env.TG_KV.delete(tempKey);
          } else {
              // 删除失败：保留原图，仅报错
              await editMessageText(chatId, messageId, `❌ <b>删除失败</b>\n原因: <code>${deleteResult.error}</code>`, env);
              ctx.waitUntil(delayDelete(chatId, [messageId], env)); 
          }
      }
      return;
  }
}

// ----------------------------------------------------------------
// 🎹 统一键盘构建器 (核心 UI 逻辑)
// ----------------------------------------------------------------
function buildUnifiedKeyboard(channels, dirs, selectedChannel, isBatch) {
    const keyboard = [];
    
    // 1. 渠道区域 (Radio Button 风格)
    let channelRow = [];
    channels.forEach((ch) => {
        const isSelected = ch.value === selectedChannel;
        // 选中显示 ✅，未选中显示 ⬜ (或者不显示符号)
        const icon = isSelected ? "✅" : "⬜"; 
        const label = `${icon} ${ch.name}`;
        
        // 点击 callback： switch_chan:新的值:是否Batch
        const cbData = `switch_chan:${ch.value}:${isBatch ? 'batch' : 'single'}`;
        
        channelRow.push({ text: label, callback_data: cbData });
        
        // 每行最多放3个渠道，防止太挤
        if (channelRow.length === 3) {
            keyboard.push(channelRow);
            channelRow = [];
        }
    });
    if (channelRow.length > 0) keyboard.push(channelRow);

    // 分隔线 (可选，用一个不可点击的按钮做视觉分隔)
    // keyboard.push([{ text: "⬇️ 选择下方目录上传 ⬇️", callback_data: "ignore" }]);

    // 2. 目录区域 (Action Button)
    // 点击后直接带着 selectedChannel 发起上传
    const actionPrefix = isBatch ? "batch_upload" : "upload";
    const defaultDir = "default";
    
    // 默认目录单独一行
    keyboard.push([{ 
        text: `📂 默认 (${defaultDir})`, 
        callback_data: `${actionPrefix}:${defaultDir}:${selectedChannel}` 
    }]);

    // 其他目录
    let dirRow = [];
    dirs.forEach((dir, index) => { 
        dirRow.push({ 
            text: dir, 
            callback_data: `${actionPrefix}:${dir}:${selectedChannel}` 
        }); 
        if (dirRow.length === 2 || index === dirs.length - 1) { 
            keyboard.push(dirRow); 
            dirRow = []; 
        } 
    });

    // 底部取消
    const cancelAction = isBatch ? "batch_cancel" : "upload_cancel";
    keyboard.push([
        { text: "❌ 取消操作", callback_data: cancelAction },
        { text: "🗑 关闭面板", callback_data: "close_panel" } // 新增这个
    ]);

    return keyboard;
}

// --- 发送统一面板 (单文件) ---
async function sendUnifiedPanel(chatId, mediaInfo, defaultChannel, env) {
    const channels = getChannels(env);
    const dirs = getDirs(env);
    
    // 构建键盘
    const keyboard = buildUnifiedKeyboard(channels, dirs, defaultChannel, false);

    let method = 'sendDocument';
    let paramName = 'document';

    // 如果是 URL，且我们也标记为了 photo，直接用 sendPhoto
    if (mediaInfo.type === 'photo' || (mediaInfo.isUrl && mediaInfo.type === 'photo')) {
        method = 'sendPhoto';
        paramName = 'photo';
    } else if (mediaInfo.type === 'video') {
        method = 'sendVideo';
        paramName = 'video';
    }

    // 注意：Telegram 的 sendPhoto 可以直接接收 URL 字符串
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
            chat_id: chatId, 
            [paramName]: mediaInfo.fileId, // 这里如果是 URL，TG 会自动尝试加载预览
            caption: "⚙️ **上传配置**\n检测到链接/文件，请选择目录上传：", 
            parse_mode: "Markdown", 
            reply_markup: { inline_keyboard: keyboard } 
        })
    });
}

// --- 文件上传逻辑 (带 channel) ---
async function processUploadInternal(mediaInfo, targetDir, channelCode, env) {
  try {
    let fileBlob;
    
    if (mediaInfo.isUrl) {
        // A. 如果是外部 URL (如 Twitter 链接)
        // 直接请求该 URL 获取数据
        const fileRes = await fetch(mediaInfo.fileId, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } // 伪装 User-Agent 防止被拦截
        });
        if (!fileRes.ok) throw new Error(`下载外部链接失败: ${fileRes.status}`);
        fileBlob = await fileRes.blob();
        
    } else {
        // B. 如果是 Telegram 原生文件
        const fileLinkRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getFile?file_id=${mediaInfo.fileId}`);
        if (!fileLinkRes.ok) throw new Error(`获取文件信息接口异常 (${fileLinkRes.status})`);
        
        const fileLinkData = await fileLinkRes.json();
        if (!fileLinkData.ok) throw new Error(fileLinkData.description || "获取 TG 文件链接失败");
        
        const downloadUrl = `https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${fileLinkData.result.file_path}`;
        const fileRes = await fetch(downloadUrl);
        if (!fileRes.ok) throw new Error(`下载 TG 文件失败 (${fileRes.status})`);
        
        const originalBlob = await fileRes.blob();
        
        // 修正 mime 类型
        const correctMimeType = getMimeType(mediaInfo.fileName);
        fileBlob = originalBlob.slice(0, originalBlob.size, correctMimeType);
    }
    
    return await uploadToImageHost(fileBlob, mediaInfo.fileName, targetDir, channelCode, env);
  } catch (e) { return { success: false, error: e.message }; }
}

async function processUpload(chatId, mediaInfo, targetDir, channelCode, env, messageIdToEdit = null) {
  if (!messageIdToEdit) await sendTelegramMessage(chatId, `⏳ 正在处理...`, env); 
  
  const uploadResult = await processUploadInternal(mediaInfo, targetDir, channelCode, env);
  
  if (uploadResult.success) {
      let successText = `✅ **上传成功!**\n\n📂 目录: \`${targetDir}\`\n📡 渠道: \`${channelCode}\`\n\n🏠 **源链**: \`${uploadResult.originUrl}\`\n🚀 **外链**: \`${uploadResult.accessUrl}\``;
      if (messageIdToEdit) await editMessageCaption(chatId, messageIdToEdit, successText, env);
      else await sendTelegramMessage(chatId, successText, env);
  } else {
      const errText = `❌ **上传失败**: ${uploadResult.error}`;
      if (messageIdToEdit) await editMessageCaption(chatId, messageIdToEdit, errText, env);
      else await sendTelegramMessage(chatId, errText, env);
  }
}

async function uploadToImageHost(fileBlob, fileName, directory, channel, env) {
  const formData = new FormData();
  formData.append('file', fileBlob, fileName);
  
  const uploadUrlObj = new URL(env.API_UPLOAD_URL);
  if (env.API_UPLOAD_TOKEN) uploadUrlObj.searchParams.append('authCode', env.API_UPLOAD_TOKEN); 
  if (directory) uploadUrlObj.searchParams.append('uploadFolder', directory);
  
  // --- 修改开始: 解析组合参数 ---
  let targetProvider = channel || 'telegram';
  let targetChannelName = null;

  // 检查是否包含分隔符 '|' (这是我们在 getChannels 里组合的)
  if (targetProvider.includes('|')) {
      const parts = targetProvider.split('|');
      targetProvider = parts[0];       // 例如: telegram
      targetChannelName = parts[1];    // 例如: main
  }

  // 添加 uploadChannel 参数
  uploadUrlObj.searchParams.append('uploadChannel', targetProvider);
  
  // 如果存在 channelName，则添加该参数 (对应截图中的需求)
  if (targetChannelName) {
      uploadUrlObj.searchParams.append('channelName', targetChannelName);
  }
  // --- 修改结束 ---
  
  const response = await fetch(uploadUrlObj.toString(), { method: "POST", headers: { "User-Agent": "TelegramBot/1.0" }, body: formData });
  const result = await response.json();
  
  // 后续原有逻辑保持不变...
  if (Array.isArray(result) && result.length > 0 && result[0].src) {
    let rawSrc = result[0].src;
    const cleanPath = (rawSrc.startsWith('/') ? rawSrc.slice(1) : rawSrc).replace(/^file\//, ''); 
    const originUrl = `${uploadUrlObj.origin}/file/${cleanPath}`;
    let accessUrl = originUrl;
    if (env.ACCESS_URL) { try { const t = new URL(originUrl); const a = new URL(env.ACCESS_URL); t.protocol=a.protocol; t.host=a.host; t.port=a.port; accessUrl=t.toString(); } catch(e){} }
    return { success: true, originUrl, accessUrl };
  }
  return { success: false, error: JSON.stringify(result) };
}

// --- 辅助工具 ---
function randomString(len) { return Math.random().toString(36).substring(2, 2 + len); }
function getMediaInfo(msg) {
  if (!msg) return null;
  let fileId = null;
  let type = "document";
  let baseName = `tg_${Date.now()}_${randomString(5)}`;
  let isUrl = false; // 新增标记：是否为外部链接
  let url = null;

  // 1. 优先检测原生媒体 (Photo/Video/Document/Animation)
  if (msg.photo && msg.photo.length > 0) {
    fileId = msg.photo[msg.photo.length - 1].file_id;
    baseName += ".jpg";
    type = "photo";
  } else if (msg.video || msg.animation) {
    const media = msg.video || msg.animation;
    fileId = media.file_id;
    type = "video";
    baseName += ".mp4";
  } else if (msg.document) {
    fileId = msg.document.file_id;
    type = "document";
    if (msg.document.file_name) baseName = `tg_${randomString(4)}_${msg.document.file_name}`;
    else baseName += ".dat";
  } 
  // 2. 如果没有原生媒体，检查文本中是否包含 URL
  else {
    const text = msg.text || msg.caption || "";
    // 简单的正则匹配 URL
    const urlMatch = text.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
        isUrl = true;
        url = urlMatch[0];
        fileId = url; // 借用 fileId 字段存 URL，方便后续传递
        type = "photo"; // 默认当作图片处理（为了在面板显示预览）
        
        // 尝试从 URL 推断文件名
        try {
            const urlObj = new URL(url);
            const pathName = urlObj.pathname.split('/').pop();
            if (pathName && pathName.includes('.')) {
                baseName = pathName;
            } else {
                // 针对 Twitter 这种 ...?format=jpg 的情况
                const format = urlObj.searchParams.get("format");
                if (format) baseName += `.${format}`;
                else baseName += ".jpg"; // 实在不知道就默认 jpg
            }
        } catch(e) { baseName += ".jpg"; }
    }
  }

  if (!fileId) return null;
  // 返回对象增加 isUrl 字段
  return { fileId, type, fileName: baseName, isUrl: isUrl };
}
function getMimeType(n) { const e = n.split('.').pop().toLowerCase(); return {'jpg':'image/jpeg','png':'image/png','gif':'image/gif','mp4':'video/mp4'}[e]||'application/octet-stream'; }

async function sendTelegramMessage(chatId, text, env) {
  return await callTelegramApi("sendMessage", {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  }, env, { muteError: true });
}

// 浏览功能相关 (支持模糊匹配渠道 + UTC+8时间 + 智能大小 + cmdId传递)
async function renderFilePage(chatId, messageId, dir, page, env, cmdId = "") {
  const listToken = env.API_LIST_TOKEN;
  if (!listToken) { await sendTelegramMessage(chatId, "❌ 未配置 API_LIST_TOKEN", env); return; }
  
  const pageSize = 6; 
  const start = page * pageSize;
  
  try {
    const uploadUrlObj = new URL(env.API_UPLOAD_URL);
    // 必须带上 recursive=true 才能获取 metadata
    const params = new URLSearchParams({ dir: dir, start: start, count: pageSize, recursive: 'true' });
    const res = await fetch(`${uploadUrlObj.origin}/api/manage/list?${params.toString()}`, {
      method: 'GET', headers: { 'Authorization': `Bearer ${listToken}`, 'User-Agent': 'TelegramBot/1.0' }
    });
    if (!res.ok) throw new Error(`API Error: ${res.status}`);
    const data = await res.json();
    const files = data.files || [];
    const totalCount = data.totalCount || 0;
    const totalPages = Math.ceil(totalCount / pageSize);

    // --- 1. 准备环境变量里的映射 ---
    const channels = getChannels(env);
    const envChannelMap = {};
    channels.forEach(c => { envChannelMap[String(c.value).toLowerCase()] = c.name; });

    let text = `📂 <b>目录: ${dir}</b>\n📄 页码: ${page + 1} / ${totalPages || 1} (共 ${totalCount} 个文件)\n━━━━━━━━━━━━━━━\n`;
    
    if (files.length === 0) text += "\n📭 当前目录为空。\n";
    
    files.forEach((file, index) => {
      const fileName = file.name; 
      const simpleName = fileName.split('/').pop(); 
      const ext = simpleName.split('.').pop().toLowerCase();
      const meta = file.metadata || {}; 

      // 大小
      let finalSizeBytes = 0;
      if (meta["FileSizeBytes"] !== undefined && meta["FileSizeBytes"] !== null) { finalSizeBytes = Number(meta["FileSizeBytes"]); } 
      else if (meta["FileSize"] !== undefined && meta["FileSize"] !== null) { const mbValue = parseFloat(meta["FileSize"]); if (!isNaN(mbValue)) finalSizeBytes = mbValue * 1024 * 1024; } 
      else { finalSizeBytes = file.size || 0; }
      const sizeStr = formatFileSize(finalSizeBytes);

      // 目录
      let pathDir = "UNKNOWN";
      if (meta["Directory"] !== undefined && meta["Directory"] !== null && meta["Directory"] !== "") { pathDir = meta["Directory"]; } 
      else if (meta["Folder"] !== undefined && meta["Folder"] !== null && meta["Folder"] !== "") { pathDir = meta["Folder"] + "/"; }

      // 渠道
      let rawChannel = meta["Channel"] || meta["channel"] || file.channel || 'telegram';
      const lowerRaw = String(rawChannel).toLowerCase();
      let displayChannel = "UNKNOWN";
      if (envChannelMap[lowerRaw]) { displayChannel = envChannelMap[lowerRaw]; } 
      else if (lowerRaw.includes("telegram")) { displayChannel = "TG"; }
      else { displayChannel = lowerRaw.toUpperCase(); }

      // 时间
      const rawTime = meta["TimeStamp"] || meta["timestamp"] || 0;
      const timeStr = formatTimestamp(rawTime);

      // 链接
      const cleanPath = fileName.startsWith('/') ? fileName.slice(1) : fileName;
      const originUrl = `${uploadUrlObj.origin}/file/${cleanPath}`;
      let accessUrl = originUrl;
      if (env.ACCESS_URL) { try { const c = new URL(env.ACCESS_URL); const t = new URL(originUrl); t.hostname = c.hostname; t.protocol = c.protocol; if (c.port) t.port = c.port; else t.port = ''; accessUrl = t.toString(); } catch(e){} }

      // 图标
      const num = start + index + 1;
      let icon = "📄";
      if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) icon = "🖼";
      else if (['mp4', 'mov', 'webm', 'mkv'].includes(ext)) icon = "📹";
      else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) icon = "📦";

      // 组合文本
      text += `\n<b>${num}. ${icon} <a href="${accessUrl}">${simpleName}</a></b>`;
      text += `\n└ 🕒 <code>${timeStr}</code> · 📡 <code>${displayChannel}</code> · 📏 <code>${sizeStr}</code>`;
      text += `\n└ 🔗 <a href="${originUrl}">查看源地址</a> · 📂 <code>${pathDir}</code>\n`;
    });

    // --- 按钮构建 (关键修复：带上 cmdId) ---
    const keyboard = []; const navRow = [];
    if (page > 0) navRow.push({ text: "⬅️ 上一页", callback_data: `browse:${dir}:${page - 1}:${cmdId}` });
    if (page < totalPages - 1) navRow.push({ text: "下一页 ➡️", callback_data: `browse:${dir}:${page + 1}:${cmdId}` });
    if (navRow.length > 0) keyboard.push(navRow);
    
    // 返回和关闭都带上 cmdId
    keyboard.push([{ text: "🔙 返回目录列表", callback_data: `list_refresh_root:${cmdId}` }]);
    keyboard.push([{ text: "❌ 关闭面板", callback_data: `close_panel:${cmdId}` }]);
    
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } })
    });
  } catch (e) { await sendTelegramMessage(chatId, `❌ 获取列表失败: ${e.message}`, env); }
}

// 1. 大小格式化
function formatFileSize(bytes) {
    const num = Number(bytes);
    if (isNaN(num) || num === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(num) / Math.log(k));
    if (i < 0) return num + ' B';
    if (i >= sizes.length) return '>PB';
    return parseFloat((num / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTimestamp(ts) {
    const num = Number(ts);
    // 如果是 0、无效数字或特别小的数字(非毫秒)，返回未知
    if (isNaN(num) || num <= 0) return 'Unknown Time';

    // 创建 Date 对象 (输入假设为 UTC 的毫秒数)
    const date = new Date(num);

    // 转换为 UTC+8 (北京时间)
    // 方法：获取 UTC 时间戳 -> 加上 8小时的毫秒数 -> 重新生成 Date 对象 -> 取 UTC 字段
    // 8小时 = 8 * 60 * 60 * 1000 = 28800000 毫秒
    const offset = 8 * 60 * 60 * 1000;
    const localDate = new Date(date.getTime() + offset);

    const y = localDate.getUTCFullYear();
    const m = String(localDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(localDate.getUTCDate()).padStart(2, '0');
    const h = String(localDate.getUTCHours()).padStart(2, '0');
    const min = String(localDate.getUTCMinutes()).padStart(2, '0');
    const s = String(localDate.getUTCSeconds()).padStart(2, '0');

    return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

function buildDirKeyboard(dirs, cmdId = "") {
  const keyboard = []; 
  let row = [];
  
  dirs.forEach((dir, index) => { 
      // 传递 cmdId 到下一级
      row.push({ text: `📂 ${dir}`, callback_data: `browse:${dir}:0:${cmdId}` }); 
      
      if (row.length === 2 || index === dirs.length - 1) { 
          keyboard.push(row); 
          row = []; 
      } 
  });
  
  // 底部增加关闭按钮，绑定 cmdId 以便删除命令消息
  keyboard.push([{ text: "❌ 关闭面板", callback_data: `close_panel:${cmdId}` }]);
  
  return keyboard;
}

async function sendDirectoryBrowser(chatId, dirs, env, cmdId = "") {
  const keyboard = buildDirKeyboard(dirs, cmdId);
  await callTelegramApi("sendMessage", {
      chat_id: chatId,
      text: "📂 **图床文件管理**\n请选择要浏览的目录：",
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
  }, env, { muteError: true });
}

async function editToDirectoryBrowser(chatId, messageId, dirs, env, cmdId = "") {
  const keyboard = buildDirKeyboard(dirs, cmdId);
  await callTelegramApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: "📂 **图床文件管理**\n请选择要浏览的目录：",
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
  }, env, { muteError: true });
}

async function editMessageCaption(chatId, messageId, text, env) {
  await callTelegramApi("editMessageCaption", {
      chat_id: chatId,
      message_id: messageId,
      caption: text,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [] },
  }, env, { muteError: true });
}

async function deleteMessage(chatId, messageId, env) {
  await callTelegramApi("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
  }, env, { muteError: true });
}

async function answerCallbackQuery(id, text, env) {
  const payload = { callback_query_id: id };
  if (typeof text === "string" && text.length > 0) {
    payload.text = text;
  }
  await callTelegramApi("answerCallbackQuery", payload, env, { muteError: true });
}

// --- /info 命令处理逻辑 ---
async function handleInfoCommand(msg, chatId, env, ctx) {
    // 1. 确定目标消息 (回复的消息 OR 当前消息)
    const targetMsg = msg.reply_to_message ? msg.reply_to_message : msg;
    
    // 2. 提取关键信息
    const infoData = {
        message_id: targetMsg.message_id,
        chat_id: targetMsg.chat.id,
        // 格式化时间
        sent_date: new Date(targetMsg.date * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        media_info: getMediaInfo(targetMsg) // 复用现有的 helper
    };

    // 3. 构建显示文本 (JSON 格式)
    const jsonStr = JSON.stringify(targetMsg, null, 2);
    // 防止消息过长截断 (TG 限制 4096 字符，这里留足余量)
    const safeJson = jsonStr.length > 3000 ? jsonStr.substring(0, 3000) + "...(truncated)" : jsonStr;

    let displayText = `ℹ️ <b>消息元数据</b>\n\n`;
    displayText += `🆔 <b>Msg ID:</b> <code>${infoData.message_id}</code>\n`;
    displayText += `📅 <b>时间:</b> <code>${infoData.sent_date}</code>\n`;
    
    if (infoData.media_info) {
        displayText += `📎 <b>File Name:</b> <code>${infoData.media_info.fileName}</code>\n`;
        displayText += `🔑 <b>File ID:</b> <code>${infoData.media_info.fileId}</code>\n`;
        displayText += `📂 <b>Type:</b> <code>${infoData.media_info.type}</code>\n`;
    }

    displayText += `\n📋 <b>原始 JSON:</b>\n<pre><code class="language-json">${safeJson}</code></pre>`;

    // 4. 发送信息
    const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
            chat_id: chatId, 
            text: displayText, 
            parse_mode: "HTML", 
            reply_to_message_id: targetMsg.message_id 
        })
    });
    const resData = await res.json();

    // 5. 设置自动销毁 (如果发送成功)
    if (resData.ok) {
        const sentMsgId = resData.result.message_id;
        const userCmdMsgId = msg.message_id;
        
        // 放入 waitUntil 确保 Worker 不会在响应后立即冻结
        ctx.waitUntil(delayDelete(chatId, [sentMsgId, userCmdMsgId], env));
    }
}

// --- /delete 命令处理逻辑 (二次确认 + 路径显示版) ---
async function handleDeleteCommand(msg, chatId, env, ctx) {
    const targetMsg = msg.reply_to_message;
    const mediaInfo = getMediaInfo(targetMsg);
    const tgFileId = mediaInfo?.fileId;

    // 发送查找状态
    const feedback = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: "🔍 正在匹配图床索引...", reply_to_message_id: msg.message_id })
    }).then(r => r.json());

    if (!feedback.ok) return;
    const feedbackId = feedback.result.message_id;

    try {
        // 1. 读取 img_url (只读)
        if (!env.img_url) throw new Error("未绑定 img_url KV");
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
        // --- 核心修改：直接使用 id，不再进行复杂的字符串替换 ---
        const deletePath = targetData.id; 
        const fileName = (targetData.metadata && targetData.metadata.FileName) || "未知文件名";

        // 存入 TG_KV (临时任务缓存)
        if (env.TG_KV) {
            const tempKey = `del_task:${chatId}:${targetMsg.message_id}`;
            await env.TG_KV.put(tempKey, JSON.stringify({
                path: deletePath,
                cmdId: msg.message_id
            }), { expirationTtl: 600 });
        }

        // 修改确认面板的文字显示
        const keyboard = {
            inline_keyboard: [[
                { text: "✅ 确认删除", callback_data: `confirm_del:yes:${targetMsg.message_id}` },
                { text: "❌ 取消操作", callback_data: `confirm_del:no:${targetMsg.message_id}` }
            ]]
        };

        const confirmText = `⚠️ <b>确认从图床删除？</b>\n\n🆔 <b>文件路径 (ID):</b>\n<code>${deletePath}</code>\n\n📄 <b>原始名称:</b> <code>${fileName}</code>\n\n确认后将物理删除文件并撤回此消息。`;
        
        await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId, message_id: feedbackId,
                text: confirmText, parse_mode: "HTML", reply_markup: keyboard
            })
        });

    } catch (e) {
        await editMessageText(chatId, feedbackId, `❌ 处理出错: ${e.message}`, env);
        ctx.waitUntil(delayDelete(chatId, [msg.message_id, feedbackId], env));
    }
}

async function deleteFromImageHost(path, env) {
  if (!env.API_DELETE_TOKEN) return { success: false, error: "未配置 API_DELETE_TOKEN" };

  try {
    const uploadUrl = new URL(env.API_UPLOAD_URL);

    // 保留路径分隔符，编码每段，避免 %2F 破坏路由
    const safePath = String(path || "")
      .split("/")
      .map(part => encodeURIComponent(part))
      .join("/");

    const finalUrl = `${uploadUrl.origin}/api/manage/delete/${safePath}`;

    const response = await fetchWithTimeout(finalUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${env.API_DELETE_TOKEN}`,
        "User-Agent": "TelegramBot/1.0",
        "Accept": "application/json",
      },
    }, CONST.DELETE_API_TIMEOUT_MS);

    const resJson = await response.json().catch(() => ({}));

    // 兼容多种后端返回格式
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
  } catch (e) {
    const errorDesc = e && e.name === "AbortError" ? "API 请求超时" : (e.message || String(e));
    return { success: false, error: `网络异常: ${errorDesc}` };
  }
}

// 辅助函数：编辑消息文本
async function editMessageText(chatId, messageId, text, env) {
    await callTelegramApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: "HTML",
    }, env, { muteError: true });
}

// --- 延迟删除辅助函数 ---
async function delayDelete(chatId, messageIds, env) {
    await sleep(CONST.AUTO_DELETE_DELAY_MS);

    await Promise.all((messageIds || []).map(async (msgId) => {
      try {
        await deleteMessage(chatId, msgId, env);
      } catch (_e) {
        // 忽略消息已删除等错误
      }
    }));
}

// --- 新增辅助函数：清空 KV ---
async function clearAllKV(env) {
    if (!env.TG_KV) return 0;

    let keysDeleted = 0;
    let cursor = null;

    // 分页 + 分组并发删除，降低长耗时风险
    do {
      const list = await env.TG_KV.list({ cursor, limit: 1000 });
      const keyNames = (list.keys || []).map(key => key.name);

      for (const batch of chunkArray(keyNames, CONST.KV_DELETE_PARALLEL)) {
        await Promise.all(batch.map(async (name) => {
          try {
            await env.TG_KV.delete(name);
            keysDeleted += 1;
          } catch (e) {
            logError("clearAllKV", e, { key: name });
          }
        }));
      }

      cursor = list.list_complete ? null : list.cursor;
    } while (cursor);

    return keysDeleted;
}

// ==========================================
// 🎲 随机图功能模块 (无鉴权版)
// ==========================================

// 1. 发送初始面板 (Text -> Photo 转换逻辑)
async function sendRandomPanel(chatId, dir, env, userCmdId = "") {
    // 发送一个 "⏳" 消息，让用户知道收到指令了
    // 这里的 callback_data 带着 userCmdId，万一卡住了用户也能点关闭并顺手删掉指令
    const keyboard = [[{ text: "🗑 关闭面板", callback_data: `close_panel:${userCmdId}` }]];

    const sentRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
            chat_id: chatId, 
            text: "⏳ <b>正在随机抽取...</b>", 
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: keyboard }
        })
    });
    
    const sentData = await sentRes.json();
    if (sentData.ok) {
        // 把这个“加载中消息”的 ID (sentData.result.message_id) 传给渲染函数
        // 渲染函数会在图片发出来后，把这条消息删掉
        await renderRandomImage(chatId, sentData.result.message_id, dir, env, false, userCmdId); 
    }
}

// 2. 核心渲染 (修复 MOV 无法播放 - 增加流式播放支持)
async function renderRandomImage(chatId, messageId, dir, env, isEditMedia, userCmdId = "") {
    // 救援键盘
    const errorKeyboard = [
        [{ text: "📂 切换目录", callback_data: `rnd:pick:${dir}:${userCmdId}` }],
        [{ text: "🗑 关闭面板", callback_data: `close_panel:${userCmdId}` }]
    ];

    try {
        const uploadUrlObj = new URL(env.API_UPLOAD_URL);
        const apiUrl = new URL(`${uploadUrlObj.origin}/random`);
        
        apiUrl.searchParams.append('form', 'json');
        apiUrl.searchParams.append('type', 'url');
        if (dir && dir !== "all") {
            apiUrl.searchParams.append('dir', dir);
        }

        // --- 获取逻辑 ---
        const fetchRandom = async (forceVideo = false) => {
            if (forceVideo) apiUrl.searchParams.set('content', 'video');
            else apiUrl.searchParams.delete('content'); 

            const res = await fetch(apiUrl.toString(), { 
                method: 'GET', 
                headers: { "User-Agent": "TelegramBot/1.0" } 
            });
            if (!res.ok) return null;
            const json = await res.json();
            return json.url || (json.data && json.data.url) || null;
        };

        let finalUrl = await fetchRandom(false);
        if (!finalUrl) finalUrl = await fetchRandom(true);
        if (!finalUrl) throw new Error("该目录下没有文件");

        // URL 补全
        if (!finalUrl.startsWith("http")) {
            const path = finalUrl.startsWith('/') ? finalUrl : `/${finalUrl}`;
            finalUrl = `${uploadUrlObj.origin}${path}`;
        }

        // --- 核心修复1：精准识别文件后缀 ---
        // 过滤掉 URL 中的参数(?)和哈希(#)，安全提取后缀
        const cleanUrl = finalUrl.split('?')[0].split('#')[0];
        const ext = cleanUrl.split('.').pop().toLowerCase();

        const isVideo = ['mp4', 'webm', 'mov', 'mkv', 'gif', 'avi', 'm4v', 'flv'].includes(ext);
        const mediaType = isVideo ? 'video' : 'photo';

        const caption = `🎲 **随机漫游**\n\n📂 范围: \`${dir === 'all' ? '全部' : dir}\``;
        
        const keyboard = [
            [
                { text: "📂 切换目录", callback_data: `rnd:pick:${dir}:${userCmdId}` },
                { text: "🔄 下一张", callback_data: `rnd:next:${dir}:${userCmdId}` }
            ],
            [{ text: "🗑 关闭面板", callback_data: `close_panel:${userCmdId}` }]
        ];

        // --- 发送/更新 ---
        if (isEditMedia) {
            // A. 编辑模式
            await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageMedia`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: chatId,
                    message_id: messageId,
                    media: {
                        type: mediaType,
                        media: finalUrl,
                        caption: caption,
                        parse_mode: "Markdown",
                        // 关键修改：告诉 TG 尝试流式播放
                        supports_streaming: true 
                    },
                    reply_markup: { inline_keyboard: keyboard }
                })
            });
        } else {
            // B. 初始模式
            const method = isVideo ? 'sendVideo' : 'sendPhoto';
            const paramName = isVideo ? 'video' : 'photo';
            
            // 构建请求体
            const payload = {
                chat_id: chatId,
                [paramName]: finalUrl,
                caption: caption,
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: keyboard }
            };

            // 关键修改：如果是视频，开启流式播放支持
            if (isVideo) {
                payload.supports_streaming = true;
            }

            const mediaRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (mediaRes.ok) {
                await deleteMessage(chatId, messageId, env);
            } else {
                const errData = await mediaRes.json();
                throw new Error(errData.description || "发送失败");
            }
        }

    } catch (e) {
        const errText = `❌ **获取失败**: ${e.message}\n请尝试切换目录或重试。`;
        const method = isEditMedia ? 'editMessageCaption' : 'editMessageText';
        const bodyKey = isEditMedia ? 'caption' : 'text';

        await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: chatId, message_id: messageId, [bodyKey]: errText, parse_mode: "Markdown",
                reply_markup: { inline_keyboard: errorKeyboard }
            })
        });
    }
}

// 3. 构建目录键盘 (支持传递 cmdId)
function buildRandomDirKeyboard(dirs, currentDir, cmdId = "") {
    const keyboard = [];
    
    // 顶部选项
    const isAll = currentDir === 'all';
    keyboard.push([{ text: (isAll ? "✅ " : "") + "🌟 所有目录 (All)", callback_data: `rnd:set:all:${cmdId}` }]);

    let row = [];
    dirs.forEach((dir, index) => {
        const isSelected = dir === currentDir;
        row.push({ text: (isSelected ? "✅ " : "") + dir, callback_data: `rnd:set:${dir}:${cmdId}` });
        
        if (row.length === 2 || index === dirs.length - 1) {
            keyboard.push(row);
            row = [];
        }
    });
    
    // 底部返回
    keyboard.push([{ text: "🔙 返回", callback_data: `rnd:next:${currentDir}:${cmdId}` }]); 
    return keyboard;
}

// ==========================================
// 🆕 增强版：命令配置与注册逻辑
// ==========================================

const COMMANDS_PRIVATE = [
    { command: "list", description: "📂 浏览图床目录" },
    { command: "random", description: "🎲 随机图面板" },
    { command: "reset", description: "🔄 重置上传缓存" },
    { command: "init", description: "⚙️ 刷新命令菜单" }
];

const COMMANDS_PUBLIC = [
    { command: "info", description: "ℹ️ 查看消息元数据" },
    { command: "delete", description: "🗑 删除文件" }
];

async function setupBotCommands(env, targetChatId = null) {
    const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/setMyCommands`;
    const results = [];

    // --- 策略：由内而外，覆盖所有可能的作用域 ---

    // 1. 【私聊】 (优先级最高) -> 显示完整功能
    // scope: all_private_chats
    results.push(await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands: COMMANDS_PRIVATE, scope: { type: "all_private_chats" } })
    }));

    // 2. 【管理员】 (关键！频道发帖者属于管理员) -> 仅显示 info
    // scope: all_chat_administrators
    // 这行代码是解决频道不显示的 vital key
    results.push(await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands: COMMANDS_PUBLIC, scope: { type: "all_chat_administrators" } })
    }));

    // 3. 【群组】 (普通群成员) -> 仅显示 info
    // scope: all_group_chats
    results.push(await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands: COMMANDS_PUBLIC, scope: { type: "all_group_chats" } })
    }));

    // 4. 【默认兜底】 (频道通常落在这里) -> 仅显示 info
    // scope: default
    results.push(await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands: COMMANDS_PUBLIC, scope: { type: "default" } })
    }));

    // 5. 【强制当前用户】 (如果有传入 chatId) -> 显示完整功能
    // 强制刷新你自己的私聊界面
    if (targetChatId) {
        results.push(await fetch(url, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
                commands: COMMANDS_PRIVATE, 
                scope: { type: "chat", chat_id: targetChatId } 
            })
        }));
    }

    return results.every(r => r.ok);
}
