// =================================================================
// 1. 辅助函数定义 (All Helper Functions First)
// =================================================================

function escapeMarkdown(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/([_{}\[\]()#+\-|=.!])/g, '\\$1');
}

function getSupportedTypes(env) {
    return Array.isArray(env.SUPPORTED_TYPES) ? env.SUPPORTED_TYPES : ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD'];
}

async function sendMessage(chatId, text, env, parseMode = '') {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: chatId, text: text };
  if (parseMode) payload.parse_mode = parseMode;
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

async function editMessage(chatId, messageId, text, env, parseMode = 'MarkdownV2') {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageText`;
    const payload = { chat_id: chatId, message_id: messageId, text: text, parse_mode: parseMode };
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

async function showList(chatId, env, listKey, title) {
  const rules = await env.RULE_STORE.get(listKey, 'text') || `# ${title}为空。`;
  await sendMessage(chatId, `*${escapeMarkdown(title)}*\n\`\`\`\n${rules}\n\`\`\``, env, 'MarkdownV2');
}

function getKvKey(listName) {
    const list = listName.toUpperCase();
    if (list === 'PROXY') return 'proxy_rules';
    if (list === 'DIRECT') return 'direct_rules';
    return null;
}

function buildReport(title, successes, failures, successFormatter = (line) => line) {
    let report = `*${escapeMarkdown(title)}*\n\n`;
    if (successes.length > 0) {
        const successHeader = `✅ 成功 (${successes.length}条):`;
        report += `*${escapeMarkdown(successHeader)}*\n`;
        const successText = successes.map(s => successFormatter(s)).join('\n');
        report += `\`\`\`\n${successText}\n\`\`\`\n`;
    }
    if (failures.length > 0) {
        const failureHeader = `❌ 失败 (${failures.length}条):`;
        report += `*${escapeMarkdown(failureHeader)}*\n`;
        const failureText = failures.join('\n');
        report += `\`\`\`\n${failureText}\n\`\`\``;
    }
    if (successes.length === 0 && failures.length === 0) {
        report += escapeMarkdown("没有提供有效数据。");
    }
    return report;
}

/**
 * 【重构核心】这是一个纯粹的计算函数，它只返回计算结果，不执行IO操作
 * @returns {{ report: string, proxyData: string, directData: string }}
 */
async function processRules(command, lines, env) {
    let successes = [];
    let failures = [];
    
    // 1. 批量读取
    const proxyRulesText = await env.RULE_STORE.get('proxy_rules', 'text') || '';
    const directRulesText = await env.RULE_STORE.get('direct_rules', 'text') || '';
    let proxyRules = proxyRulesText.split('\n').filter(Boolean);
    let directRules = directRulesText.split('\n').filter(Boolean);

    // 2. 在内存中处理
    for (const line of lines) {
        if (command === 'set') {
            const parts = line.split(',').map(s => s.trim());
            if (parts.length !== 3) { failures.push(`格式错误: ${line}`); continue; }
            const [type, domain, listName] = parts;
            if (!type || !domain || !listName) { failures.push(`内容不全: ${line}`); continue; }
            const supportedTypes = getSupportedTypes(env);
            if (!supportedTypes.includes(type.toUpperCase())) { failures.push(`类型不支持: ${line}`); continue; }
            const targetKey = getKvKey(listName);
            if (!targetKey) { failures.push(`列表名称错误: ${line}`); continue; }
            proxyRules = proxyRules.filter(r => !r.endsWith(`,${domain}`));
            directRules = directRules.filter(r => !r.endsWith(`,${domain}`));
            const newRule = `${type.toUpperCase()},${domain}`;
            if (targetKey === 'proxy_rules') proxyRules.push(newRule);
            else directRules.push(newRule);
            successes.push(line);
        } else if (command === 'move') {
            const parts = line.split(',').map(s => s.trim());
            if (parts.length !== 2) { failures.push(`格式错误: ${line}`); continue; }
            const [domain, listName] = parts;
            if (!domain || !listName) { failures.push(`内容不全: ${line}`); continue; }
            const targetKey = getKvKey(listName);
            if (!targetKey) { failures.push(`列表名称错误: ${line}`); continue; }
            let foundRule = proxyRules.find(r => r.endsWith(`,${domain}`)) || directRules.find(r => r.endsWith(`,${domain}`));
            if (foundRule) {
                proxyRules = proxyRules.filter(r => !r.endsWith(`,${domain}`));
                directRules = directRules.filter(r => !r.endsWith(`,${domain}`));
                if (targetKey === 'proxy_rules') proxyRules.push(foundRule);
                else directRules.push(foundRule);
                successes.push({ originalRule: foundRule, targetList: listName.toUpperCase() });
            } else {
                failures.push(`未找到: ${domain}`);
            }
        } else if (command === 'delete') {
            const domain = line;
            let ruleFound = false;
            const initialProxyLength = proxyRules.length;
            proxyRules = proxyRules.filter(r => !r.endsWith(`,${domain}`));
            if (proxyRules.length < initialProxyLength) ruleFound = true;
            const initialDirectLength = directRules.length;
            directRules = directRules.filter(r => !r.endsWith(`,${domain}`));
            if (directRules.length < initialDirectLength) ruleFound = true;
            if (ruleFound) successes.push(domain);
            else failures.push(`未找到: ${domain}`);
        }
    }

    // 3. 准备报告和最终数据
    let report = '';
    switch (command) {
        case 'set': report = buildReport('设置/修改操作完成！', successes, failures); break;
        case 'move': report = buildReport('移动操作完成！', successes, failures, (s) => `${s.originalRule} -> ${s.targetList}`); break;
        case 'delete': report = buildReport('删除操作完成！', successes, failures); break;
    }
    
    return {
        report,
        proxyData: proxyRules.join('\n'),
        directData: directRules.join('\n'),
    };
}


async function handleTelegramUpdate(update, env) {
  if (!update.message || !update.message.text) return;

  const message = update.message;
  const chatId = message.chat.id;
  const text = message.text.trim();

  const authorizedUsers = env.AUTHORIZED_USERS.split(',');
  if (!authorizedUsers.includes(chatId.toString())) {
    await sendMessage(chatId, '您没有权限使用此机器人。', env);
    return;
  }

  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return;

  const firstLine = lines[0];
  const commandMatch = firstLine.match(/^\/(\w+)/);
  if (!commandMatch) return;
  
  const command = commandMatch[1].toLowerCase();
  const dataLines = lines.slice(1);

  const isBatchCommand = ['set', 'move', 'delete'].includes(command) && dataLines.length > 0;

  if (!isBatchCommand) {
    // 处理简单命令...
    switch (command) {
      case 'start':
        const supportedTypes = getSupportedTypes(env);
        const typesText = supportedTypes.map(t => `\`${t}\``).join(', ');
        const startMessage = `欢迎使用规则列表管理机器人\\!\n\n*命令功能说明*:\n\n*1️⃣ 查看列表*\n\`/proxyList\` \\- 显示 PROXY 列表\n\`/directList\` \\- 显示 DIRECT 列表\n\n*2️⃣ 批量设置或修改*\n命令: \`/set\`\n此命令用于添加新规则，或修改已有规则的类型/所属列表。如果域名已存在，旧规则会被完全覆盖。\n*格式*: \`<类型>,<域名>,<PROXY|DIRECT>\`\n*支持的类型*: ${typesText}\n\n*3️⃣ 批量移动*\n命令: \`/move\`\n此命令仅用于快速地将域名在 PROXY 和 DIRECT 列表之间移动。\n*格式*: \`<域名>,<PROXY|DIRECT>\`\n\n*4️⃣ 批量删除*\n命令: \`/delete\`\n只需提供域名，机器人会自动在两个列表中查找并删除。\n*格式*: 在下一行开始，每行一个域名`;
        await sendMessage(chatId, startMessage, env, 'MarkdownV2');
        break;
      case 'proxylist':
        await showList(chatId, env, 'proxy_rules', 'PROXY 代理列表');
        break;
      case 'directlist':
        await showList(chatId, env, 'direct_rules', 'DIRECT 直连列表');
        break;
      default:
        await sendMessage(chatId, '未知命令。发送 /start 查看帮助。', env);
    }
    return;
  }

  let processingMessageId = null;
  try {
    const initialResponse = await sendMessage(chatId, '⌛️ 正在处理您的请求，请稍候...', env);
    if (initialResponse && initialResponse.ok) {
        const result = await initialResponse.json();
        processingMessageId = result.result.message_id;
    } else {
        console.error("Failed to send initial message:", await initialResponse.text());
        return;
    }

    // 【核心重构】在这里调用纯计算函数
    const { report, proxyData, directData } = await processRules(command, dataLines, env);
    
    // 【核心重构】将 KV 写入操作放到一个独立的 Promise 中
    const kvWritePromise = Promise.all([
        env.RULE_STORE.put('proxy_rules', proxyData),
        env.RULE_STORE.put('direct_rules', directData)
    ]);

    // 【核心重构】将这个 Promise 交给 waitUntil()，确保它一定能完成
    // 注意：在实际的 fetch handler 中，这个 env 来自 ctx，但在这里我们模拟
    if (env.waitUntil) { // 在 Cloudflare 环境中，env 对象有这个方法
        env.waitUntil(kvWritePromise);
    } else { // 在本地测试或旧环境中，直接 await
        await kvWritePromise;
    }

    // 无论写入是否完成，立即更新报告给用户
    if (report) {
      await editMessage(chatId, processingMessageId, report, env);
    }
  } catch (error) {
    console.error("Error during batch processing:", error.stack);
    if (processingMessageId) {
        const errorMessage = '❌ *处理失败\\!* \n\n机器人后台发生意外错误，请检查 Cloudflare Worker 日志获取详情。';
        await editMessage(chatId, processingMessageId, errorMessage, env);
    }
  }
}

async function handleListRequest(env, listKey) {
  const rules = await env.RULE_STORE.get(listKey, 'text');
  if (rules === null || rules.trim() === '') {
    return new Response(`# ${listKey === 'proxy_rules' ? 'Proxy' : 'Direct'} 列表为空。`, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(rules, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

// =================================================================
// 2. 主导出对象 (Main Exported Object)
// =================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/proxyList.list') {
      return handleListRequest(env, 'proxy_rules');
    }
    if (url.pathname === '/directList.list') {
      return handleListRequest(env, 'direct_rules');
    }

    if (url.pathname === `/bot${env.TELEGRAM_BOT_TOKEN}`) {
      const update = await request.json();
      // 【核心重构】在这里传递 ctx 给 handleTelegramUpdate
      // 我们将 waitUntil 方法附加到 env 对象上传递下去
      env.waitUntil = ctx.waitUntil.bind(ctx);
      ctx.waitUntil(handleTelegramUpdate(update, env));
      return new Response('OK');
    }

    return new Response('Not found', { status: 404 });
  },
};