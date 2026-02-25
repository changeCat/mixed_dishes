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

// --- 配置辅助函数 ---

function getChannels(env) {
    const raw = env.CHANNEL_LIST || "TG:telegram";
    return raw.split(",").map(item => {
        const parts = item.split(":");
        const name = parts[0].trim(); // 显示名称
        const provider = parts.length > 1 ? parts[1].trim() : name; // 渠道类型 (telegram, huggingface等)
        const subChannel = parts.length > 2 ? parts[2].trim() : null; // 扩展参数 (channelName)
        
        // 核心逻辑：
        // 如果有第三个参数，我们将 value 组合为 "类型|参数" 的格式
        // 这样 callback 传递数据时就能同时带上这两个信息，且不破坏现有的字符串传递逻辑
        const value = subChannel ? `${provider}|${subChannel}` : provider;
        
        return { name, value };
    });
}

function getDirs(env) {
    const dirListStr = env.DIR_LIST || "";
    return dirListStr.split(",").map(d => d.trim()).filter(d => d);
}

// --- 核心逻辑 ---

async function handleUpdate(update, env, ctx) {
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
    userId = chatId; // 频道没有具体用户，用频道ID鉴权
    chatType = "channel";
  } else if (update.callback_query) {
    // 按钮回调优先处理，因为它是交互操作，不属于“命令/消息”分类
    await handleCallback(update.callback_query, env);
    return;
  } else {
    return; // 未知更新类型，忽略
  }

  // 鉴权 (检查 ALLOWED_USERS)
  const allowedUsers = (env.ALLOWED_USERS || "").split(",").map(id => id.trim());
  // 注意：如果是频道消息，这里的 userId 就是频道 ID
  if (!allowedUsers.includes(String(userId))) {
    return;
  }

  // 提取文本，防止后续重复提取
  const text = msg.text || msg.caption || "";

  // ==============================
  // 2. 核心分流逻辑 (If / Else)
  // ==============================

  if (chatType === "private") {
    // ————————————————
    // 🅰️ 私聊分支 (Private)
    // 包含：所有管理命令 + 文件上传
    // ————————————————

    // 0. /init - 初始化/更新命令提示
    if (text === "/init") {
        await sendTelegramMessage(chatId, "🔄 正在强制刷新命令菜单...", env);
        try {
            // 注意：这里传入了 chatId
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
      const dirs = getDirs(env);
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

    // 3. /clean - 清理消息
    if (text === "/clean") {
      if (msg.reply_to_message) {
        await deleteMessage(chatId, msg.reply_to_message.message_id, env);
      }
      await deleteMessage(chatId, msg.message_id, env);
      return;
    }

    // 4. /random - 随机图面板
    if (text === "/random") {
      await sendRandomPanel(chatId, "all", env, msg.message_id);
      return;
    }

    // 5. 文件/链接上传检测
    // (放在命令判断之后，作为默认行为)
    const mediaInfo = getMediaInfo(msg);
    if (mediaInfo) {
      if (msg.media_group_id && env.TG_KV) {
        await handleBatchPreProcess(msg, mediaInfo, env);
        return;
      }
      const channels = getChannels(env);
      const defaultChannel = channels[0].value;
      await sendUnifiedPanel(chatId, mediaInfo, defaultChannel, env);
    }

  } else {
    // ————————————————
    // 🅱️ 非私聊分支 (Channel / Group)
    // 包含：仅限 /info
    // ————————————————

    // 1. /info - 查看元数据
    if (text === "/info") {
      await handleInfoCommand(msg, chatId, env, ctx);
      return;
    }

    // 🛑 关键点：
    // 这里没有写任何关于 getMediaInfo 或 upload 的代码。
    // 所以，Bot 在频道里发出的图片（或用户在群里发的无关图片），
    // 都会因为不匹配 /info 而直接结束，从而彻底根除死循环。
  }
}

// --- 批量逻辑 (KV 依赖) ---
async function handleBatchPreProcess(msg, mediaInfo, env) {
    const groupId = msg.media_group_id;
    const chatId = msg.chat.id;
    const fileKey = `batch:${groupId}:file:${mediaInfo.fileId}`;
    await env.TG_KV.put(fileKey, JSON.stringify(mediaInfo), { expirationTtl: 3600 });

    const randomDelay = Math.floor(Math.random() * 750) + 50;
    await new Promise(resolve => setTimeout(resolve, randomDelay));

    const panelKey = `batch:${groupId}:panel`;
    const hasPanel = await env.TG_KV.get(panelKey);

    if (!hasPanel) {
        await env.TG_KV.put(panelKey, "pending", { expirationTtl: 3600 });
        // 初始询问模式
        const keyboard = [
            [{ text: "📦 统一上传 (推荐)", callback_data: `mode:unify` }],
            [{ text: "📑 分别上传 (繁琐)", callback_data: `mode:separate` }],
            [{ text: "❌ 取消", callback_data: "batch_cancel" }]
        ];
        const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: "📚 **收到一组文件**\n请选择处理方式：", parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard }, reply_to_message_id: msg.message_id })
        });
        const resJson = await res.json();
        if (resJson.ok) {
            const mapKey = `map:${chatId}:${resJson.result.message_id}`;
            await env.TG_KV.put(mapKey, groupId, { expirationTtl: 3600 });
        }
    }
}


