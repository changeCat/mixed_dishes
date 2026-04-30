// Cloudflare Worker for Telegram bot message remark/relay workflow
//
// Features:
// 1. Receive Telegram webhook updates.
// 2. Keep original messages unchanged.
// 3. Mark messages only by replying with /remsg.
// 4. Expose an HTTP endpoint to fetch all marked original messages.
// 5. Delete the mark after a successful fetch while retaining the original message.
//
// Required environment variables:
// - BOT_TOKEN: Telegram Bot Token
// - BOT_SECRET: Optional webhook secret token for Telegram
// - PULL_TOKEN: Token for pull API authentication
//
// Optional KV binding:
// - REMSG_KV: Cloudflare KV namespace for persistence
//   If not provided, marked messages are stored in-memory only, which is not durable.

const MEMORY_STORE = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/telegram/webhook') {
      return handleTelegramWebhook(request, env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/marked') {
      return handleMarkedPull(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/telegram/setWebhook') {
      return handleSetWebhook(request, env);
    }

    return jsonResponse(
      {
        ok: true,
        message: 'Worker is running',
        endpoints: {
          webhook: '/telegram/webhook',
          pullMarkedMessages: '/marked',
          setWebhook: '/telegram/setWebhook'
        }
      },
      200
    );
  }
};

async function handleTelegramWebhook(request, env, ctx) {
  if (env.BOT_SECRET) {
    const secret = request.headers.get('x-telegram-bot-api-secret-token');
    if (secret !== env.BOT_SECRET) {
      return jsonResponse({ ok: false, error: 'Unauthorized webhook secret' }, 401);
    }
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const message = update.message || update.edited_message;
  if (!message) {
    return jsonResponse({ ok: true, skipped: true, reason: 'No message payload' }, 200);
  }

  if (!isMarkCommand(message)) {
    return jsonResponse({ ok: true, skipped: true, reason: 'Message not marked' }, 200);
  }

  const targetMessage = message.reply_to_message;
  if (!targetMessage) {
    return jsonResponse(
      { ok: true, skipped: true, reason: 'Mark command exists but no replied target message' },
      200
    );
  }

  const item = buildMarkedItem(message, targetMessage);
  await saveMarkedItem(env, item);

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(
      sendTelegramMessage(env, message.chat.id, `已标记消息: ${item.key}`).catch((error) =>
        console.error('Send mark confirmation failed:', error)
      )
    );
  }

  return jsonResponse({ ok: true, marked: true, key: item.key }, 200);
}

async function handleMarkedPull(request, env) {
  const authError = authenticatePullRequest(request, env);
  if (authError) {
    return authError;
  }

  const items = await listMarkedItems(env);
  const orderedItems = items.sort((a, b) => a.markedAt - b.markedAt);
  const originalMessages = orderedItems.map((item) => item.targetMessage.raw);

  for (const item of orderedItems) {
    await deleteMarkedItem(env, item.key);
  }

  return jsonResponse(originalMessages, 200);
}

async function handleSetWebhook(request, env) {
  const body = await safeReadJson(request);
  const webhookUrl = body?.url;

  if (!webhookUrl) {
    return jsonResponse({ ok: false, error: 'Missing url in request body' }, 400);
  }

  const payload = {
    url: webhookUrl,
    allowed_updates: ['message', 'edited_message']
  };

  if (env.BOT_SECRET) {
    payload.secret_token = env.BOT_SECRET;
  }

  const result = await telegramApi(env, 'setWebhook', payload);
  return jsonResponse(result, result.ok ? 200 : 500);
}

function isMarkCommand(message) {
  const text = (message.text || '').trim().toLowerCase();
  if (!text) {
    return false;
  }

  return text === '/remsg' || text.startsWith('/remsg@');
}

function buildMarkedItem(markCommandMessage, targetMessage) {
  const chatId = targetMessage.chat?.id ?? markCommandMessage.chat.id;
  const messageId = targetMessage.message_id;
  const key = `${chatId}:${messageId}`;

  return {
    key,
    markedAt: Date.now(),
    markCommand: {
      chatId: markCommandMessage.chat.id,
      messageId: markCommandMessage.message_id,
      from: simplifyUser(markCommandMessage.from),
      text: markCommandMessage.text || ''
    },
    targetMessage: simplifyMessage(targetMessage)
  };
}

function simplifyMessage(message) {
  return {
    messageId: message.message_id,
    date: message.date,
    chat: simplifyChat(message.chat),
    from: simplifyUser(message.from),
    text: message.text || '',
    caption: message.caption || '',
    raw: message
  };
}

function simplifyChat(chat) {
  if (!chat) return null;
  return {
    id: chat.id,
    type: chat.type,
    title: chat.title,
    username: chat.username,
    firstName: chat.first_name,
    lastName: chat.last_name
  };
}

function simplifyUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    isBot: user.is_bot,
    username: user.username,
    firstName: user.first_name,
    lastName: user.last_name,
    languageCode: user.language_code
  };
}

function authenticatePullRequest(request, env) {
  if (!env.PULL_TOKEN) {
    return null;
  }

  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : null;

  const url = new URL(request.url);
  const queryToken = url.searchParams.get('token');
  const token = bearerToken || queryToken;

  if (token !== env.PULL_TOKEN) {
    return jsonResponse({ ok: false, error: 'Unauthorized pull request' }, 401);
  }

  return null;
}

async function saveMarkedItem(env, item) {
  if (env.REMSG_KV) {
    await env.REMSG_KV.put(item.key, JSON.stringify(item));
    return;
  }

  MEMORY_STORE.set(item.key, item);
}

async function listMarkedItems(env) {
  if (env.REMSG_KV) {
    const keys = await env.REMSG_KV.list();
    const items = [];

    for (const { name } of keys.keys) {
      const raw = await env.REMSG_KV.get(name);
      if (!raw) continue;
      try {
        items.push(JSON.parse(raw));
      } catch (error) {
        console.error('Invalid KV item:', name, error);
      }
    }

    return items;
  }

  return Array.from(MEMORY_STORE.values());
}

async function deleteMarkedItem(env, key) {
  if (env.REMSG_KV) {
    await env.REMSG_KV.delete(key);
    return;
  }

  MEMORY_STORE.delete(key);
}

async function sendTelegramMessage(env, chatId, text) {
  return telegramApi(env, 'sendMessage', {
    chat_id: chatId,
    text
  });
}

async function telegramApi(env, method, payload) {
  if (!env.BOT_TOKEN) {
    throw new Error('Missing BOT_TOKEN');
  }

  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  return data;
}

async function safeReadJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8'
    }
  });
}
