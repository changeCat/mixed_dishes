// worker.js

// 绑定KV命名空间的类型声明，实际部署时不需要此行，但有助于IDE提示
// declare const HOLIDAYS_KV: KVNamespace;
/**
 * 1、增加一个KV：HOLIDAYS_KV 并绑定
 * 2、设置变量：USERNAME、PASSWORD
 */

// 统一设置 Favicon URL
const FAVICON_URL = "https://cloudflare-imgbed-524.pages.dev/file/img/1752736456549_c04ab0bb5453f2c8b8d27.png";

/**
 * 辅助函数（Worker 内部使用）：转义HTML特殊字符，防止XSS攻击。
 * 用于将可能包含特殊字符的字符串安全地插入到HTML属性（如title）中。
 * @param {string} text - 待转义的字符串。
 * @returns {string} 转义后的字符串。
 */
function workerEscapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, function(m) { return map[m]; });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // 路由处理
        if (url.pathname === '/') {
            return handleAdminPage(request, env);
        } else if (url.pathname === '/login') {
            return handleLogin(request, env);
        } else if (url.pathname === '/logout') {
            return handleLogout(request, env);
        } else if (url.pathname === '/save' && request.method === 'POST') {
            // 保护 /save 路由，只有登录用户才能访问
            if (!await isLoggedIn(request, env)) {
                return new Response('Unauthorized', { status: 401 });
            }
            return handleSaveHoliday(request, env);
        } else if (url.pathname === '/delete' && request.method === 'POST') {
            // 保护 /delete 路由，只有登录用户才能访问
            if (!await isLoggedIn(request, env)) {
                return new Response('Unauthorized', { status: 401 });
            }
            return handleDeleteHoliday(request, env);
        } else if (url.pathname === '/save_edited_json' && request.method === 'POST') {
            // 保护新增加的直接编辑 JSON 数据的保存路由
            if (!await isLoggedIn(request, env)) {
                return new Response('Unauthorized', { status: 401 });
            }
            return handleSaveEditedJson(request, env);
        } else if (url.pathname === '/settings') { // 新增设置页面路由
            // 保护 /settings 路由，只有登录用户才能访问
            if (!await isLoggedIn(request, env)) {
                return new Response(null, { status: 302, headers: { 'Location': '/login' } }); // 重定向到登录页
            }
            return handleSettings(request, env);
        }
        // 以下是开放接口
        else if (url.pathname === '/open/dateInfo') {
            return handleDateInfo(request, env);
        } else if (url.pathname === '/open/yearInfo') { // 新增接口
            return handleYearInfo(request, env);
        } else if (url.pathname === '/open/monthInfo') { // 新增接口
            return handleMonthInfo(request, env);
        }


        // 处理所有未匹配的请求，重定向到管理页面或返回404
        return new Response('Not Found', { status: 404 });
    },
};

/**
 * 辅助函数：解析日期字符串为标准 'YYYY-MM-DD' 格式。
 * 当 dateStr 只有日期（如 '6日'）时，需要 currentYear 和 defaultMonth 来确定完整日期。
 * @param {string} dateStr - 待解析的日期字符串，如 '1月1日' 或 '6日'。
 * @param {string} currentYear - 当前年份，例如 '2025'。
 * @param {number|null} defaultMonth - 当 dateStr 只有日期时，使用的默认月份（1-12）。
 * @returns {string|null} 格式化的日期字符串或 null（如果解析失败）。
*/
function parseDate(dateStr, currentYear, defaultMonth = null) {
    let year = parseInt(currentYear);
    let month;
    let day;

    // 尝试匹配 'X月Y日' 格式
    const monthDayMatch = dateStr.match(/(\d+)月(\d+)日/);
    if (monthDayMatch) {
        month = parseInt(monthDayMatch[1]);
        day = parseInt(monthDayMatch[2]);
    } else {
        // 如果只匹配到 'Y日' 格式，则需要依赖 defaultMonth
        const dayMatch = dateStr.match(/(\d+)日/);
        if (dayMatch && defaultMonth !== null) {
            month = defaultMonth;
            day = parseInt(dayMatch[1]);
        } else {
            return null; // 无法解析
        }
    }

    // 格式化月份和日期为两位数，如 '01', '02'
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}


/**
 * 节假日信息解析器
 * @param {string} year 年份 (例如 '2025')
 * @param {string} text 节假日文本 (例如国办通知的正文部分)
 * @returns {Array<Object>} 解析后的JSON数据，格式为[{name, startDate, endDate, daysOff, workAdjustmentDates}]
*/
function parseHolidayText(year, text) {
    const lines = text.split('\n').filter(line => line.trim() !== '');
    const holidays = [];

    for (const line of lines) {
        // 匹配节假日行的整体结构：序号、节日名称、冒号、详细描述
        const entryMatch = line.match(/^(?:[一二三四五六七](?:．|、))(.+?)[:：](.+)/);

        if (!entryMatch) {
            continue; // 跳过不符合节假日格式的行
        }

        const holiday = {};
        holiday.name = entryMatch[1].trim();
        const detailsPart = entryMatch[2].trim();

        // 1. 解析放假天数 (daysOff)
        const daysOffMatch = detailsPart.match(/共(\d+)天/);
        if (daysOffMatch) {
            holiday.daysOff = parseInt(daysOffMatch[1]);
        } else if (detailsPart.includes("放假1天")) {
            holiday.daysOff = 1;
        } else {
            holiday.daysOff = null;
        }

        // 2. 解析放假日期范围 (startDate, endDate)
        // 优化后的正则表达式：
        // (?:[（(][^）)]*[）)]?\s*)? 允许在日期前有括号内容及空格 (非捕获组)
        // (\d+月\d+日) 捕获起始日期，如 "1月1日"
        // (?:至(?:[（(][^）)]*[）)]?\s*)?(\d+月\d+日|(?:\d+)日))? 捕获结束日期部分，非捕获组，包含 "至"
        //   (?:[（(][^）)]*[）)]?\s*)? 允许在 "至" 和结束日期之间有括号内容及空格 (非捕获组)
        //   (\d+月\d+日|(?:\d+)日) 捕获结束日期，可以是 "2月4日" 或 "6日" (捕获组3)
        // 整体考虑了日期后面的括号内容可能带来的干扰
        const dateRangePattern = /(\d+月\d+日)(?:[（(][^）)]*[）)]?\s*)?(?:至(?:[（(][^）)]*[）)]?\s*)?(\d+月\d+日|\d+日))?/g;
        const rangeMatch = [...detailsPart.matchAll(dateRangePattern)];

        if (rangeMatch.length > 0) {
            const firstMatch = rangeMatch[0]; // 只取第一个匹配的日期范围
            const rawStartDate = firstMatch[1];
            holiday.startDate = parseDate(rawStartDate, year);

            // 提取月份，用于解析只有“X日”的结束日期
            const startMonthMatch = rawStartDate.match(/(\d+)月/);
            const defaultMonthForEndDate = startMonthMatch ? parseInt(startMonthMatch[1]) : null;

            if (firstMatch[2]) { // 如果存在结束日期部分的捕获组
                const rawEndDate = firstMatch[2];
                holiday.endDate = parseDate(rawEndDate, year, defaultMonthForEndDate);
            } else {
                // 如果没有 "至" 部分，则是单日放假，endDate与startDate相同
                holiday.endDate = holiday.startDate;
            }
        } else {
            // 尝试匹配像 "除夕（2月9日）" 这种形式的日期，或者 "1月1日（周三）" 单日情况
            const singleDateWithParenthesesMatch = detailsPart.match(/(\d+月\d+日)(?:[（(][^）)]*[）)])?/);
            if (singleDateWithParenthesesMatch) {
                holiday.startDate = parseDate(singleDateWithParenthesesMatch[1], year);
                holiday.endDate = holiday.startDate;
            } else {
                // 兜底，如果没有匹配到日期，就设置为null
                holiday.startDate = null;
                holiday.endDate = null;
            }
        }

        // 如果 daysOff 为 null，且 startDate 和 endDate 都已解析，则尝试计算
        if (holiday.daysOff === null && holiday.startDate && holiday.endDate) {
            const start = new Date(holiday.startDate);
            const end = new Date(holiday.endDate);
            if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
                const diffTime = Math.abs(end.getTime() - start.getTime());
                holiday.daysOff = Math.round(diffTime / (1000 * 60 * 60 * 24)) + 1;
            }
        }


        // 3. 解析调休上班日期 (workAdjustmentDates)
        holiday.workAdjustmentDates = [];
        const workAdjustmentPattern = String.raw`(\d+月\d+日)(?:[（(][^）)]*[）)])?`; // 匹配带括号或不带括号的日期

        // 匹配“X月Y日、Z月W日上班”或“X月Y日上班”
        const workAdjustmentPhrases = [...detailsPart.matchAll(
            new RegExp(`(${workAdjustmentPattern}(?:、\\s*${workAdjustmentPattern})*)\\s*上班`, 'g')
        )];

        for (const phraseMatch of workAdjustmentPhrases) {
            // 在捕获到的上班日期短语中，再次匹配所有日期
            const rawWorkDatesInPhrase = [...phraseMatch[1].matchAll(/(\d+月\d+日)/g)];
            for (const dateMatch of rawWorkDatesInPhrase) {
                const rawWorkDateStr = dateMatch[1];
                const parsedWorkDate = parseDate(rawWorkDateStr, year);
                if (parsedWorkDate && !holiday.workAdjustmentDates.includes(parsedWorkDate)) {
                    holiday.workAdjustmentDates.push(parsedWorkDate);
                }
            }
        }

        holidays.push(holiday);
    }
    return holidays;
}

