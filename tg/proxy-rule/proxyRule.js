// =================================================================
// Proxy Rule Telegram Bot for Cloudflare Workers
// =================================================================

const KV_KEYS = {
  PROXY: 'proxy_rules',
  DIRECT: 'direct_rules',
};

const DEFAULT_SUPPORTED_TYPES = ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD'];
const BATCH_COMMANDS = new Set(['set', 'move', 'delete']);
const LIST_COMMANDS = {
  proxylist: { key: KV_KEYS.PROXY, title: 'PROXY 代理列表' },
  directlist: { key: KV_KEYS.DIRECT, title: 'DIRECT 直连列表' },
};

function escapeMarkdown(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/([_{}\[\]()#+\-|=.!])/g, '\\$1');
}

function normalizeInputLine(line) {
  return typeof line === 'string' ? line.trim() : '';
}

function normalizeRuleType(type) {
  return normalizeInputLine(type).toUpperCase();
}

function normalizeListName(listName) {
  return normalizeInputLine(listName).toUpperCase();
}

function normalizeDomain(domain) {
  return normalizeInputLine(domain);
}

function getSupportedTypes(env) {
  const types = Array.isArray(env?.SUPPORTED_TYPES) ? env.SUPPORTED_TYPES : DEFAULT_SUPPORTED_TYPES;
  return [...new Set(types.map(normalizeRuleType).filter(Boolean))];
}

function parseAuthorizedUsers(env) {
  return new Set(
    String(env?.AUTHORIZED_USERS || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function getKvKey(listName) {
  return KV_KEYS[normalizeListName(listName)] || null;
}

function getListDisplayNameByKey(listKey) {
  if (listKey === KV_KEYS.PROXY) return 'PROXY';
  if (listKey === KV_KEYS.DIRECT) return 'DIRECT';
  return listKey;
}

function parseRuleLine(ruleLine) {
  const normalized = normalizeInputLine(ruleLine);
  if (!normalized) return null;

  const firstCommaIndex = normalized.indexOf(',');
  if (firstCommaIndex === -1) return null;

  const type = normalizeRuleType(normalized.slice(0, firstCommaIndex));
  const domain = normalizeDomain(normalized.slice(firstCommaIndex + 1));
  if (!type || !domain) return null;

  return {
    raw: `${type},${domain}`,
    type,
    domain,
  };
}

function stringifyRules(ruleMap) {
  return Array.from(ruleMap.values()).join('\n');
}

function parseRulesText(rulesText) {
  const ruleMap = new Map();
  const invalidLines = [];

  for (const line of String(rulesText || '').split('\n')) {
    const parsed = parseRuleLine(line);
    if (!parsed) {
      if (normalizeInputLine(line)) invalidLines.push(normalizeInputLine(line));
      continue;
    }
    ruleMap.set(parsed.domain, parsed.raw);
  }

  return { ruleMap, invalidLines };
}

async function sendTelegramRequest(method, payload, env) {
  const token = env?.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN 未配置');
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telegram API 请求失败: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Telegram API 返回异常: ${JSON.stringify(result)}`);
  }

  return result.result;
}

async function sendMessage(chatId, text, env, parseMode = '') {
  const payload = { chat_id: chatId, text };
  if (parseMode) payload.parse_mode = parseMode;
  return sendTelegramRequest('sendMessage', payload, env);
}

async function editMessage(chatId, messageId, text, env, parseMode = 'MarkdownV2') {
  return sendTelegramRequest(
    'editMessageText',
    {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: parseMode,
    },
    env,
  );
}

async function getRuleLists(env) {
  const [proxyRulesText, directRulesText] = await Promise.all([
    env.RULE_STORE.get(KV_KEYS.PROXY, 'text'),
    env.RULE_STORE.get(KV_KEYS.DIRECT, 'text'),
  ]);

  const proxyParsed = parseRulesText(proxyRulesText || '');
  const directParsed = parseRulesText(directRulesText || '');

  return {
    proxyRules: proxyParsed.ruleMap,
    directRules: directParsed.ruleMap,
    invalidRules: [
      ...proxyParsed.invalidLines.map((line) => `${KV_KEYS.PROXY}: ${line}`),
      ...directParsed.invalidLines.map((line) => `${KV_KEYS.DIRECT}: ${line}`),
    ],
  };
}

function buildReport(title, successes, failures, successFormatter = (item) => item) {
  let report = `*${escapeMarkdown(title)}*\n\n`;

  if (successes.length > 0) {
    const successHeader = `✅ 成功 (${successes.length}条):`;
    report += `*${escapeMarkdown(successHeader)}*\n`;
    report += `\`\`\`\n${successes.map((item) => successFormatter(item)).join('\n')}\n\`\`\`\n`;
  }

  if (failures.length > 0) {
    const failureHeader = `❌ 失败 (${failures.length}条):`;
    report += `*${escapeMarkdown(failureHeader)}*\n`;
    report += `\`\`\`\n${failures.join('\n')}\n\`\`\``;
  }

  if (successes.length === 0 && failures.length === 0) {
    report += escapeMarkdown('没有提供有效数据。');
  }

  return report;
}

function buildInvalidRuleWarnings(invalidRules) {
  if (!invalidRules.length) return [];
  return invalidRules.map((line) => `检测到存量异常规则，已在本次保存时自动忽略: ${line}`);
}

function removeDomainFromAllLists(domain, lists) {
  lists.proxyRules.delete(domain);
  lists.directRules.delete(domain);
}

function addRuleToList(listKey, ruleLine, lists) {
  if (listKey === KV_KEYS.PROXY) {
    lists.proxyRules.set(parseRuleLine(ruleLine).domain, ruleLine);
    return;
  }
  lists.directRules.set(parseRuleLine(ruleLine).domain, ruleLine);
}

function processSetCommand(lines, env, lists) {
  const successes = [];
  const failures = buildInvalidRuleWarnings(lists.invalidRules);
  const supportedTypes = getSupportedTypes(env);

  for (const rawLine of lines) {
    const line = normalizeInputLine(rawLine);
    if (!line) continue;

    const parts = line.split(',').map((item) => item.trim());
    if (parts.length !== 3) {
      failures.push(`格式错误: ${line}`);
      continue;
    }

    const [typeInput, domainInput, listNameInput] = parts;
    const type = normalizeRuleType(typeInput);
    const domain = normalizeDomain(domainInput);
    const listKey = getKvKey(listNameInput);

    if (!type || !domain || !listNameInput) {
      failures.push(`内容不全: ${line}`);
      continue;
    }

    if (!supportedTypes.includes(type)) {
      failures.push(`类型不支持: ${line}`);
      continue;
    }

    if (!listKey) {
      failures.push(`列表名称错误: ${line}`);
      continue;
    }

    removeDomainFromAllLists(domain, lists);
    addRuleToList(listKey, `${type},${domain}`, lists);
    successes.push(`${type},${domain},${getListDisplayNameByKey(listKey)}`);
  }

  return {
    report: buildReport('设置/修改操作完成！', successes, failures),
    proxyData: stringifyRules(lists.proxyRules),
    directData: stringifyRules(lists.directRules),
  };
}

function processMoveCommand(lines, lists) {
  const successes = [];
  const failures = buildInvalidRuleWarnings(lists.invalidRules);

  for (const rawLine of lines) {
    const line = normalizeInputLine(rawLine);
    if (!line) continue;

    const parts = line.split(',').map((item) => item.trim());
    if (parts.length !== 2) {
      failures.push(`格式错误: ${line}`);
      continue;
    }

    const [domainInput, listNameInput] = parts;
    const domain = normalizeDomain(domainInput);
    const listKey = getKvKey(listNameInput);

    if (!domain || !listNameInput) {
      failures.push(`内容不全: ${line}`);
      continue;
    }

    if (!listKey) {
      failures.push(`列表名称错误: ${line}`);
      continue;
    }

    const sourceRule = lists.proxyRules.get(domain) || lists.directRules.get(domain);
    if (!sourceRule) {
      failures.push(`未找到: ${domain}`);
      continue;
    }

    removeDomainFromAllLists(domain, lists);
    addRuleToList(listKey, sourceRule, lists);
    successes.push({ originalRule: sourceRule, targetList: getListDisplayNameByKey(listKey) });
  }

  return {
    report: buildReport('移动操作完成！', successes, failures, (item) => `${item.originalRule} -> ${item.targetList}`),
    proxyData: stringifyRules(lists.proxyRules),
    directData: stringifyRules(lists.directRules),
  };
}

function processDeleteCommand(lines, lists) {
  const successes = [];
  const failures = buildInvalidRuleWarnings(lists.invalidRules);

  for (const rawLine of lines) {
    const domain = normalizeDomain(rawLine);
    if (!domain) continue;

    const existedInProxy = lists.proxyRules.delete(domain);
    const existedInDirect = lists.directRules.delete(domain);

    if (existedInProxy || existedInDirect) {
      successes.push(domain);
    } else {
      failures.push(`未找到: ${domain}`);
    }
  }

  return {
    report: buildReport('删除操作完成！', successes, failures),
    proxyData: stringifyRules(lists.proxyRules),
    directData: stringifyRules(lists.directRules),
  };
}

async function processRules(command, lines, env) {
  const lists = await getRuleLists(env);

  switch (command) {
    case 'set':
      return processSetCommand(lines, env, lists);
    case 'move':
      return processMoveCommand(lines, lists);
    case 'delete':
      return processDeleteCommand(lines, lists);
    default:
      return {
        report: buildReport('操作未执行', [], [`不支持的命令: ${command}`]),
        proxyData: stringifyRules(lists.proxyRules),
        directData: stringifyRules(lists.directRules),
      };
  }
}

async function showList(chatId, env, listKey, title) {
  const rules = (await env.RULE_STORE.get(listKey, 'text')) || `# ${title}为空。`;
  await sendMessage(chatId, `*${escapeMarkdown(title)}*\n\`\`\`\n${rules}\n\`\`\``, env, 'MarkdownV2');
}

function buildStartMessage(env) {
  const typesText = getSupportedTypes(env).map((type) => `\`${type}\``).join(', ');
  return `欢迎使用规则列表管理机器人\\!\n\n*命令功能说明*:\n\n*1️⃣ 查看列表*\n\`/proxyList\` \\- 显示 PROXY 列表\n\`/directList\` \\- 显示 DIRECT 列表\n\n*2️⃣ 批量设置或修改*\n命令: \`/set\`\n此命令用于添加新规则，或修改已有规则的类型/所属列表。如果域名已存在，旧规则会被完全覆盖。\n*格式*: \`<类型>,<域名>,<PROXY|DIRECT>\`\n*支持的类型*: ${typesText}\n\n*3️⃣ 批量移动*\n命令: \`/move\`\n此命令仅用于快速地将域名在 PROXY 和 DIRECT 列表之间移动。\n*格式*: \`<域名>,<PROXY|DIRECT>\`\n\n*4️⃣ 批量删除*\n命令: \`/delete\`\n只需提供域名，机器人会自动在两个列表中查找并删除。\n*格式*: 在下一行开始，每行一个域名`;
}

async function handleTelegramCommand(command, chatId, env) {
  if (command === 'start') {
    await sendMessage(chatId, buildStartMessage(env), env, 'MarkdownV2');
    return;
  }

  const listCommand = LIST_COMMANDS[command];
  if (listCommand) {
    await showList(chatId, env, listCommand.key, listCommand.title);
    return;
  }

  await sendMessage(chatId, '未知命令。发送 /start 查看帮助。', env);
}

async function handleBatchCommand(command, dataLines, chatId, env, waitUntil) {
  let processingMessageId = null;

  try {
    const initialMessage = await sendMessage(chatId, '⌛️ 正在处理您的请求，请稍候...', env);
    processingMessageId = initialMessage.message_id;

    const { report, proxyData, directData } = await processRules(command, dataLines, env);
    const kvWritePromise = Promise.all([
      env.RULE_STORE.put(KV_KEYS.PROXY, proxyData),
      env.RULE_STORE.put(KV_KEYS.DIRECT, directData),
    ]);

    if (typeof waitUntil === 'function') {
      waitUntil(kvWritePromise);
    } else {
      await kvWritePromise;
    }

    if (report) {
      await editMessage(chatId, processingMessageId, report, env);
    }
  } catch (error) {
    console.error('Error during batch processing:', error?.stack || error);
    if (processingMessageId) {
      const errorMessage = '❌ *处理失败\\!* \n\n机器人后台发生意外错误，请检查 Cloudflare Worker 日志获取详情。';
      await editMessage(chatId, processingMessageId, errorMessage, env);
    }
  }
}

async function handleTelegramUpdate(update, env, waitUntil) {
  if (!update?.message?.text) return;

  const message = update.message;
  const chatId = message.chat.id;
  const text = normalizeInputLine(message.text);
  if (!text) return;

  const authorizedUsers = parseAuthorizedUsers(env);
  if (!authorizedUsers.has(String(chatId))) {
    await sendMessage(chatId, '您没有权限使用此机器人。', env);
    return;
  }

  const lines = text.split('\n').map(normalizeInputLine).filter(Boolean);
  if (!lines.length) return;

  const commandMatch = lines[0].match(/^\/(\w+)/);
  if (!commandMatch) return;

  const command = commandMatch[1].toLowerCase();
  const dataLines = lines.slice(1);

  if (BATCH_COMMANDS.has(command) && dataLines.length > 0) {
    await handleBatchCommand(command, dataLines, chatId, env, waitUntil);
    return;
  }

  await handleTelegramCommand(command, chatId, env);
}

async function handleListRequest(env, listKey) {
  const rules = await env.RULE_STORE.get(listKey, 'text');
  if (rules === null || rules.trim() === '') {
    return new Response(`# ${listKey === KV_KEYS.PROXY ? 'Proxy' : 'Direct'} 列表为空。`, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  return new Response(rules, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/proxyList.list') {
      return handleListRequest(env, KV_KEYS.PROXY);
    }

    if (url.pathname === '/directList.list') {
      return handleListRequest(env, KV_KEYS.DIRECT);
    }

    if (url.pathname === `/bot${env.TELEGRAM_BOT_TOKEN}`) {
      const update = await request.json();
      ctx.waitUntil(handleTelegramUpdate(update, env, ctx.waitUntil.bind(ctx)));
      return new Response('OK');
    }

    return new Response('Not found', { status: 404 });
  },
};