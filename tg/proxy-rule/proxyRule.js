// =================================================================
// Proxy Rule Telegram Bot (3-Type Hierarchy UI)
// =================================================================

const KV_KEYS = {
  PROXY: 'proxy_rules',
  DIRECT: 'direct_rules',
};

// 默认支持的三种类型
const DEFAULT_SUPPORTED_TYPES = ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD'];

const LIST_COMMANDS = {
  proxylist: { key: KV_KEYS.PROXY, title: 'PROXY 代理列表' },
  directlist: { key: KV_KEYS.DIRECT, title: 'DIRECT 直连列表' },
};

const escapeMarkdown = (t) => t.replace(/([_{}\[\]()#+\-|=.!])/g, '\\$1');

const parseAuthorizedUsers = (env) => new Set(String(env?.AUTHORIZED_USERS || '').split(',').map(i => i.trim()).filter(Boolean));

async function sendTelegramRequest(method, payload, env) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return await response.json();
}

async function getRuleLists(env) {
  const [p, d] = await Promise.all([
    env.RULE_STORE.get(KV_KEYS.PROXY, 'text'),
    env.RULE_STORE.get(KV_KEYS.DIRECT, 'text'),
  ]);
  const parse = (txt) => {
    const map = new Map();
    (txt || '').split('\n').forEach(line => {
      const parts = line.trim().split(',');
      if (parts.length === 2) map.set(parts[1], { raw: line.trim(), type: parts[0].toUpperCase(), domain: parts[1] });
    });
    return map;
  };
  return { [KV_KEYS.PROXY]: parse(p), [KV_KEYS.DIRECT]: parse(d) };
}

/**
 * 核心 UI 构建
 */
async function handleDomainInteraction(chatId, domain, env) {
  const lists = await getRuleLists(env);
  const types = Array.isArray(env?.SUPPORTED_TYPES) ? env.SUPPORTED_TYPES : DEFAULT_SUPPORTED_TYPES;
  
  let currentList = null;
  let currentRule = null;

  if (lists[KV_KEYS.PROXY].has(domain)) {
    currentList = 'PROXY';
    currentRule = lists[KV_KEYS.PROXY].get(domain);
  } else if (lists[KV_KEYS.DIRECT].has(domain)) {
    currentList = 'DIRECT';
    currentRule = lists[KV_KEYS.DIRECT].get(domain);
  }

  const keyboard = { inline_keyboard: [] };

  if (currentRule) {
    // 【编辑模式】
    const oppositeList = currentList === 'PROXY' ? 'DIRECT' : 'PROXY';
    // 过滤掉当前类型，显示另外两种供切换
    const otherTypes = types.filter(t => t !== currentRule.type);

    keyboard.inline_keyboard.push([{ text: `📍 当前: ${currentList} | ${currentRule.type}`, callback_data: 'ignore' }]);
    
    // 第一行：切换到同列表的其他类型
    keyboard.inline_keyboard.push(
      otherTypes.map(t => ({ text: `🔄 ${t}`, callback_data: `type:${domain}:${t}` }))
    );
    
    // 第二行：移动到另一个列表
    keyboard.inline_keyboard.push([
      { text: `🚀 移至 ${oppositeList}`, callback_data: `move:${domain}:${oppositeList}` }
    ]);

    // 第三行：删除与取消
    keyboard.inline_keyboard.push([
      { text: `🗑️ 删除`, callback_data: `del:${domain}` },
      { text: `❌ 关闭`, callback_data: `cancel:msg` }
    ]);

    const status = `🔍 *规则管理*\n\n域 名: \`${escapeMarkdown(domain)}\`\n该域名已存在，您可以执行以下操作：`;
    await sendTelegramRequest('sendMessage', { chat_id: chatId, text: status, parse_mode: 'MarkdownV2', reply_markup: keyboard }, env);

  } else {
    // 【添加模式】
    
    // PROXY 分区
    keyboard.inline_keyboard.push([{ text: '━━━━━━━ 🚀 PROXY ━━━━━━━', callback_data: 'ignore' }]);
    keyboard.inline_keyboard.push(
      types.map(t => ({ text: t, callback_data: `add:${domain}:PROXY:${t}` }))
    );

    // DIRECT 分区
    keyboard.inline_keyboard.push([{ text: '━━━━━━━ 🏠 DIRECT ━━━━━━━', callback_data: 'ignore' }]);
    keyboard.inline_keyboard.push(
      types.map(t => ({ text: t, callback_data: `add:${domain}:DIRECT:${t}` }))
    );

    // 取消
    keyboard.inline_keyboard.push([{ text: '❌ 取消', callback_data: 'cancel:msg' }]);

    const status = `🆕 *识别到新域名*\n\n域 名: \`${escapeMarkdown(domain)}\`\n请选择要添加到的列表及匹配类型：`;
    await sendTelegramRequest('sendMessage', { chat_id: chatId, text: status, parse_mode: 'MarkdownV2', reply_markup: keyboard }, env);
  }
}

/**
 * 回调处理
 */
async function handleCallbackQuery(query, env) {
  const { id, data, message } = query;
  const chatId = message.chat.id;

  if (data === 'ignore') {
    await sendTelegramRequest('answerCallbackQuery', { callback_query_id: id }, env);
    return;
  }

  const [action, domain, p1, p2] = data.split(':');

  if (action === 'cancel') {
    await sendTelegramRequest('deleteMessage', { chat_id: chatId, message_id: message.message_id }, env);
    return;
  }

  const lists = await getRuleLists(env);
  const clear = (d) => { lists[KV_KEYS.PROXY].delete(d); lists[KV_KEYS.DIRECT].delete(d); };
  let feedbackText = '';

  try {
    if (action === 'add') {
      clear(domain);
      const key = p1 === 'PROXY' ? KV_KEYS.PROXY : KV_KEYS.DIRECT;
      lists[key].set(domain, { raw: `${p2},${domain}`, type: p2, domain });
      feedbackText = `✅ 已添加至 ${p1} [${p2}]`;
    } else if (action === 'del') {
      clear(domain);
      feedbackText = `🗑️ 已删除规则`;
    } else if (action === 'move') {
      const old = lists[KV_KEYS.PROXY].get(domain) || lists[KV_KEYS.DIRECT].get(domain);
      clear(domain);
      const key = p1 === 'PROXY' ? KV_KEYS.PROXY : KV_KEYS.DIRECT;
      const type = old?.type || 'DOMAIN';
      lists[key].set(domain, { raw: `${type},${domain}`, type, domain });
      feedbackText = `🚀 已移至 ${p1}`;
    } else if (action === 'type') {
      const currentListKey = lists[KV_KEYS.PROXY].has(domain) ? KV_KEYS.PROXY : KV_KEYS.DIRECT;
      lists[currentListKey].set(domain, { raw: `${p1},${domain}`, type: p1, domain });
      feedbackText = `📝 类型已改为 ${p1}`;
    }

    // 保存 KV
    const pData = Array.from(lists[KV_KEYS.PROXY].values()).map(r => r.raw).join('\n');
    const dData = Array.from(lists[KV_KEYS.DIRECT].values()).map(r => r.raw).join('\n');
    await Promise.all([
      env.RULE_STORE.put(KV_KEYS.PROXY, pData),
      env.RULE_STORE.put(KV_KEYS.DIRECT, dData)
    ]);

    await sendTelegramRequest('answerCallbackQuery', { callback_query_id: id, text: feedbackText }, env);
    await sendTelegramRequest('editMessageText', {
      chat_id: chatId,
      message_id: message.message_id,
      text: `${feedbackText}\n\n域名: \`${domain}\`\n配置已同步。`,
      parse_mode: 'MarkdownV2'
    }, env);
  } catch (e) {
    await sendTelegramRequest('answerCallbackQuery', { callback_query_id: id, text: '❌ 操作失败' }, env);
  }
}

async function handleTelegramUpdate(update, env, ctx) {
  const callback = update.callback_query;
  const message = update.message;

  // 获取用户 ID
  const userId = callback ? callback.from.id : message?.from?.id;
  if (!userId || !parseAuthorizedUsers(env).has(String(userId))) return;

  if (callback) {
    await handleCallbackQuery(callback, env);
    return;
  }

  if (message?.text) {
    const text = message.text.trim();
    if (text.startsWith('/')) {
      const cmd = text.split(' ')[0].replace('/', '').toLowerCase();
      if (LIST_COMMANDS[cmd]) {
        const rules = (await env.RULE_STORE.get(LIST_COMMANDS[cmd].key)) || '# 列表为空';
        await sendTelegramRequest('sendMessage', { chat_id: message.chat.id, text: `*${LIST_COMMANDS[cmd].title}*\n\`\`\`\n${rules}\n\`\`\``, parse_mode: 'MarkdownV2' }, env);
      }
    } else if (!text.includes(' ') && !text.includes(',') && !text.includes('\n')) {
      await handleDomainInteraction(message.chat.id, text, env);
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/proxyList.list') return new Response(await env.RULE_STORE.get(KV_KEYS.PROXY) || '', { headers: { 'Content-Type': 'text/plain' } });
    if (url.pathname === '/directList.list') return new Response(await env.RULE_STORE.get(KV_KEYS.DIRECT) || '', { headers: { 'Content-Type': 'text/plain' } });
    
    if (request.method === 'POST') {
      const update = await request.json();
      ctx.waitUntil(handleTelegramUpdate(update, env, ctx));
    }
    return new Response('OK');
  }
};