/**
 * 检查用户是否已登录。
 * @param {Request} request
 * @param {Env} env
 * @returns {boolean}
*/
async function isLoggedIn(request, env) {
    const cookieHeader = request.headers.get('Cookie');
    if (!cookieHeader) {
        return false;
    }
    const cookies = cookieHeader.split(';').map(c => c.trim());
    const loggedInCookie = cookies.find(c => c.startsWith('logged_in='));
    return loggedInCookie === 'logged_in=true';
}

/**
 * 生成客户端 JavaScript 脚本内容的函数。
 * 返回一个字符串，该字符串会被插入到 <script> 标签中。
 * 注意：此函数内部的代码将被视为纯字符串，需要手动处理所有特殊字符转义。
 * @param {Array<Object>} initialHolidayData - 用于初始化的节假日数据。
 * @param {boolean} isUserLoggedIn - 用户是否已登录。
 * @returns {string} 客户端 JavaScript 代码字符串
*/
function generateClientScriptContent(initialHolidayData, isUserLoggedIn) {
    // 对初始数据进行 JSON.stringify，并替换可能破坏 <script> 标签的字符，例如 "</script>"
    const safeInitialHolidayData = JSON.stringify(initialHolidayData).replace(/<\/script>/g, '<\\u002fscript>');

    return `
        (function() {
            // 确保 \\\`escapeHtml\\\` 在客户端可用
            function escapeHtml(text) {
                const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
                return text.replace(/[&<>"']/g, function(m) { return map[m]; });
            }
  
            // 注入 allHolidayData，确保前端JS能访问到
            let allHolidayData = ${safeInitialHolidayData};
            const isUserLoggedIn = ${isUserLoggedIn}; // 注入登录状态
  
            const addHolidayModal = document.getElementById('addHolidayModal');
            const showAddModalBtn = document.getElementById('showAddModalBtn');
            const closeAddModalBtn = document.getElementById('closeAddModal');
            const modalHolidayForm = document.getElementById('modalHolidayForm');
            const modalFormMessage = document.getElementById('modalFormMessage');
            const holidayTableBody = document.getElementById('holidayTableBody');
  
            const viewDetailsModal = document.getElementById('viewDetailsModal');
            const closeDetailsModalBtn = document.getElementById('closeDetailsModal');
            const detailJsonContentTextarea = document.getElementById('detailJsonContentTextarea'); // 获取 textarea
            const detailHolidayYear = document.getElementById('detailHolidayYear');
            const editJsonBtn = document.getElementById('editJsonBtn'); // 获取编辑按钮
            const saveEditedJsonBtn = document.getElementById('saveEditedJsonBtn'); // 获取保存修改按钮
            const editJsonMessage = document.getElementById('editJsonMessage'); // 获取编辑消息显示区域
  
            /** 客户端辅助函数：生成表格行的HTML */
            function generateTableRowHtml(item) {
                const summary = escapeHtml(item.data.substring(0, 100)) + (item.data.length > 100 ? '...' : '');
                // 根据登录状态**是否渲染**删除按钮
                const deleteButtonHtml = isUserLoggedIn
                    ? \`<button class="delete-btn" data-year="\${item.year}">删除</button>\`
                    : \`\`; // 未登录时不渲染删除按钮 (改为不生成HTML)
  
                return \`
                    <tr>
                        <td>\${item.year}</td>
                        <td>
                            <span class="json-summary" title="\${escapeHtml(item.data)}">\${summary}</span>
                        </td>
                        <td>
                            <div class="operation-buttons">
                                <button class="view-details-btn" data-year="\${item.year}">查看详情</button>
                                \${deleteButtonHtml}
                            </div>
                        </td>
                    </tr>
                \`;
            }
  
            /** 客户端辅助函数：重新渲染表格主体 */
            function renderHolidayTable() {
                // 按照年份降序排序数据
                allHolidayData.sort((a, b) => parseInt(b.year) - parseInt(a.year));
                // 生成所有行的HTML，并更新tbody
                holidayTableBody.innerHTML = allHolidayData.map(item => generateTableRowHtml(item)).join('');
            }
  
            // 页面加载时立即渲染表格，因为allHolidayData已经注入，并且generateTableRowHtml会根据isUserLoggedIn工作
            renderHolidayTable(); 
  
            // 根据登录状态控制 "设置节假日" 按钮的显示/隐藏
            if (isUserLoggedIn) {
                showAddModalBtn.style.display = 'inline-block'; // 登录后显示按钮
            } else {
                showAddModalBtn.style.display = 'none'; // 未登录时隐藏按钮
            }
  
            // When the user clicks the "设置节假日" button, open the add modal
            showAddModalBtn.onclick = function() {
                // 仅当按钮可见且逻辑上已登录时才打开模态框
                if (isUserLoggedIn && showAddModalBtn.style.display !== 'none') {
                    addHolidayModal.classList.add('is-active');
                    modalFormMessage.style.display = 'none';
                    document.getElementById('modalYear').value = new Date().getFullYear();
                    document.getElementById('modalHolidayText').value = '';
                } else {
                    alert('请先登录以设置节假日。'); // 理论上按钮已隐藏，此处作为备用
                }
            }
  
            // When the user clicks on 'x' in add modal, close it
            closeAddModalBtn.onclick = function() {
                addHolidayModal.classList.remove('is-active');
            }
  
            // When the user clicks on 'x' in details modal, close it
            closeDetailsModalBtn.onclick = function() {
                viewDetailsModal.classList.remove('is-active');
                detailJsonContentTextarea.value = ''; // 清空内容
                detailJsonContentTextarea.readOnly = true; // 恢复只读状态
                // 确保editJsonBtn 和 saveEditedJsonBtn 根据登录状态和初始设定重新显示/隐藏
                updateDetailModalButtons(); 
                editJsonMessage.style.display = 'none'; // 隐藏消息
            }
  
            // Helper function to manage detail modal buttons visibility
            function updateDetailModalButtons() {
                if (isUserLoggedIn) {
                    editJsonBtn.style.display = 'inline-block';
                    saveEditedJsonBtn.style.display = 'none';
                } else {
                    editJsonBtn.style.display = 'none';
                    saveEditedJsonBtn.style.display = 'none';
                }
            }
  
            // When the user clicks anywhere outside of a modal, close it
            window.onclick = function(event) {
                if (event.target == addHolidayModal) {
                    addHolidayModal.classList.remove('is-active');
                }
                if (event.target == viewDetailsModal) {
                    closeDetailsModalBtn.click(); // 触发关闭详情弹窗的逻辑
                }
            }
  
            modalHolidayForm.addEventListener('submit', async function(e) {
                e.preventDefault();
                // 客户端再次校验登录状态，作为后端校验的补充
                if (!isUserLoggedIn) {
                    modalFormMessage.className = 'message error';
                    modalFormMessage.textContent = '未登录，无法保存。请先登录。';
                    setTimeout(() => window.location.href = '/login', 1500); // 1.5秒后重定向到登录页
                    return;
                }
                
                const year = document.getElementById('modalYear').value;
                const holidayText = document.getElementById('modalHolidayText').value;
                modalFormMessage.style.display = 'none';
  
                try {
                    const response = await fetch('/save', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ year, holidayText })
                    });
                    
                    if (response.status === 401) {
                         modalFormMessage.className = 'message error';
                         modalFormMessage.textContent = '保存失败：未授权，请重新登录。';
                         setTimeout(() => window.location.href = '/login', 1500); // 1.5秒后重定向到登录页
                         return;
                    }
  
                    const result = await response.json();
                    if (result.success) {
                        modalFormMessage.className = 'message success';
                        modalFormMessage.textContent = '节假日信息保存成功！';
                        
                        // 获取后端返回的最新数据
                        const newItem = {
                            year: year,
                            // 确保数据格式与allHolidayData中存储的text一致
                            data: JSON.stringify(result.parsedData, null, 2) 
                        };
  
                        // 更新allHolidayData数组
                        const existingIndex = allHolidayData.findIndex(item => item.year === year);
                        if (existingIndex !== -1) {
                            allHolidayData[existingIndex] = newItem; // 更新现有项
                        } else {
                            allHolidayData.push(newItem); // 添加新项
                        }
  
                        renderHolidayTable(); // 重新渲染表格，此时新的删除按钮状态会根据isUserLoggedIn重新生成
                        addHolidayModal.classList.remove('is-active'); // 关闭弹窗
                        // 成功后清除消息，或短暂显示后清除
                        setTimeout(() => { modalFormMessage.style.display = 'none'; }, 2000); 
  
                    } else {
                        throw new Error(result.message || '保存失败');
                    }
                } catch (error) {
                    modalFormMessage.className = 'message error';
                    modalFormMessage.textContent = '保存失败: ' + error.message;
                    modalFormMessage.style.display = 'block';
                }
            });
  
            document.getElementById('holidayTableBody').addEventListener('click', async function(e) {
                // 处理删除按钮点击
                if (e.target.classList.contains('delete-btn')) {
                    // 客户端再次校验登录状态，作为后端校验的补充
                    if (!isUserLoggedIn) {
                        alert('请先登录以删除此项。');
                        return;
                    }
  
                    const yearToDelete = e.target.dataset.year;
                    if (confirm(\`确定要删除 \${yearToDelete} 年的节假日信息吗？\`)) {
                        try {
                            const response = await fetch('/delete', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ year: yearToDelete })
                            });
  
                            if (response.status === 401) {
                                alert('删除失败：未授权，请重新登录。');
                                window.location.href = '/login'; // 重定向到登录页
                                return;
                            }
  
                            const result = await response.json();
                            if (result.success) {
                                alert(\`\${yearToDelete} 年节假日信息删除成功！\`);
                                // 从allHolidayData中移除被删除的项
                                allHolidayData = allHolidayData.filter(item => item.year !== yearToDelete);
                                renderHolidayTable(); // 重新渲染表格
                            } else {
                                throw new Error(result.message || '删除失败');
                            }
                        } catch (error) {
                            alert('删除失败: ' + error.message);
                        }
                    }
                }
  
                // 处理查看详情按钮点击
                if (e.target.classList.contains('view-details-btn')) {
                    const yearToView = e.target.dataset.year;
                    const dataEntry = allHolidayData.find(item => item.year === yearToView);
  
                    if (dataEntry) {
                        detailHolidayYear.textContent = yearToView;
                        // 将JSON数据加载到textarea
                        try {
                            const parsedJson = JSON.parse(dataEntry.data);
                            detailJsonContentTextarea.value = JSON.stringify(parsedJson, null, 2);
                        } catch (error) {
                            detailJsonContentTextarea.value = "Error parsing JSON data: " + dataEntry.data;
                            console.error("Error parsing JSON for display:", error, dataEntry.data);
                        }
                        
                        detailJsonContentTextarea.readOnly = true; // 默认只读
                        editJsonMessage.style.display = 'none'; // 隐藏消息
  
                        // 根据登录状态显示编辑/保存按钮
                        updateDetailModalButtons(); // 调用辅助函数来更新按钮状态
  
                        viewDetailsModal.classList.add('is-active');
                    } else {
                        alert('未找到该年份的节假日数据。');
                    }
                    deleteButtonHtml 
                }
            });
  
            // 编辑JSON按钮点击事件
            editJsonBtn.onclick = function() {
                if (!isUserLoggedIn) {
                    alert('请先登录以编辑。');
                    return;
                }
                detailJsonContentTextarea.readOnly = false; // 进入编辑模式
                editJsonBtn.style.display = 'none'; // 隐藏编辑按钮
                saveEditedJsonBtn.style.display = 'inline-block'; // 显示保存按钮
                editJsonMessage.className = 'message info'; // 重置消息样式为提示信息
                editJsonMessage.textContent = '您正在编辑当前年份的原始JSON数据。请确保格式正确。';
                editJsonMessage.style.display = 'block';
                 // 自动将焦点设置到textarea使其可以直接开始编辑
                detailJsonContentTextarea.focus(); 
            };
  
            // 保存修改按钮点击事件
            saveEditedJsonBtn.onclick = async function() {
               if (!isUserLoggedIn) {
                   alert('请先登录以保存。');
                   return;
               }
  
               const yearToEdit = detailHolidayYear.textContent;
               const editedJsonString = detailJsonContentTextarea.value;
               editJsonMessage.style.display = 'none';
  
               try {
                   // 客户端初步验证 JSON 格式
                   JSON.parse(editedJsonString); 
  
                   const response = await fetch('/save_edited_json', {
                       method: 'POST',
                       headers: { 'Content-Type': 'application/json' },
                       body: JSON.stringify({ year: yearToEdit, editedJsonString: editedJsonString })
                   });
  
                   if (response.status === 401) {
                       editJsonMessage.className = 'message error';
                       editJsonMessage.textContent = '保存失败：未授权，请重新登录。';
                       setTimeout(() => window.location.href = '/login', 1500);
                       return;
                   }
  
                   const result = await response.json();
                   if (result.success) {
                       editJsonMessage.className = 'message success';
                       editJsonMessage.textContent = 'JSON数据保存成功！';
                       editJsonMessage.style.display = 'block'; // 确保消息可见，但短暂
  
                       // 更新allHolidayData数组中的对应项
                       const updatedItem = {
                           year: yearToEdit,
                           data: editedJsonString // 直接保存新的JSON字符串
                       };
                       const existingIndex = allHolidayData.findIndex(item => item.year === yearToEdit);
                       if (existingIndex !== -1) {
                           allHolidayData[existingIndex] = updatedItem;
                       } else {
                           // 理论上应该不会走到这里，因为是编辑已存在的项
                           allHolidayData.push(updatedItem); 
                       }
                       renderHolidayTable(); // 重新渲染主表格
  
                       // *** 直接关闭弹窗，不显示中间的“编辑JSON”状态 ***
                       // 稍作延迟（例如50毫秒），让用户能看到成功提示，然后立即关闭
                       setTimeout(() => {
                           viewDetailsModal.classList.remove('is-active'); 
                           editJsonMessage.style.display = 'none'; // 关闭后清除消息
                       }, 50); // 微小延迟，提供视觉反馈，同时保持“直接回到”的感受
  
                   } else {
                       throw new Error(result.message || '保存失败');
                   }
               } catch (error) {
                   editJsonMessage.className = 'message error';
                   editJsonMessage.textContent = '保存失败: JSON格式错误或 ' + error.message;
                   editJsonMessage.style.display = 'block';
               }
            };
  
        })(); // IIFE 结束
    `;
}

