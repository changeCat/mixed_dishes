// =================================================================
// Proxy Rule Telegram Bot (3-Type Hierarchy UI)
// =================================================================

const KV_KEYS = {
  PROXY: 'proxy_rules',
  DIRECT: 'direct_rules',
};

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
 * 帮助信息 (使用 HTML 格式避免 MarkdownV2 转义报错)
 */
async function sendHelpMessage(chatId, env, workerUrl) {
  const helpText = `
<b>🤖 分流规则管理助手</b>

这是一个基于 Cloudflare KV 的域名分流管理工具。

<b>🛠 使用方法：</b>
• <b>添加/编辑：</b> 直接发送域名（如 google.com），机器人将弹出操作菜单。
• <b>查看列表：</b> 点击下方按钮或输入命令查看现有规则。

<b>📝 命令列表：</b>
/proxylist - 查看代理列表
/directlist - 查看直连列表
/start - 显示此帮助信息

<b>🔗 订阅链接：</b>
<code>${workerUrl}proxyList.list</code>
<code>${workerUrl}directList.list</code>

<b>💡 匹配说明：</b>
• <b>DOMAIN</b>: 精确匹配域名
• <b>DOMAIN-SUFFIX</b>: 匹配域名及其子域名
• <b>DOMAIN-KEYWORD</b>: 包含关键字匹配
  `.trim();

  await sendTelegramRequest('sendMessage', { 
    chat_id: chatId, 
    text: helpText, 
    parse_mode: 'HTML',
    disable_web_page_preview: true
  }, env);
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
    const oppositeList = currentList === 'PROXY' ? 'DIRECT' : 'PROXY';
    const otherTypes = types.filter(t => t !== currentRule.type);
    keyboard.inline_keyboard.push([{ text: `📍 当前: ${currentList} | ${currentRule.type}`, callback_data: 'ignore' }]);
    keyboard.inline_keyboard.push(otherTypes.map(t => ({ text: `🔄 ${t}`, callback_data: `type:${domain}:${t}` })));
    keyboard.inline_keyboard.push([{ text: `🚀 移至 ${oppositeList}`, callback_data: `move:${domain}:${oppositeList}` }]);
    keyboard.inline_keyboard.push([{ text: `🗑️ 删除`, callback_data: `del:${domain}` }, { text: `❌ 取消`, callback_data: 'cancel:msg' }]);

    const status = `🔍 *规则管理*\n\n域 名: \`${escapeMarkdown(domain)}\`\n该域名已存在，您可以执行操作：`;
    await sendTelegramRequest('sendMessage', { chat_id: chatId, text: status, parse_mode: 'MarkdownV2', reply_markup: keyboard }, env);
  } else {
    keyboard.inline_keyboard.push([{ text: '━━━━━━━ 🚀 PROXY ━━━━━━━', callback_data: 'ignore' }]);
    keyboard.inline_keyboard.push(types.map(t => ({ text: t, callback_data: `add:${domain}:PROXY:${t}` })));
    keyboard.inline_keyboard.push([{ text: '━━━━━━━ 🏠 DIRECT ━━━━━━━', callback_data: 'ignore' }]);
    keyboard.inline_keyboard.push(types.map(t => ({ text: t, callback_data: `add:${domain}:DIRECT:${t}` })));
    keyboard.inline_keyboard.push([{ text: '❌ 取消', callback_data: 'cancel:msg' }]);

    const status = `🆕 *识别到新域名*\n\n域 名: \`${escapeMarkdown(domain)}\`\n请选择列表及匹配类型：`;
    await sendTelegramRequest('sendMessage', { chat_id: chatId, text: status, parse_mode: 'MarkdownV2', reply_markup: keyboard }, env);
  }
}

async function handleCallbackQuery(query, env) {
  const { id, data, message } = query;
  if (data === 'ignore') return await sendTelegramRequest('answerCallbackQuery', { callback_query_id: id }, env);
  if (data === 'cancel:msg') return await sendTelegramRequest('deleteMessage', { chat_id: message.chat.id, message_id: message.message_id }, env);

  const [action, domain, p1, p2] = data.split(':');
  const lists = await getRuleLists(env);
  const clear = (d) => { lists[KV_KEYS.PROXY].delete(d); lists[KV_KEYS.DIRECT].delete(d); };
  let feedbackText = '';

  try {
    if (action === 'add') {
      clear(domain);
      const key = p1 === 'PROXY' ? KV_KEYS.PROXY : KV_KEYS.DIRECT;
      lists[key].set(domain, { raw: `${p2},${domain}`, type: p2, domain });
      feedbackText = `✅ 已添加至 ${p1}`;
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
      feedbackText = `📝 改为 ${p1}`;
    }

    await Promise.all([
      env.RULE_STORE.put(KV_KEYS.PROXY, Array.from(lists[KV_KEYS.PROXY].values()).map(r => r.raw).join('\n')),
      env.RULE_STORE.put(KV_KEYS.DIRECT, Array.from(lists[KV_KEYS.DIRECT].values()).map(r => r.raw).join('\n'))
    ]);

    await sendTelegramRequest('answerCallbackQuery', { callback_query_id: id, text: feedbackText }, env);
    await sendTelegramRequest('editMessageText', {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: `${feedbackText}\n域名: \`${domain}\``,
      parse_mode: 'MarkdownV2'
    }, env);
  } catch (e) {
    await sendTelegramRequest('answerCallbackQuery', { callback_query_id: id, text: '❌ 操作失败' }, env);
  }
}

async function handleTelegramUpdate(update, env, ctx, workerUrl) {
  const msg = update.message;
  const cb = update.callback_query;
  const userId = cb ? cb.from.id : msg?.from?.id;

  if (!userId || !parseAuthorizedUsers(env).has(String(userId))) return;

  if (cb) return await handleCallbackQuery(cb, env);

  if (msg?.text) {
    const text = msg.text.trim();
    if (text.startsWith('/')) {
      const cmd = text.toLowerCase().split(' ')[0].split('@')[0]; // 处理 /start@bot_name 格式
      if (cmd === '/start') {
        await sendHelpMessage(msg.chat.id, env, workerUrl);
      } else if (LIST_COMMANDS[cmd.substring(1)]) {
        const rules = (await env.RULE_STORE.get(LIST_COMMANDS[cmd.substring(1)].key)) || '# 列表为空';
        await sendTelegramRequest('sendMessage', { 
          chat_id: msg.chat.id, 
          text: `*${LIST_COMMANDS[cmd.substring(1)].title}*\n\`\`\`\n${rules}\n\`\`\``, 
          parse_mode: 'MarkdownV2' 
        }, env);
      }
    } else if (/^[a-zA-Z0-9\-\.\*]+$/.test(text) && text.includes('.')) {
      await handleDomainInteraction(msg.chat.id, text, env);
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const workerUrl = `${url.origin}/`;

    if (url.pathname === '/proxyList.list') return new Response(await env.RULE_STORE.get(KV_KEYS.PROXY) || '', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    if (url.pathname === '/directList.list') return new Response(await env.RULE_STORE.get(KV_KEYS.DIRECT) || '', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    
    if (request.method === 'POST') {
      const update = await request.json();
      ctx.waitUntil(handleTelegramUpdate(update, env, ctx, workerUrl));
    }
    return new Response('OK');
  }
};