// ----------------------------------------------------------------
// ⚠️ 核心交互逻辑：handleCallback
// ----------------------------------------------------------------
async function handleCallback(query, env) {
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
      const channelCode = parts[2]; // 从 callback 直接获取当前选中的 channel

      const mapKey = `map:${chatId}:${messageId}`;
      const groupId = await env.TG_KV.get(mapKey);
      
      if (!groupId) return answerCallbackQuery(query.id, "任务过期", env);
      
      await answerCallbackQuery(query.id, "开始上传...", env);
      
      // 更新状态
      await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
              chat_id: chatId, message_id: messageId,
              text: `⏳ 正在批量上传至 [${targetDir}]\n📡 渠道: ${channelCode}...`, 
              parse_mode: "HTML" 
          })
      });

      const listResult = await env.TG_KV.list({ prefix: `batch:${groupId}:file:` });
      if (listResult.keys.length === 0) {
          await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: "❌ 未找到文件", parse_mode: "HTML" })
          });
          return;
      }

      let successCount = 0; 
      let failCount = 0;
      let resultText = `✅ <b>批量上传完成</b>\n📂 <b>目录:</b> ${targetDir}\n📡 <b>渠道:</b> ${channelCode}\n━━━━━━━━━━━━━━━\n`;
      
      const uploadPromises = listResult.keys.map(async (key) => {
          const mInfo = JSON.parse(await env.TG_KV.get(key.name));
          try {
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
    const channelCode = parts[2]; // 从 callback 获取

    await answerCallbackQuery(query.id, "正在请求上传...", env);
    
    let mediaInfo = getMediaInfo(query.message);
    if (!mediaInfo && query.message.reply_to_message) {
      mediaInfo = getMediaInfo(query.message.reply_to_message);
    }
    
    if (mediaInfo) {
      await editMessageCaption(chatId, messageId, `⏳ 正在上传至 [${targetDir}]\n📡 渠道: ${channelCode}...`, env);
      await processUpload(chatId, mediaInfo, targetDir, channelCode, env, messageId);
    } else {
      await sendTelegramMessage(chatId, "❌ 文件信息过期", env);
      await deleteMessage(chatId, messageId, env);
    }
    return;
  }

  // --- 5. 通用操作 ---
  if (data === "upload_cancel" || data === "batch_cancel") {
      await answerCallbackQuery(query.id, "已取消", env);
      await deleteMessage(chatId, messageId, env);
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
        const fileLinkData = await fileLinkRes.json();
        if (!fileLinkData.ok) throw new Error("获取 TG 文件链接失败");
        const downloadUrl = `https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${fileLinkData.result.file_path}`;
        const fileRes = await fetch(downloadUrl);
        if (!fileRes.ok) throw new Error("下载 TG 文件失败");
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
  } else if (msg.video) {
    fileId = msg.video.file_id;
    type = "video";
    baseName += ".mp4";
  } else if (msg.animation) {
    fileId = msg.animation.file_id;
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
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown", disable_web_page_preview: true })
  });
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
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
        chat_id: chatId, 
        text: "📂 **图床文件管理**\n请选择要浏览的目录：", 
        parse_mode: "Markdown", 
        reply_markup: { inline_keyboard: keyboard } 
    })
  });
}

async function editToDirectoryBrowser(chatId, messageId, dirs, env, cmdId = "") {
  const keyboard = buildDirKeyboard(dirs, cmdId);
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
        chat_id: chatId, 
        message_id: messageId, 
        text: "📂 **图床文件管理**\n请选择要浏览的目录：", 
        parse_mode: "Markdown", 
        reply_markup: { inline_keyboard: keyboard } 
    })
  });
}

async function editMessageCaption(chatId, messageId, text, env) {
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageCaption`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, caption: text, parse_mode: "Markdown", reply_markup: { inline_keyboard: [] } })
  });
}
async function deleteMessage(chatId, messageId, env) {
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/deleteMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  });
}
async function answerCallbackQuery(id, text, env) {
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: id, text: text })
  });
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

// --- 延迟删除辅助函数 ---
async function delayDelete(chatId, messageIds, env) {
    // 等待 12 秒
    await new Promise(resolve => setTimeout(resolve, 12000));
    
    // 遍历删除
    for (const msgId of messageIds) {
        await deleteMessage(chatId, msgId, env);
    }
}

// --- 新增辅助函数：清空 KV ---
async function clearAllKV(env) {
    if (!env.TG_KV) return 0;
    
    let keysDeleted = 0;
    let cursor = null;
    
    // 循环分页获取并删除，防止 key 太多一次删不完
    do {
        const list = await env.TG_KV.list({ cursor: cursor, limit: 1000 });
        if (list.keys.length > 0) {
            for (const key of list.keys) {
                await env.TG_KV.delete(key.name);
                keysDeleted++;
            }
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
        let ext = "";
        try {
            const urlObj = new URL(finalUrl);
            ext = urlObj.pathname.split('.').pop().toLowerCase();
        } catch (e) {
            ext = finalUrl.split('.').pop().toLowerCase();
        }

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
    { command: "clean", description: "🧹 清理消息" },
    { command: "reset", description: "🔄 重置上传缓存" },
    { command: "init", description: "⚙️ 刷新命令菜单" }
];

const COMMANDS_PUBLIC = [
    { command: "info", description: "ℹ️ 查看消息元数据" }
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