/**
 * 生成管理页面HTML
*/
async function handleAdminPage(request, env) {
    const userIsLoggedIn = await isLoggedIn(request, env);
    const kvKeys = await env.HOLIDAYS_KV.list();
    const yearsData = [];

    for (const key of kvKeys.keys) {
        if (key.name && key.name.startsWith('holiday_')) {
            const year = key.name.replace('holiday_', '');
            try {
                const data = await env.HOLIDAYS_KV.get(key.name, 'text');
                if (data) {
                    yearsData.push({ year: year, data: data });
                }
            } catch (e) {
                console.error(`Error reading or parsing KV key ${key.name}:`, e);
            }
        }
    }

    yearsData.sort((a, b) => parseInt(b.year) - parseInt(a.year));

    // 获取API调用统计数据 (动态读取所有计数器)
    let allCallCounters = {};
    try {
        const systemSettingString = await env.HOLIDAYS_KV.get('system_setting', 'text');
        if (systemSettingString) {
            const systemSetting = JSON.parse(systemSettingString);
            if (systemSetting.call_counters) {
                allCallCounters = systemSetting.call_counters;
            }
        }
    } catch (e) {
        console.error('Error reading or parsing system_setting for call counters:', e);
    }

    // 动态生成统计条目HTML
    let dynamicStatsEntriesHtml = '';
    // 移除了 apiPaths 映射，直接根据 KV 中的键生成路径
    for (const apiName in allCallCounters) {
        if (Object.prototype.hasOwnProperty.call(allCallCounters, apiName)) {
            const count = allCallCounters[apiName];
            // 动态生成显示路径，统一加 /open/ 前缀
            const displayPath = `/${apiName.startsWith('open/') ? '' : 'open/'}${apiName}`; // 确保路径正确拼接
            dynamicStatsEntriesHtml += `
                <div class="stats-entry">
                    <code class="api-name">${workerEscapeHtml(displayPath)}</code>
                    <span class="api-colon">:</span>
                    <div class="api-count-wrapper">
                        <span class="api-count">${count}</span>
                        <span class="api-unit">次</span>
                    </div>
                </div>
            `;
        }
    }

    let authActionsHtml = '';
    if (userIsLoggedIn) {
        authActionsHtml = `
            <div class="auth-actions">
                <a href="/settings" class="auth-link" id="settingsBtn">设置</a>
                <a href="/logout" class="auth-link">登出</a>
            </div>
        `;
    } else {
        authActionsHtml = `<a href="/login" class="auth-link">登录</a>`;
    }


    const clientScriptContent = generateClientScriptContent(yearsData, userIsLoggedIn);

    const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>节假日管理</title>
    <!-- Favicon 标签 - 保持原样，并增加 shortcut icon 兼容性 -->
    <link rel="icon" type="image/png" href="${FAVICON_URL}">
    <link rel="shortcut icon" href="${FAVICON_URL}">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif; margin: 0; background-color: #f4f7f6; color: #333; 
            display: flex; /* 使用 Flexbox 布局 */
            justify-content: center; /* 主轴居中 */
            align-items: flex-start; /* 交叉轴顶部对齐 */
            min-height: 100vh; /* 最小高度充满视口 */
            padding: 20px; /* 整体页面内边距 */
            box-sizing: border-box; /* 边框和内边距包含在宽度内 */
        }
        /* 主内容区域和侧边栏的容器 */
        .main-wrapper {
            display: flex;
            justify-content: space-between; /* 元素推到两端，增加间隙 */
            gap: 20px; /* 侧边栏和主内容之间的间距 */
            max-width: 1200px; /* 限制整个应用的最大宽度 */
            width: 100%; /* 允许宽度自适应 */
            align-items: flex-start; /* 顶部对齐 */
        }
        /* 侧边栏样式 */
        .stats-sidebar {
            flex-shrink: 0; /* 不缩小 */
            width: 300px; /* 调整宽度，提供更多显示空间 */
            background-color: #fff;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
            position: sticky; /* 粘性定位 */
            top: 20px; /* 距离顶部20px */
        }
        .stats-sidebar h2 {
            color: #0056b3;
            /* border-bottom: 多个条目，使用 .stats-line 代替 */
            padding-bottom: 0; 
            margin-bottom: 10px; 
            font-size: 1.3em;
        }
  
        /* --- API 统计样式 --- */
        .stats-line {
            height: 1px;
            background-color: #e0e0e0;
            margin: 10px 0 10px 0; /* 调整为更小的垂直外边距 */
        }
        .stats-entry {
            display: grid; /* 使用 Grid 布局 */
            /* 定义三列：API名称（最小内容自适应，最大180px），冒号（内容宽度），计数和单位（剩余空间） */
            grid-template-columns: minmax(min-content, 180px) max-content 1fr; 
            align-items: center;
            margin-bottom: 10px;
            font-size: 1em; /* Base font size */
            gap: 5px; /* 列之间的小间距 */
        }
        .api-name {
            background-color: #f0f0f0;
            border-radius: 4px; /* 保持与之前一致的小圆角 */
            padding: 4px 8px;
            font-size: 0.9em;
            color: #555;
            white-space: nowrap; /* Prevent breaking the path */
            overflow: hidden; /* Hide overflow if name gets too long for max-width */
            text-overflow: ellipsis; /* Show ellipsis for long names */
        }
        .api-colon {
            color: #555;
            text-align: right; /* 将冒号右对齐在它的单元格内 */
            padding-right: 5px; /* 冒号右侧空间 */
        }
        /* 新增：包裹计数和单位的容器，用于控制它们在同一行并右对齐 */
        .api-count-wrapper {
            display: flex; /* 使用Flexbox让数字和单位在同一行 */
            align-items: center;
            justify-content: flex-end; /* 将内容推到最右边 */
        }
        .api-count {
            color: #007bff; /* Blue color for the count */
            font-weight: bold;
            font-size: 1.2em; /* Slightly larger for emphasis */
        }
        .api-unit {
            color: #555;
            font-size: 1em;
            margin-left: 3px; /* 单位和数字之间的小间距 */
        }
        /* --- END API 统计样式 --- */
  
  
        .container { 
            flex-grow: 1; /* 占据剩余空间 */
            background-color: #fff; 
            padding: 30px; 
            border-radius: 8px; 
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08); 
        }
        h1 { color: #0056b3; border-bottom: 2px solid #e0e0e0; padding-bottom: 10px; margin-bottom: 25px; display: inline-block; } 
        
        /* 页面头部布局 */
        .page-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 2px solid #e0e0e0;
            padding-bottom: 10px;
            margin-bottom: 25px;
        }
        .page-header h1 {
            margin: 0;
            border-bottom: none; /* 移除 h1 自身的底线，由父容器 page-header 提供 */
        }
        /* 登录/登出/设置 按钮的容器 */
        .page-header .auth-actions {
            display: flex;
            align-items: center;
            gap: 5px; /* *** 调整以进一步减少间隙 *** */
        }
        .auth-link {
            font-size: 1.1em;
            color: #007bff;
            text-decoration: none;
            padding: 5px 10px;
            border-radius: 8px; /* 保持适中圆角 */
            transition: background-color 0.2s;
        }
        .auth-link:hover {
            background-color: #e9ecef;
            color: #0056b3;
        }
  
        /* 布局调整：已保存节假日数据标题和按钮一行显示 */
        .admin-header-section {
            display: flex;
            justify-content: space-between; /* 元素两端对齐 */
            align-items: center; /* 垂直居中 */
            margin-bottom: 25px;
            border-bottom: 2px solid #e0e0e0; /* 标题下划线 */
            padding-bottom: 10px; /* 标题与下划线间距 */
        }
        .admin-header-section h2 { /* 针对此h2移除默认margin和border */
            color: #0056b3;
            margin: 0;
            padding: 0;
            border: none;
        }
  
        button { 
            background-color: #007bff; 
            color: white; 
            padding: 12px 25px; 
            border: none; 
            border-radius: 8px; /* 所有按钮统一圆角 */
            cursor: pointer; 
            font-size: 16px; 
            transition: background-color 0.2s, transform 0.1s; 
        }
        button:hover { background-color: #0056b3; transform: translateY(-1px); }
        button:disabled {
            background-color: #cccccc;
            cursor: not-allowed;
            transform: none;
        }
        /* 删除按钮的默认 margin-left 移到 operation-buttons 中处理 */
        .delete-btn { background-color: #dc3545; border-radius: 8px; } /* 确保特定按钮也圆角 */
        .delete-btn:hover { background-color: #c82333; }
        .delete-btn:disabled {
            background-color: #cccccc;
            cursor: not-allowed;
            transform: none;
        }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { border: 1px solid #eee; padding: 12px; text-align: left; font-size: 15px; vertical-align: middle;} /* 垂直对齐方式 */
        th:nth-child(1), td:nth-child(1) { width: 10%; min-width: 70px; text-align: center; } /* 年份 */
        th:nth-child(2), td:nth-child(2) { width: 60%; min-width: 250px; } /* 节假日JSON数据 */
        th:nth-child(3), td:nth-child(3) { width: 30%; min-width: 180px; text-align: center; } /* 操作 */
  
        /* 表格行悬停效果 */
        tbody tr:hover {
            background-color: #f9f9f9;
        }
  
        /* JSON数据缩略显示样式 */
        .json-summary {
            display: block; /* 占据一行 */
            max-width: 100%; /* 填充父容器宽度 */
            white-space: nowrap; /* 不换行 */
            overflow: hidden; /* 溢出隐藏 */
            text-overflow: ellipsis; /* 显示省略号 */
            font-family: monospace; /* 等宽字体 */
            font-size: 0.85em;
            color: #555;
            padding: 2px 0; /* 增加一点垂直填充 */
        }
        
        /* 操作按钮组样式 */
        .operation-buttons {
            display: flex;
            justify-content: center; /* 按钮水平居中 */
            gap: 10px; /* 按钮之间的间距 */
            flex-wrap: nowrap; /* 尽量不换行 */
        }
        .operation-buttons .view-details-btn {
            background-color: #6c757d; /* 灰色按钮 */
            padding: 8px 12px; /* 调整按钮填充 */
            font-size: 14px; /* 调整字体大小 */
            min-width: 80px; /* 保持按钮最小宽度一致 */
            border-radius: 8px; /* 确保特定按钮也圆角 */
        }
        .operation-buttons .view-details-btn:hover {
            background-color: #5a6268;
        }
        .operation-buttons .delete-btn {
            padding: 8px 12px; /* 调整按钮填充 */
            font-size: 14px; /* 调整字体大小 */
            min-width: 80px; /* 保持按钮最小宽度一致 */
            margin-left: 0; /* 确保删除按钮没有额外的左边距 */
            border-radius: 8px; /* 确保特定按钮也圆角 */
        }
        
        /* Modal styles */
        .modal {
            display: none; /* Hidden by default */
            position: fixed; /* Stay in place */
            z-index: 1000; /* Sit on top */
            left: 0;
            top: 0;
            width: 100%; /* Full width */
            height: 100%; /* Full height */
            overflow: auto; /* Enable scroll if needed */
            background-color: rgba(0,0,0,0.4); /* Black w/ opacity */
            justify-content: center;
            align-items: center;
        }
        .modal.is-active { display: flex; } /* Show modal */
        .modal-content {
            background-color: #fefefe;
            margin: auto;
            padding: 30px;
            border: 1px solid #888;
            border-radius: 10px;
            width: 80%; /* Could be more responsive */
            max-width: 600px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.3);
            position: relative;
        }
        .modal-details { /* 用于详细JSON的弹窗 */
            max-width: 800px; /* 大一点 */
            width: 90%;
            padding-bottom: 20px; /* 增加底部填充 */
        }
        .close-button {
            color: #aaa;
            position: absolute;
            top: 10px;
            right: 20px;
            font-size: 28px;
            font-weight: bold;
            cursor: pointer;
        }
        .close-button:hover,
        .close-button:focus {
            color: black;
            text-decoration: none;
            cursor: pointer;
        }
        .modal-content label { margin-top: 15px; display: block; }
        .modal-content input[type="number"],
        .modal-content input[type="text"],
        .modal-content input[type="password"] {
            margin-bottom: 15px;
            padding: 8px;
            border: 1px solid #ccc;
            border-radius: 4px;
            width: 100%; /* Make inputs full width */
            box-sizing: border-box; /* 包含内边距和边框在宽度内 */
        }
        .modal-content input[type="number"] { width: 100px; } /* 特定年份输入框保持较窄 */
  
        .modal-content textarea { 
            margin-bottom: 15px;
            width: 100%;
            min-height: 250px;
            box-sizing: border-box;
            padding: 10px;
            border: 1px solid #ccc;
            border-radius: 5px;
            font-size: 1em;
            line-height: 1.4;
            resize: vertical;
        }
        .modal-content button { margin-top: 15px; width: auto; padding: 10px 20px; }
        .message { margin-top: 20px; padding: 15px; border-radius: 5px; font-weight: bold; }
        .message.success { background-color: #d4edda; color: #155724; border-color: #c3e6cb; }
        .message.error { background-color: #f8d7da; color: #721c24; border-color: #f5c6cb; }
        .message.info { background-color: #d1ecf1; color: #0c5460; border-color: #bee5eb; } /* 信息提示样式 */
  
  
        /* 新增/修改：JSON 编辑 textarea 样式 */
        .json-editor {
            background-color: #f9f9f9; 
            padding: 15px;
            border-radius: 6px; 
            max-height: 400px; 
            overflow-y: auto;
            white-space: pre-wrap; 
            word-break: break-all;
            font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace; 
            font-size: 0.88em; 
            line-height: 1.6; 
            border: 1px solid #e0e0e0; 
            width: 100%;
            box-sizing: border-box; 
            resize: vertical; 
            height: 300px; 
            color: #36454F; 
            margin-bottom: 0; 
        }
        /* JSON 编辑器只读时的样式 */
        .json-editor[readonly] {
            cursor: default; 
            background-color: #f0f0f0; 
        }
  
        /* 按钮分组容器样式 */
        .modal-actions-group {
            display: flex;
            justify-content: flex-end; 
            gap: 12px; 
            margin-top: 5px; /* 调整为更小的间距 */
        }
        /* 针对 editJsonBtn 和 saveEditedJsonBtn 的通用样式调整 */
        #editJsonBtn { 
            background-color: #ffc107; 
            color: #fff; 
        } 
        #editJsonBtn:hover { 
            background-color: #e0a800; 
            transform: translateY(-1px);
        }
        /* 保存按钮样式 (绿色调) */
        #saveEditedJsonBtn { 
            background-color: #28a745; 
            color: #fff; 
        } 
        #saveEditedJsonBtn:hover { 
            background-color: #218838; 
            transform: translateY(-1px);
        }
  
         /* 响应式调整 */
        @media (max-width: 900px) {
            .main-wrapper {
                flex-direction: column; /* 小屏幕堆叠 */
                align-items: center; /* 居中 */
            }
            .stats-sidebar {
                width: 90%; /* 占据大部分宽度 */
                max-width: 500px; /* 限制最大宽度 */
                position: static; /* 取消粘性定位 */
                margin-bottom: 20px;
                order: 1; /* 在小屏幕上将其放到主内容下方 */
            }
            .container {
                width: 90%;
                order: 0; /* 在小屏幕上将其放到侧边栏上方 */
            }
            .page-header .auth-actions {
                gap: 5px; /* 小屏幕上减少按钮间隙 */
            }
        }
    </style>
  </head>
  <body>
    <div class="main-wrapper">
        <!-- 主内容区域 -->
        <div class="container">
            <div class="page-header">
                <h1>节假日信息管理系统</h1>
                ${authActionsHtml}
            </div>
  
            <div class="admin-header-section">
                <h2>已保存节假日数据</h2>
                <!-- 默认隐藏，由客户端JS根据登录状态控制显示 -->
                <button id="showAddModalBtn" style="display: none;">设置节假日</button> 
            </div>
  
            <table>
                <thead>
                    <tr>
                        <th>年份</th>
                        <th>节假日JSON数据</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody id="holidayTableBody">
                    <!-- Data will be rendered by client-side JS -->
                </tbody>
            </table>
        </div>
  
        <!-- 右侧统计侧边栏 -->
        <div class="stats-sidebar">
            <h2>API 调用统计</h2>
            <div class="stats-line"></div> <!-- 分隔线 -->
            
            ${dynamicStatsEntriesHtml}
            
            <div class="stats-line"></div> <!-- 分隔线 -->
            <!-- 可以在这里添加其他统计数据 -->
        </div>
    </div>
  
    <!-- The Modal for adding/editing holidays -->
    <div id="addHolidayModal" class="modal">
        <div class="modal-content">
            <span class="close-button" id="closeAddModal">&times;</span>
            <h2>设置节假日</h2>
            <form id="modalHolidayForm">
                <label for="modalYear">年份:</label>
                <input type="number" id="modalYear" name="year" min="2000" max="2100" value="${new Date().getFullYear()}" required>
                <label for="modalHolidayText">节假日信息 (请参考示例图格式输入, 如官方通知正文):</label>
                <textarea id="modalHolidayText" name="holidayText" required placeholder="例如：
  国务院办公厅关于2025年部分节假日安排的通知
  国办发明电〔2024〕12号
  ...
  按照上述原则,现将2025年元旦、春节、清明节、劳动节、端午节、中秋节和国庆节放假调休日期的具体安排通知如下。
  一、元旦：1月1日(周三)放假1天，不调休。
  二、春节：1月28日(农历除夕、周二)至2月4日(农历正月初七、周二)放假调休，共8天。1月26日(周日)、2月8日(周六)上班。
  三、清明节：4月4日(周五)至6日(周日)放假，共3天。
  四、劳动节：5月1日(周四)至5日(周一)放假调休，共5天。4月27日(周日)上班。
  五、端午节：5月31日(周六)至6月2日(周一)放假，共3天。
  六、国庆节、中秋节：10月1日(周三)至8日(周三)放假调休，共8天。9月28日(周日)、10月11日(周六)上班。
  ..."></textarea>
                <button type="submit">保存节假日</button>
                <div id="modalFormMessage" class="message" style="display:none;"></div>
            </form>
        </div>
    </div>
  
    <!-- The Modal for viewing/editing holiday details -->
    <div id="viewDetailsModal" class="modal">
        <div class="modal-content modal-details">
            <span class="close-button" id="closeDetailsModal">&times;</span>
            <h2>节假日详细信息 (<span id="detailHolidayYear"></span> 年)</h2>
            <!-- 将 pre 替换为 textarea，并添加 class="json-editor" -->
            <textarea id="detailJsonContentTextarea" class="json-editor" readonly></textarea>
            
            <!-- 调整 message 和 按钮组位置 -->
            <div id="editJsonMessage" class="message" style="display:none; margin-top: 5px;"></div> <!-- 减少 margin-top -->
            <div class="modal-actions-group">
                <button id="editJsonBtn" type="button" style="display: none;">编辑JSON</button> 
                <button id="saveEditedJsonBtn" type="button" style="display: none;">保存修改</button>
            </div>
        </div>
    </div>
  
    <script>${clientScriptContent}</script>
  </body>
  </html>
    `;

    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

/**
 * 生成登录页面HTML
 * @param {string} [errorMessage=''] - 错误信息
 * @returns {string} 登录页面的HTML
*/
function loginPageHtml(errorMessage = '') {
    const errorSection = errorMessage
        ? `<div class="message error" style="display:block; margin-bottom: 20px;">${workerEscapeHtml(errorMessage)}</div>`
        : '';

    return `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录 - 节假日信息管理系统</title>
    <!-- Favicon 标签 -->
    <link rel="icon" type="image/png" href="${FAVICON_URL}">
    <link rel="shortcut icon" href="${FAVICON_URL}">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif; margin: 0; background-color: #f4f7f6; color: #333; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
        .login-container {
            background-color: #fff;
            padding: 40px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
            width: 100%;
            max-width: 400px;
            text-align: center;
        }
        h2 { color: #0056b3; margin-bottom: 30px; }
        .form-group { margin-bottom: 20px; text-align: left; }
        label { display: block; margin-bottom: 8px; font-weight: bold; color: #555; }
        input[type="text"], input[type="password"] {
            width: 100%;
            padding: 12px;
            border: 1px solid #ccc;
            border-radius: 4px;
            box-sizing: border-box;
            font-size: 1em;
        }
        button {
            background-color: #007bff;
            color: white;
            padding: 12px 25px;
            border: none;
            border-radius: 8px; /* 所有按钮统一圆角 */
            cursor: pointer;
            font-size: 1.1em;
            transition: background-color 0.2s, transform 0.1s;
            width: 100%;
            margin-top: 20px;
        }
        button:hover { background-color: #0056b3; transform: translateY(-1px); }
        .back-link { display: block; margin-top: 25px; color: #007bff; text-decoration: none; }
        .back-link:hover { text-decoration: underline; }
        .message { padding: 15px; border-radius: 5px; font-weight: bold; }
        .message.error { background-color: #f8d7da; color: #721c24; border-color: #f5c6cb; }
    </style>
  </head>
  <body>
    <div class="login-container">
        <h2>登录节假日信息管理系统</h2>
        ${errorSection}
        <form action="/login" method="POST">
            <div class="form-group">
                <label for="username">用户名:</label>
                <input type="text" id="username" name="username" required>
            </div>
            <div class="form-group">
                <label for="password">密码:</label>
                <input type="password" id="password" name="password" required>
            </div>
            <button type="submit">登录</button>
        </form>
        <a href="/" class="back-link">返回主页</a>
    </div>
  </body>
  </html>
    `;
}

/**
 * 处理登录请求
*/
async function handleLogin(request, env) {
    if (request.method === 'GET') {
        const url = new URL(request.url);
        const errorMessage = url.searchParams.get('error') ? '用户名或密码不正确。' : '';
        return new Response(loginPageHtml(errorMessage), {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    } else if (request.method === 'POST') {
        const formData = await request.formData();
        const username = formData.get('username');
        const password = formData.get('password');

        if (username === env.USERNAME && password === env.PASSWORD) {
            const cookieOptions = [
                'logged_in=true',
                'Path=/',
                'HttpOnly',
                `Max-Age=${86400}`, // 24小时过期
                'SameSite=Lax'
            ];
            // 部署到HTTPS时才使用Secure
            if (request.url.startsWith('https')) {
                cookieOptions.push('Secure');
            }

            const headers = new Headers();
            headers.set('Set-Cookie', cookieOptions.join('; '));
            headers.set('Location', new URL('/', request.url).toString());
            // 强制浏览器不缓存此响应，确保下次刷新是新的页面内容
            headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            headers.set('Pragma', 'no-cache');
            headers.set('Expires', '0');

            return new Response(null, { status: 302, headers: headers }); // 显式构造Response
        } else {
            return Response.redirect(new URL('/login?error=1', request.url).toString(), 302);
        }
    }
    return new Response('Method Not Allowed', { status: 405 });
}

/**
 * 处理登出请求
*/
async function handleLogout(request, env) {
    const cookieOptions = [
        'logged_in=', // 清空值
        'Path=/',
        'HttpOnly',
        `Max-Age=0`, // 立即过期
        'SameSite=Lax'
    ];
    if (request.url.startsWith('https')) {
        cookieOptions.push('Secure');
    }

    const headers = new Headers();
    headers.set('Set-Cookie', cookieOptions.join('; '));
    headers.set('Location', new URL('/', request.url).toString());
    // 强制浏览器不缓存此响应，确保下次刷新是新的页面内容
    headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    headers.set('Pragma', 'no-cache');
    headers.set('Expires', '0');

    return new Response(null, { status: 302, headers: headers });
}

/**
 * 处理节假日数据保存请求 (通过文本解析方式)
*/
async function handleSaveHoliday(request, env) {
    try {
        const { year, holidayText } = await request.json();
        if (!year || !holidayText) {
            return new Response(JSON.stringify({ success: false, message: '年份和节假日信息不能为空。' }), {
                headers: { 'Content-Type': 'application/json' },
                status: 400,
            });
        }

        console.log(`Attempting to parse holidays for year ${year}`);

        const parsedHolidaysArray = parseHolidayText(year, holidayText);
        // 使用null, 2进行美化格式化, 方便存储和后续查看
        const jsonToStore = JSON.stringify(parsedHolidaysArray, null, 2);

        console.log(`Parsed holidays for year ${year}:`);
        console.log(jsonToStore);

        await env.HOLIDAYS_KV.put(`holiday_${year}`, jsonToStore);

        // 成功时返回保存的json字符串，供前端即时更新使用
        return new Response(JSON.stringify({ success: true, message: '数据保存成功。', parsedData: parsedHolidaysArray }), {
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error('保存节假日数据时发生错误:', error);
        return new Response(JSON.stringify({ success: false, message: `保存失败: ${error.message}` }), {
            headers: { 'Content-Type': 'application/json' },
            status: 500,
        });
    }
}

/**
 * 处理节假日数据删除请求
*/
async function handleDeleteHoliday(request, env) {
    try {
        const { year } = await request.json();
        if (!year) {
            return new Response(JSON.stringify({ success: false, message: '年份不能为空。' }), {
                headers: { 'Content-Type': 'application/json' },
                status: 400,
            });
        }

        await env.HOLIDAYS_KV.delete(`holiday_${year}`);

        return new Response(JSON.stringify({ success: true, message: '数据删除成功。' }), {
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error('删除节假日数据时发生错误:', error);
        return new Response(JSON.stringify({ success: false, message: `删除失败: ${error.message}` }), {
            headers: { 'Content-Type': 'application/json' },
            status: 500,
        });
    }
}

/**
 * 处理直接编辑 JSON 数据的保存请求
*/
async function handleSaveEditedJson(request, env) {
    try {
        const { year, editedJsonString } = await request.json();
        if (!year || !editedJsonString) {
            return new Response(JSON.stringify({ success: false, message: '年份和编辑后的JSON数据不能为空。' }), {
                headers: { 'Content-Type': 'application/json' },
                status: 400,
            });
        }

        // 再次验证 JSON 格式
        let parsedData;
        try {
            parsedData = JSON.parse(editedJsonString);
            if (!Array.isArray(parsedData)) {
                throw new Error('JSON数据必须是一个数组。');
            }
        } catch (e) {
            return new Response(JSON.stringify({ success: false, message: `JSON格式错误: ${e.message}` }), {
                headers: { 'Content-Type': 'application/json' },
                status: 400,
            });
        }

        // 直接保存编辑后的原始 JSON 字符串到 KV
        await env.HOLIDAYS_KV.put(`holiday_${year}`, editedJsonString);

        return new Response(JSON.stringify({ success: true, message: 'JSON数据保存成功！', parsedData: parsedData }), {
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (error) {
        console.error('保存编辑后的JSON数据时发生错误:', error);
        return new Response(JSON.stringify({ success: false, message: `保存失败: ${error.message}` }), {
            headers: { 'Content-Type': 'application/json' },
            status: 500,
        });
    }
}


/**
 * 辅助函数：更新系统设置中的API调用计数器
 * @param {Env} env - Worker的环境变量
 * @param {string} apiName - 要更新的API名称（例如 'dateInfo', 'yearInfo', 'monthInfo'）
*/
async function updateCallCounter(env, apiName) {
    try {
        const systemSettingString = await env.HOLIDAYS_KV.get('system_setting', 'text');
        let systemSetting = {};
        if (systemSettingString) {
            try {
                systemSetting = JSON.parse(systemSettingString);
            } catch (parseError) {
                console.error("Error parsing system_setting from KV (resetting):", parseError);
                systemSetting = {}; // 如果JSON无效，则重置为新对象
            }
        }

        if (!systemSetting.call_counters) {
            systemSetting.call_counters = {};
        }
        // 确保特定API的计数器存在并递增
        systemSetting.call_counters[apiName] = (systemSetting.call_counters[apiName] || 0) + 1;

        await env.HOLIDAYS_KV.put('system_setting', JSON.stringify(systemSetting));
    } catch (kvError) {
        console.error(`Error updating system_setting in KV for ${apiName} call counter:`, kvError);
    }
}

/**
 * 辅助函数：从KV获取时区配置，默认为 'Asia/Shanghai'
 * @param {Env} env
 * @returns {Promise<string>}
*/
async function getTimeZone(env) {
    try {
        const systemSettingString = await env.HOLIDAYS_KV.get('system_setting', 'text');
        if (systemSettingString) {
            const systemSetting = JSON.parse(systemSettingString);
            return systemSetting.time_zone || 'Asia/Shanghai';
        }
    } catch (e) {
        console.error('Error reading time_zone from KV:', e);
    }
    return 'Asia/Shanghai';
}

/**
 * 辅助函数：根据指定时区获取当前日期、年份和月份
 * @param {Env} env - Worker的环境变量
 * @returns {Promise<{currentDate: string, currentYear: string, currentMonth: string}>}
*/
async function getCurrentDateInTimeZone(env) {
    const tz = await getTimeZone(env);
    
    // 创建一个新的 Date 对象
    const now = new Date();

    // 使用 Intl.DateTimeFormat 获取指定时区下的年、月、日
    const formatter = new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone: tz
    });
    const parts = formatter.formatToParts(now);

    let year = '';
    let month = '';
    let day = '';

    for (const part of parts) {
        if (part.type === 'year') year = part.value;
        else if (part.type === 'month') month = part.value;
        else if (part.type === 'day') day = part.value;
    }
    
    const currentDate = `${year}-${month}-${day}`;
    const currentYear = year;
    const currentMonth = `${year}-${month}`;

    return { currentDate, currentYear, currentMonth };
}


/**
 * 生成设置页面HTML
 * @param {string} currentTimeZone - 当前配置的时区。
 * @param {string} [message=''] - 显示的消息（成功/错误）。
 * @param {string} [messageType=''] - 消息类型（'success', 'error'）。
 * @returns {string} 设置页面的HTML。
*/
function settingsPageHtml(currentTimeZone, message = '', messageType = '') {
    // 原始时区列表
    let timeZones = [
        { value: 'Pacific/Honolulu', label: '檀香山夏威夷时间 (UTC-10)', offset: -10 },
        { value: 'America/Anchorage', label: '安克雷奇阿拉斯加时间 (UTC-9)', offset: -9 },
        { value: 'America/Los_Angeles', label: '洛杉矶太平洋时间 (UTC-8)', offset: -8 },
        { value: 'America/Denver', label: '丹佛山地时间 (UTC-7)', offset: -7 },
        { value: 'America/Chicago', label: '芝加哥中部时间 (UTC-6)', offset: -6 },
        { value: 'America/Mexico_City', label: '墨西哥城中部时间 (UTC-6)', offset: -6 },
        { value: 'America/New_York', label: '纽约东部时间 (UTC-5)', offset: -5 },
        { value: 'Canada/Atlantic', label: '哈利法克斯大西洋时间 (UTC-4)', offset: -4 },
        { value: 'America/Sao_Paulo', label: '圣保罗巴西利亚时间 (UTC-3)', offset: -3 },
        { value: 'Atlantic/Azores', label: '亚速尔群岛时间 (UTC-1)', offset: -1 },
        { value: 'Europe/London', label: '伦敦格林威治时间 (UTC+0)', offset: 0 },
        { value: 'Europe/Paris', label: '巴黎中部欧洲时间 (UTC+1)', offset: 1 },
        { value: 'Europe/Berlin', label: '柏林中部欧洲时间 (UTC+1)', offset: 1 },
        { value: 'Europe/Rome', label: '罗马中部欧洲时间 (UTC+1)', offset: 1 },
        { value: 'Africa/Cairo', label: '开罗东部欧洲时间 (UTC+2)', offset: 2 },
        { value: 'Europe/Moscow', label: '莫斯科标准时间 (UTC+3)', offset: 3 },
        { value: 'Asia/Dubai', label: '迪拜标准时间 (UTC+4)', offset: 4 },
        { value: 'Indian/Mauritius', label: '毛里求斯时间 (UTC+4)', offset: 4 },
        { value: 'Asia/Karachi', label: '卡拉奇巴基斯坦时间 (UTC+5)', offset: 5 },
        { value: 'Asia/Kolkata', label: '加尔各答印度标准时间 (UTC+5:30)', offset: 5.5 },
        { value: 'Asia/Almaty', label: '阿拉木图时间 (UTC+6)', offset: 6 },
        { value: 'Asia/Bangkok', label: '曼谷印度支那时间 (UTC+7)', offset: 7 },
        { value: 'Asia/Shanghai', label: '中国标准时间 (UTC+8)', offset: 8 },
        { value: 'Asia/Singapore', label: '新加坡标准时间 (UTC+8)', offset: 8 },
        { value: 'Asia/Hong_Kong', label: '香港标准时间 (UTC+8)', offset: 8 },
        { value: 'Asia/Tokyo', label: '日本标准时间 (UTC+9)', offset: 9 },
        { value: 'Asia/Seoul', label: '首尔韩国标准时间 (UTC+9)', offset: 9 },
        { value: 'Australia/Sydney', label: '悉尼东部标准时间 (UTC+10)', offset: 10 },
        { value: 'Asia/Vladivostok', label: '符拉迪沃斯托克时间 (UTC+10)', offset: 10 },
        { value: 'Pacific/Noumea', label: '努美亚新喀里多尼亚时间 (UTC+11)', offset: 11 },
        { value: 'Pacific/Auckland', label: '奥克兰新西兰标准时间 (UTC+12)', offset: 12 },
    ];

    // 定义每个偏移量对应的首选时区
    const preferredChoices = {
        8: 'Asia/Shanghai',          // UTC+8 优先选择中国标准时间
        0: 'Europe/London',          // UTC+0 优先选择伦敦
        1: 'Europe/Paris',           // UTC+1 优先选择巴黎
        '-6': 'America/Chicago',      // UTC-6 优先选择芝加哥 (注意这里使用字符串键，因为offset是数字, 但是在对象中作为key会自动转为字符串)
        4: 'Asia/Dubai',             // UTC+4 优先选择迪拜
        10: 'Australia/Sydney'       // UTC+10 优先选择悉尼
        // 可以根据需要添加更多偏移量的首选时区
    };

    const filteredTimeZonesMap = new Map(); // 使用Map来存储每个偏移量的唯一时区

    // 优先添加首选时区
    for (const tz of timeZones) {
        if (preferredChoices[tz.offset] === tz.value) {
            filteredTimeZonesMap.set(tz.offset, tz);
        }
    }

    // 再次遍历，添加未被首选时区覆盖的偏移量的第一个时区
    for (const tz of timeZones) {
        if (!filteredTimeZonesMap.has(tz.offset)) {
            filteredTimeZonesMap.set(tz.offset, tz);
        }
    }

    // 将Map的值转换为数组并再次排序以确保顺序
    let filteredTimeZones = Array.from(filteredTimeZonesMap.values());

    filteredTimeZones.sort((a, b) => a.offset - b.offset);

    const messageHtml = message ? `<div class="message ${messageType}" style="display:block; margin-top: 20px;">${workerEscapeHtml(message)}</div>` : '';

    const optionsHtml = filteredTimeZones.map(tz =>
        `<option value="${tz.value}" ${tz.value === currentTimeZone ? 'selected' : ''}>${tz.label}</option>`
    ).join('');

    return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>系统设置 - 节假日信息管理系统</title>
      <!-- Favicon 标签 -->
      <link rel="icon" type="image/png" href="${FAVICON_URL}">
      <link rel="shortcut icon" href="${FAVICON_URL}">
      <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif; margin: 0; background-color: #f4f7f6; color: #333; display: flex; justify-content: center; align-items: flex-start; min-height: 100vh; padding: 20px; box-sizing: border-box; }
          .settings-container {
              background-color: #fff;
              padding: 40px;
              border-radius: 8px;
              box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
              width: 100%;
              max-width: 600px;
              text-align: center;
              margin-top: 50px;
          }
          h2 { color: #0056b3; margin-bottom: 30px; }
          .form-group { margin-bottom: 30px; text-align: left; }
          label { display: block; margin-bottom: 10px; font-weight: bold; color: #555; font-size: 1.1em; }
          select {
              width: 100%;
              padding: 12px;
              border: 1px solid #ccc;
              border-radius: 8px; /* 圆角更大 */
              box-sizing: border-box;
              font-size: 1.05em;
              appearance: none; /* 移除默认箭头 */
              background-color: #f8f8f8; /* 浅灰色背景 */
              cursor: pointer;
              background-image: url('data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%3E%3Cpath%20fill%3D%22%23333%22%20d%3D%22M6%209L0%203h12z%22%2F%3E%3C%2Fsvg%3E'); /* 自定义下拉箭头 */
              background-repeat: no-repeat;
              background-position: right 12px center;
              background-size: 10px;
          }
          select:focus {
              outline: none;
              border-color: #007bff;
              box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.25);
          }
          button {
              background-color: #007bff;
              color: white;
              padding: 12px 25px;
              border: none;
              border-radius: 8px;
              cursor: pointer;
              font-size: 1.1em;
              transition: background-color 0.2s, transform 0.1s;
              width: auto;
              min-width: 120px;
              margin-top: 20px;
          }
          button:hover { background-color: #0056b3; transform: translateY(-1px); }
          .back-link-group {
                display: flex;
                justify-content: center;
                gap: 20px; /* 链接之间的间距 */
                margin-top: 30px;
          }
          .back-link-group .back-link { 
              color: #007bff; 
              text-decoration: none; 
              font-size: 1em; 
              padding: 5px 10px;
              border-radius: 8px;
              transition: background-color 0.2s;
          }
          .back-link-group .back-link:hover { 
              text-decoration: underline; 
              background-color: #e9ecef;
          }
          .message { padding: 15px; border-radius: 5px; font-weight: bold; text-align: left; }
          .message.success { background-color: #d4edda; color: #155724; border-color: #c3e6cb; }
          .message.error { background-color: #f8d7da; color: #721c24; border-color: #f5c6cb; }
      </style>
    </head>
    <body>
      <div class="settings-container">
          <h2>系统设置</h2>
          <form action="/settings" method="POST">
              <div class="form-group">
                  <label for="timeZone">时区选择:</label>
                  <select id="timeZone" name="timeZone" required>
                      ${optionsHtml}
                  </select>
              </div>
              <button type="submit">保存设置</button>
          </form>
          ${messageHtml}
          <div class="back-link-group">
            <a href="/" class="back-link">返回管理页</a>
          </div>
      </div>
    </body>
    </html>
    `;
}

/**
 * 处理设置页面（GET和POST）
*/
async function handleSettings(request, env) {
    let currentTimeZone = await getTimeZone(env);
    let message = '';
    let messageType = '';

    if (request.method === 'POST') {
        try {
            const formData = await request.formData();
            const newTimeZone = formData.get('timeZone');

            if (!newTimeZone) {
                message = '未选择时区。';
                messageType = 'error';
            } else {
                // 读取当前 system_setting
                const systemSettingString = await env.HOLIDAYS_KV.get('system_setting', 'text');
                let systemSetting = {};
                if (systemSettingString) {
                    try {
                        systemSetting = JSON.parse(systemSettingString);
                    } catch (e) {
                        console.error('Error parsing existing system_setting:', e);
                        // 如果解析失败，则从空对象开始，避免影响 call_counters
                        systemSetting = {};
                    }
                }
                systemSetting.time_zone = newTimeZone; // 更新时区

                await env.HOLIDAYS_KV.put('system_setting', JSON.stringify(systemSetting));
                currentTimeZone = newTimeZone; // 更新显示
                message = '设置已保存成功！';
                messageType = 'success';
            }
        } catch (error) {
            console.error('保存设置时发生错误:', error);
            message = `保存失败: ${error.message}`;
            messageType = 'error';
        }
    }
    // GET 或 POST 处理后的页面渲染
    return new Response(settingsPageHtml(currentTimeZone, message, messageType), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}


/**
 * 处理日期信息查询请求 /dateInfo?date=YYYY-MM-DD
*/
async function handleDateInfo(request, env) {
    const url = new URL(request.url);
    let dateParam = url.searchParams.get('date');

    const { currentDate: defaultDate } = await getCurrentDateInTimeZone(env);

    if (!dateParam) {
        dateParam = defaultDate; // 如果没有提供日期参数，则使用当前日期
    }

    const dateMatch = dateParam.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dateMatch) {
        return new Response(JSON.stringify({ message: '日期格式不正确，应为 YYYY-MM-DD。' }), {
            headers: { 'Content-Type': 'application/json' },
            status: 400,
        });
    }

    const year = dateMatch[1];
    const requestedDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;

    const tz = await getTimeZone(env);
    
    // 获取指定时区下的星期几 (英文名称)
    const requestedDateObj = new Date(requestedDate + 'T00:00:00'); // 使用本地时间构造，后续toLocaleString会据此转换
    if (isNaN(requestedDateObj.getTime())) { // 再次验证日期是否有效 
       return new Response(JSON.stringify({ message: '无效的日期。' }), {
            headers: { 'Content-Type': 'application/json' },
            status: 400,
        });
    }

    const dayOfWeekEnglish = requestedDateObj.toLocaleString('en-US', { weekday: 'long', timeZone: tz });
    const WEEK_DAYS_CHINESE_MAP = {
        'Sunday': '周日',
        'Monday': '周一',
        'Tuesday': '周二',
        'Wednesday': '周三',
        'Thursday': '周四',
        'Friday': '周五',
        'Saturday': '周六',
    };
    const humanReadableWeek = WEEK_DAYS_CHINESE_MAP[dayOfWeekEnglish] || '';

    let isWorkDay = 1; // 默认是工作日
    let isOfficialHoliday = 0; // 默认不是官方假日
    let isWorkAdjustmentDay = 0; // 默认不是调休工作日
    let holidayName = ''; // 默认没有假日名称

    // 获取该年份的节假日数据
    const holidayDataString = await env.HOLIDAYS_KV.get(`holiday_${year}`);
    let holidaysConfig = [];

    if (holidayDataString) {
        try {
            holidaysConfig = JSON.parse(holidayDataString);
            if (!Array.isArray(holidaysConfig)) {
                holidaysConfig = [];
            }
        } catch (e) {
            console.error(`Error parsing holiday data for ${year}:`, e);
            holidaysConfig = [];
        }
    }

    // 1. 先检查是否是调休工作日（调休优先级最高，可以覆盖周末和假期）
    for (const holidayEntry of holidaysConfig) {
        if (holidayEntry.workAdjustmentDates && holidayEntry.workAdjustmentDates.includes(requestedDate)) {
            isWorkDay = 1; // 调休上班日是工作日
            isWorkAdjustmentDay = 1;
            holidayName = `调休上班 (原${holidayEntry.name})`;
            // 如果是调休上班日，就直接确定了，后续规则不用再检查
            await updateCallCounter(env, 'dateInfo');
            return new Response(JSON.stringify({
                date: requestedDate,
                week: humanReadableWeek,
                isWorkDay: isWorkDay,
                isOfficialHoliday: isOfficialHoliday,
                isWorkAdjustmentDay: isWorkAdjustmentDay,
                holidayName: holidayName,
            }, null, 2), {
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
            });
        }
    }

    // 2. 如果不是调休工作日，再检查是否是自然周末
    if (dayOfWeekEnglish === 'Saturday' || dayOfWeekEnglish === 'Sunday') {
        isWorkDay = 0; // 自然周末默认是休息日
        holidayName = '周末';
    }

    // 3. 检查是否是官方节假日（假期可以覆盖掉自然周末的 "休息日" 状态）
    for (const holidayEntry of holidaysConfig) {
        if (!holidayEntry.startDate || !holidayEntry.endDate) continue;

        // 使用 UTC 零点日期进行纯日期比较，避免时区偏移影响日期范围判断
        const start = new Date(holidayEntry.startDate + 'T00:00:00Z'); 
        const end = new Date(holidayEntry.endDate + 'T00:00:00Z');
        const current = new Date(requestedDate + 'T00:00:00Z'); // 请求的日期也转换为UTC

        if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && !isNaN(current.getTime()) &&
            current >= start && current <= end) {
            isWorkDay = 0; // 是放假日期
            isOfficialHoliday = 1;
            holidayName = holidayEntry.name;
            break; // 找到一个假期就够了，因为如果重叠，总是放假
        }
    }
    
    const responseData = {
        date: requestedDate,
        week: humanReadableWeek,
        isWorkDay: isWorkDay,
        isOfficialHoliday: isOfficialHoliday,
        isWorkAdjustmentDay: isWorkAdjustmentDay,
        holidayName: holidayName,
    };

    // 更新 API 调用计数器
    await updateCallCounter(env, 'dateInfo');

    return new Response(JSON.stringify(responseData, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
}


/**
 * 处理年份节假日信息查询请求 /open/yearInfo?year=YYYY
*/
async function handleYearInfo(request, env) {
    const url = new URL(request.url);
    let yearParam = url.searchParams.get('year');

    if (!yearParam) {
        const { currentYear: defaultYear } = await getCurrentDateInTimeZone(env);
        yearParam = defaultYear; // 如果没有提供年份参数，则使用当前年份
    }

    if (!/^\d{4}$/.test(yearParam)) {
        return new Response(JSON.stringify({ message: '年份格式不正确，应为四位数字 (YYYY)。' }), {
            headers: { 'Content-Type': 'application/json' },
            status: 400,
        });
    }

    const holidayDataString = await env.HOLIDAYS_KV.get(`holiday_${yearParam}`);
    let holidaysConfig = [];

    if (holidayDataString) {
        try {
            holidaysConfig = JSON.parse(holidayDataString);
            if (!Array.isArray(holidaysConfig)) {
                holidaysConfig = [];
            }
        } catch (e) {
            console.error(`Error parsing holiday data for ${yearParam}:`, e);
            return new Response(JSON.stringify({ message: `获取 ${yearParam} 年节假日数据失败，数据格式错误。` }), {
                headers: { 'Content-Type': 'application/json' },
                status: 500,
            });
        }
    } else {
        return new Response(JSON.stringify({ message: `未找到 ${yearParam} 年的节假日数据。` }), {
            headers: { 'Content-Type': 'application/json' },
            status: 404,
        });
    }

    // 更新 API 调用计数器
    await updateCallCounter(env, 'yearInfo');

    return new Response(JSON.stringify(holidaysConfig, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
}

/**
 * 处理月份节假日信息查询请求 /open/monthInfo?month=YYYY-MM
*/
async function handleMonthInfo(request, env) {
    const url = new URL(request.url);
    let monthParam = url.searchParams.get('month');

    if (!monthParam) {
        const { currentMonth: defaultMonth } = await getCurrentDateInTimeZone(env);
        monthParam = defaultMonth; // 如果没有提供月份参数，则使用当前月份
    }

    const monthMatch = monthParam.match(/^(\d{4})-(\d{2})$/);
    if (!monthMatch) {
        return new Response(JSON.stringify({ message: '月份格式不正确，应为 YYYY-MM。' }), {
            headers: { 'Content-Type': 'application/json' },
            status: 400,
        });
    }

    const year = monthMatch[1];
    const month = parseInt(monthMatch[2]); // MM 字符串

    if (month < 1 || month > 12) {
        return new Response(JSON.stringify({ message: '月份值不合法 (1-12)。' }), {
            headers: { 'Content-Type': 'application/json' },
            status: 400,
        });
    }

    const holidayDataString = await env.HOLIDAYS_KV.get(`holiday_${year}`);
    let holidaysConfig = [];
    let filteredHolidays = [];

    if (holidayDataString) {
        try {
            holidaysConfig = JSON.parse(holidayDataString);
            if (!Array.isArray(holidaysConfig)) {
                holidaysConfig = [];
            }
        } catch (e) {
            console.error(`Error parsing holiday data for ${year}:`, e);
            return new Response(JSON.stringify({ message: `获取 ${year} 年节假日数据失败，数据格式错误。` }), {
                headers: { 'Content-Type': 'application/json' },
                status: 500,
            });
        }
    } else {
        // 如果没有找到年份数据，直接返回空数组并404或200+ 请问需要我生成一个空数组返回，还是说给一个404提示
        return new Response(JSON.stringify({ message: `未找到 ${year} 年的节假日数据，因此无法获取 ${monthParam} 月份的数据。` }), {
            headers: { 'Content-Type': 'application/json' },
            status: 404, // 返回404可能是更合适的做法，表示对应年份数据不存在
        });
    }

    // 过滤出与 requestedMonth 相关的节假日
    // 逻辑：只要节假日的 startDate 或 endDate 落在目标月份内，或者跨越目标月份，就包含
    // 注意：这里的日期比较也需要使用 UTC 日期对象，以确保准确性
    const targetMonthStart = new Date(year, month - 1, 1, 0, 0, 0, 0); // 月份从0开始
    const targetMonthEnd = new Date(year, month, 0, 23, 59, 59, 999); // 该月最后一天结束

    for (const holiday of holidaysConfig) {
        if (!holiday.startDate || !holiday.endDate) continue;

        const holidayStart = new Date(holiday.startDate + 'T00:00:00Z');
        const holidayEnd = new Date(holiday.endDate + 'T00:00:00Z');
  
        // 调整 targetMonthStart 和 targetMonthEnd 为 UTC 零点，用于比较
        const targetMonthStartUTC = new Date(Date.UTC(targetMonthStart.getFullYear(), targetMonthStart.getMonth(), targetMonthStart.getDate()));
        const targetMonthEndUTC = new Date(Date.UTC(targetMonthEnd.getFullYear(), targetMonthEnd.getMonth(), targetMonthEnd.getDate(), 23, 59, 59, 999));


        if (isNaN(holidayStart.getTime()) || isNan(holidayEnd.getTime())) continue;

        // 检查假期是否与目标月份有重叠
        // 条件1: 假期开始日期在目标月份内
        // 条件2: 假期结束日期在目标月份内
        // 条件3: 假期跨越整个目标月份 (开始日期在目标月份之前，结束日期在目标月份之后)
        const overlaps = (holidayStart <= targetMonthEndUTC && holidayEnd >= targetMonthStartUTC);

        if (overlaps) {
            filteredHolidays.push(holiday);
        }
    }

    // 更新 API 调用计数器
    await updateCallCounter(env, 'monthInfo');

    return new Response(JSON.stringify(filteredHolidays, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
}
