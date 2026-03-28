const FAVICON_URL = "https://cloudflare-imgbed-524.pages.dev/file/img/1752736456549_c04ab0bb5453f2c8b8d27.png";
const HOLIDAY_KEY_PREFIX = 'holiday_';
const SYSTEM_SETTING_KEY = 'system_setting';
const LOGIN_COOKIE_NAME = 'logged_in';
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
const COOKIE_MAX_AGE = 86400;
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8' };
const WEEK_DAYS_CHINESE_MAP = {
    Sunday: '周日',
    Monday: '周一',
    Tuesday: '周二',
    Wednesday: '周三',
    Thursday: '周四',
    Friday: '周五',
    Saturday: '周六',
};
const TIME_ZONES = [
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
const PREFERRED_TIME_ZONES = {
    8: 'Asia/Shanghai',
    0: 'Europe/London',
    1: 'Europe/Paris',
    '-6': 'America/Chicago',
    4: 'Asia/Dubai',
    10: 'Australia/Sydney',
};

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const { pathname } = url;

        if (pathname === '/') {
            return handleAdminPage(request, env);
        }
        if (pathname === '/login') {
            return handleLogin(request, env);
        }
        if (pathname === '/logout') {
            return handleLogout(request);
        }
        if (pathname === '/settings') {
            if (!await isLoggedIn(request)) {
                return redirectResponse('/login', request.url);
            }
            return handleSettings(request, env);
        }
        if (pathname === '/save' && request.method === 'POST') {
            if (!await isLoggedIn(request)) {
                return jsonResponse({ success: false, message: 'Unauthorized' }, 401);
            }
            return handleSaveHoliday(request, env);
        }
        if (pathname === '/delete' && request.method === 'POST') {
            if (!await isLoggedIn(request)) {
                return jsonResponse({ success: false, message: 'Unauthorized' }, 401);
            }
            return handleDeleteHoliday(request, env);
        }
        if (pathname === '/save_edited_json' && request.method === 'POST') {
            if (!await isLoggedIn(request)) {
                return jsonResponse({ success: false, message: 'Unauthorized' }, 401);
            }
            return handleSaveEditedJson(request, env);
        }
        if (pathname === '/open/dateInfo') {
            return handleDateInfo(request, env);
        }
        if (pathname === '/open/yearInfo') {
            return handleYearInfo(request, env);
        }
        if (pathname === '/open/monthInfo') {
            return handleMonthInfo(request, env);
        }

        return new Response('Not Found', { status: 404 });
    },
};

function workerEscapeHtml(text) {
    const value = String(text ?? '');
    const map = {
        '&': '&',
        '<': '<',
        '>': '>',
        '"': '"',
        "'": '&#039;',
    };
    return value.replace(/[&<>"']/g, (char) => map[char]);
}

function jsonResponse(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { ...JSON_HEADERS, ...headers },
    });
}

function htmlResponse(html, status = 200, headers = {}) {
    return new Response(html, {
        status,
        headers: { ...HTML_HEADERS, ...headers },
    });
}

function redirectResponse(path, requestUrl, extraHeaders = {}) {
    return new Response(null, {
        status: 302,
        headers: {
            Location: new URL(path, requestUrl).toString(),
            ...extraHeaders,
        },
    });
}

function getNoCacheHeaders() {
    return {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
    };
}

function parseCookieHeader(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) {
        return cookies;
    }

    for (const part of cookieHeader.split(';')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex === -1) continue;
        const key = trimmed.slice(0, separatorIndex).trim();
        const value = trimmed.slice(separatorIndex + 1).trim();
        cookies[key] = value;
    }

    return cookies;
}

async function isLoggedIn(request) {
    const cookies = parseCookieHeader(request.headers.get('Cookie'));
    return cookies[LOGIN_COOKIE_NAME] === 'true';
}

function createAuthCookie(request, isLogin) {
    const cookieOptions = [
        `${LOGIN_COOKIE_NAME}=${isLogin ? 'true' : ''}`,
        'Path=/',
        'HttpOnly',
        `Max-Age=${isLogin ? COOKIE_MAX_AGE : 0}`,
        'SameSite=Lax',
    ];

    if (request.url.startsWith('https://')) {
        cookieOptions.push('Secure');
    }

    return cookieOptions.join('; ');
}

function isValidYear(value) {
    return /^\d{4}$/.test(String(value ?? ''));
}

function isValidMonthString(value) {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value ?? ''));
}

function isValidDateString(value) {
    if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(value ?? ''))) {
        return false;
    }
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function createUtcDate(value) {
    return new Date(`${value}T00:00:00Z`);
}

function diffDaysInclusive(startDate, endDate) {
    const start = createUtcDate(startDate);
    const end = createUtcDate(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
        return null;
    }
    return Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
}

function normalizeHolidayRecord(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    const name = String(item.name ?? '').trim();
    const startDate = item.startDate ? String(item.startDate) : null;
    const endDate = item.endDate ? String(item.endDate) : null;
    const rawAdjustmentDates = Array.isArray(item.workAdjustmentDates) ? item.workAdjustmentDates : [];
    const workAdjustmentDates = [...new Set(rawAdjustmentDates.filter(isValidDateString))].sort();

    let daysOff = Number.isInteger(item.daysOff) ? item.daysOff : null;
    if (daysOff === null && startDate && endDate && isValidDateString(startDate) && isValidDateString(endDate)) {
        daysOff = diffDaysInclusive(startDate, endDate);
    }

    return {
        name,
        startDate: startDate && isValidDateString(startDate) ? startDate : null,
        endDate: endDate && isValidDateString(endDate) ? endDate : null,
        daysOff: Number.isInteger(daysOff) && daysOff > 0 ? daysOff : null,
        workAdjustmentDates,
    };
}

function normalizeHolidayArray(data) {
    if (!Array.isArray(data)) {
        throw new Error('JSON数据必须是一个数组。');
    }
    return data.map(normalizeHolidayRecord).filter(Boolean);
}

function buildHolidayKvKey(year) {
    return `${HOLIDAY_KEY_PREFIX}${year}`;
}

async function getSystemSettings(env) {
    const raw = await env.HOLIDAYS_KV.get(SYSTEM_SETTING_KEY, 'text');
    if (!raw) {
        return {};
    }

    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        console.error('Error parsing system settings:', error);
        return {};
    }
}

async function saveSystemSettings(env, settings) {
    await env.HOLIDAYS_KV.put(SYSTEM_SETTING_KEY, JSON.stringify(settings));
}

async function getHolidayDataByYear(env, year) {
    const holidayDataString = await env.HOLIDAYS_KV.get(buildHolidayKvKey(year), 'text');
    if (!holidayDataString) {
        return null;
    }

    try {
        return normalizeHolidayArray(JSON.parse(holidayDataString));
    } catch (error) {
        console.error(`Error parsing holiday data for ${year}:`, error);
        throw new Error(`获取 ${year} 年节假日数据失败，数据格式错误。`);
    }
}

async function saveHolidayDataByYear(env, year, holidayArray) {
    const normalized = normalizeHolidayArray(holidayArray);
    await env.HOLIDAYS_KV.put(buildHolidayKvKey(year), JSON.stringify(normalized, null, 2));
    return normalized;
}

function parseDate(dateStr, currentYear, defaultMonth = null) {
    const raw = String(dateStr ?? '').trim();
    if (!isValidYear(currentYear)) {
        return null;
    }

    let month = null;
    let day = null;

    const monthDayMatch = raw.match(/(\d+)月(\d+)日/);
    if (monthDayMatch) {
        month = Number.parseInt(monthDayMatch[1], 10);
        day = Number.parseInt(monthDayMatch[2], 10);
    } else {
        const dayMatch = raw.match(/(\d+)日/);
        if (dayMatch && defaultMonth !== null) {
            month = Number(defaultMonth);
            day = Number.parseInt(dayMatch[1], 10);
        }
    }

    if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) {
        return null;
    }

    const candidate = `${currentYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return isValidDateString(candidate) ? candidate : null;
}

function parseHolidayText(year, text) {
    const lines = String(text ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const holidays = [];

    for (const line of lines) {
        const entryMatch = line.match(/^(?:[一二三四五六七八九十](?:．|、))(.+?)[:：](.+)$/);
        if (!entryMatch) {
            continue;
        }

        const holiday = {
            name: entryMatch[1].trim(),
            startDate: null,
            endDate: null,
            daysOff: null,
            workAdjustmentDates: [],
        };
        const detailsPart = entryMatch[2].trim();

        const daysOffMatch = detailsPart.match(/共\s*(\d+)\s*天/);
        if (daysOffMatch) {
            holiday.daysOff = Number.parseInt(daysOffMatch[1], 10);
        } else if (detailsPart.includes('放假1天')) {
            holiday.daysOff = 1;
        }

        const dateRangePattern = /(\d+月\d+日)(?:[（(][^）)]*[）)]?\s*)?(?:至(?:[（(][^）)]*[）)]?\s*)?(\d+月\d+日|\d+日))?/g;
        const rangeMatch = [...detailsPart.matchAll(dateRangePattern)];

        if (rangeMatch.length > 0) {
            const firstMatch = rangeMatch[0];
            const rawStartDate = firstMatch[1];
            holiday.startDate = parseDate(rawStartDate, year);

            const startMonthMatch = rawStartDate.match(/(\d+)月/);
            const defaultMonthForEndDate = startMonthMatch ? Number.parseInt(startMonthMatch[1], 10) : null;
            holiday.endDate = firstMatch[2]
                ? parseDate(firstMatch[2], year, defaultMonthForEndDate)
                : holiday.startDate;
        } else {
            const singleDateMatch = detailsPart.match(/(\d+月\d+日)(?:[（(][^）)]*[）)])?/);
            if (singleDateMatch) {
                holiday.startDate = parseDate(singleDateMatch[1], year);
                holiday.endDate = holiday.startDate;
            }
        }

        if (holiday.daysOff === null && holiday.startDate && holiday.endDate) {
            holiday.daysOff = diffDaysInclusive(holiday.startDate, holiday.endDate);
        }

        const workAdjustmentPattern = String.raw`(\d+月\d+日)(?:[（(][^）)]*[）)])?`;
        const workAdjustmentPhrases = [...detailsPart.matchAll(
            new RegExp(`(${workAdjustmentPattern}(?:、\\s*${workAdjustmentPattern})*)\\s*上班`, 'g')
        )];

        for (const phraseMatch of workAdjustmentPhrases) {
            const rawWorkDates = [...phraseMatch[1].matchAll(/(\d+月\d+日)/g)];
            for (const dateMatch of rawWorkDates) {
                const parsedWorkDate = parseDate(dateMatch[1], year);
                if (parsedWorkDate && !holiday.workAdjustmentDates.includes(parsedWorkDate)) {
                    holiday.workAdjustmentDates.push(parsedWorkDate);
                }
            }
        }

        holidays.push(normalizeHolidayRecord(holiday));
    }

    return holidays.filter(Boolean);
}

function buildClientInitialData(items) {
    return items.map((item) => ({
        year: item.year,
        data: JSON.stringify(item.parsedData, null, 2),
    }));
}

function generateClientScriptContent(initialHolidayData, isUserLoggedIn) {
    const safeInitialHolidayData = JSON.stringify(initialHolidayData)
        .replace(/<\//g, '<\\/')
        .replace(/<!--/g, '<\\!--')
        .replace(/<script/gi, '<\\u0073cript');

    return `
        (function() {
            function escapeHtml(text) {
                const value = String(text ?? '');
                const map = { '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#039;' };
                return value.replace(/[&<>"']/g, function(char) { return map[char]; });
            }

            function showMessage(el, type, text) {
                el.className = 'message ' + type;
                el.textContent = text;
                el.style.display = 'block';
            }

            function hideMessage(el) {
                el.textContent = '';
                el.style.display = 'none';
            }

            function prettyJsonString(jsonString) {
                try {
                    return JSON.stringify(JSON.parse(jsonString), null, 2);
                } catch (error) {
                    return jsonString;
                }
            }

            let allHolidayData = ${safeInitialHolidayData};
            const isUserLoggedIn = ${isUserLoggedIn};

            const addHolidayModal = document.getElementById('addHolidayModal');
            const showAddModalBtn = document.getElementById('showAddModalBtn');
            const closeAddModalBtn = document.getElementById('closeAddModal');
            const modalHolidayForm = document.getElementById('modalHolidayForm');
            const modalFormMessage = document.getElementById('modalFormMessage');
            const holidayTableBody = document.getElementById('holidayTableBody');

            const viewDetailsModal = document.getElementById('viewDetailsModal');
            const closeDetailsModalBtn = document.getElementById('closeDetailsModal');
            const detailJsonContentTextarea = document.getElementById('detailJsonContentTextarea');
            const detailHolidayYear = document.getElementById('detailHolidayYear');
            const editJsonBtn = document.getElementById('editJsonBtn');
            const saveEditedJsonBtn = document.getElementById('saveEditedJsonBtn');
            const editJsonMessage = document.getElementById('editJsonMessage');

            function sortHolidayData() {
                allHolidayData.sort(function(a, b) {
                    return Number.parseInt(b.year, 10) - Number.parseInt(a.year, 10);
                });
            }

            function getHolidayEntry(year) {
                return allHolidayData.find(function(item) { return item.year === year; }) || null;
            }

            function upsertHolidayEntry(entry) {
                const index = allHolidayData.findIndex(function(item) { return item.year === entry.year; });
                if (index === -1) {
                    allHolidayData.push(entry);
                } else {
                    allHolidayData[index] = entry;
                }
            }

            function generateTableRowHtml(item) {
                const summary = escapeHtml(item.data.substring(0, 100)) + (item.data.length > 100 ? '...' : '');
                const deleteButtonHtml = isUserLoggedIn
                    ? '<button class="delete-btn" data-year="' + item.year + '">删除</button>'
                    : '';

                return [
                    '<tr>',
                    '  <td>' + escapeHtml(item.year) + '</td>',
                    '  <td><span class="json-summary" title="' + escapeHtml(item.data) + '">' + summary + '</span></td>',
                    '  <td>',
                    '      <div class="operation-buttons">',
                    '          <button class="view-details-btn" data-year="' + escapeHtml(item.year) + '">查看详情</button>',
                    '          ' + deleteButtonHtml,
                    '      </div>',
                    '  </td>',
                    '</tr>'
                ].join('');
            }

            function renderHolidayTable() {
                sortHolidayData();
                holidayTableBody.innerHTML = allHolidayData.map(generateTableRowHtml).join('');
            }

            function openAddModal() {
                hideMessage(modalFormMessage);
                document.getElementById('modalYear').value = new Date().getFullYear();
                document.getElementById('modalHolidayText').value = '';
                addHolidayModal.classList.add('is-active');
            }

            function closeAddModal() {
                addHolidayModal.classList.remove('is-active');
                hideMessage(modalFormMessage);
            }

            function updateDetailModalButtons(editing) {
                if (!isUserLoggedIn) {
                    editJsonBtn.style.display = 'none';
                    saveEditedJsonBtn.style.display = 'none';
                    return;
                }
                editJsonBtn.style.display = editing ? 'none' : 'inline-block';
                saveEditedJsonBtn.style.display = editing ? 'inline-block' : 'none';
            }

            function closeDetailsModal() {
                viewDetailsModal.classList.remove('is-active');
                detailHolidayYear.textContent = '';
                detailJsonContentTextarea.value = '';
                detailJsonContentTextarea.readOnly = true;
                updateDetailModalButtons(false);
                hideMessage(editJsonMessage);
            }

            function openDetailsModal(yearToView) {
                const dataEntry = getHolidayEntry(yearToView);
                if (!dataEntry) {
                    alert('未找到该年份的节假日数据。');
                    return;
                }

                detailHolidayYear.textContent = yearToView;
                detailJsonContentTextarea.value = prettyJsonString(dataEntry.data);
                detailJsonContentTextarea.readOnly = true;
                updateDetailModalButtons(false);
                hideMessage(editJsonMessage);
                viewDetailsModal.classList.add('is-active');
            }

            async function requestJson(url, options) {
                const response = await fetch(url, options);
                let payload = null;
                try {
                    payload = await response.json();
                } catch (error) {
                    payload = null;
                }
                return { response: response, payload: payload };
            }

            renderHolidayTable();
            showAddModalBtn.style.display = isUserLoggedIn ? 'inline-block' : 'none';

            showAddModalBtn.addEventListener('click', function() {
                if (!isUserLoggedIn) {
                    alert('请先登录以设置节假日。');
                    return;
                }
                openAddModal();
            });

            closeAddModalBtn.addEventListener('click', closeAddModal);
            closeDetailsModalBtn.addEventListener('click', closeDetailsModal);

            window.addEventListener('click', function(event) {
                if (event.target === addHolidayModal) {
                    closeAddModal();
                }
                if (event.target === viewDetailsModal) {
                    closeDetailsModal();
                }
            });

            modalHolidayForm.addEventListener('submit', async function(e) {
                e.preventDefault();
                if (!isUserLoggedIn) {
                    showMessage(modalFormMessage, 'error', '未登录，无法保存。请先登录。');
                    setTimeout(function() { window.location.href = '/login'; }, 1500);
                    return;
                }

                const year = document.getElementById('modalYear').value;
                const holidayText = document.getElementById('modalHolidayText').value;
                hideMessage(modalFormMessage);

                try {
                    const result = await requestJson('/save', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ year: year, holidayText: holidayText })
                    });

                    if (result.response.status === 401) {
                        showMessage(modalFormMessage, 'error', '保存失败：未授权，请重新登录。');
                        setTimeout(function() { window.location.href = '/login'; }, 1500);
                        return;
                    }

                    if (!result.response.ok || !result.payload || !result.payload.success) {
                        throw new Error((result.payload && result.payload.message) || '保存失败');
                    }

                    upsertHolidayEntry({
                        year: String(year),
                        data: JSON.stringify(result.payload.parsedData, null, 2)
                    });
                    renderHolidayTable();
                    showMessage(modalFormMessage, 'success', '节假日信息保存成功！');
                    setTimeout(function() {
                        closeAddModal();
                    }, 300);
                } catch (error) {
                    showMessage(modalFormMessage, 'error', '保存失败: ' + error.message);
                }
            });

            holidayTableBody.addEventListener('click', async function(e) {
                const target = e.target;
                if (!(target instanceof HTMLElement)) {
                    return;
                }

                if (target.classList.contains('view-details-btn')) {
                    openDetailsModal(target.dataset.year);
                    return;
                }

                if (target.classList.contains('delete-btn')) {
                    if (!isUserLoggedIn) {
                        alert('请先登录以删除此项。');
                        return;
                    }

                    const yearToDelete = target.dataset.year;
                    if (!confirm('确定要删除 ' + yearToDelete + ' 年的节假日信息吗？')) {
                        return;
                    }

                    try {
                        const result = await requestJson('/delete', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ year: yearToDelete })
                        });

                        if (result.response.status === 401) {
                            alert('删除失败：未授权，请重新登录。');
                            window.location.href = '/login';
                            return;
                        }

                        if (!result.response.ok || !result.payload || !result.payload.success) {
                            throw new Error((result.payload && result.payload.message) || '删除失败');
                        }

                        allHolidayData = allHolidayData.filter(function(item) { return item.year !== yearToDelete; });
                        renderHolidayTable();
                        alert(yearToDelete + ' 年节假日信息删除成功！');
                    } catch (error) {
                        alert('删除失败: ' + error.message);
                    }
                }
            });

            editJsonBtn.addEventListener('click', function() {
                if (!isUserLoggedIn) {
                    alert('请先登录以编辑。');
                    return;
                }
                detailJsonContentTextarea.readOnly = false;
                updateDetailModalButtons(true);
                showMessage(editJsonMessage, 'info', '您正在编辑当前年份的原始JSON数据。请确保格式正确。');
                detailJsonContentTextarea.focus();
            });

            saveEditedJsonBtn.addEventListener('click', async function() {
                if (!isUserLoggedIn) {
                    alert('请先登录以保存。');
                    return;
                }

                const yearToEdit = detailHolidayYear.textContent;
                const editedJsonString = detailJsonContentTextarea.value;
                hideMessage(editJsonMessage);

                try {
                    JSON.parse(editedJsonString);
                    const result = await requestJson('/save_edited_json', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ year: yearToEdit, editedJsonString: editedJsonString })
                    });

                    if (result.response.status === 401) {
                        showMessage(editJsonMessage, 'error', '保存失败：未授权，请重新登录。');
                        setTimeout(function() { window.location.href = '/login'; }, 1500);
                        return;
                    }

                    if (!result.response.ok || !result.payload || !result.payload.success) {
                        throw new Error((result.payload && result.payload.message) || '保存失败');
                    }

                    upsertHolidayEntry({
                        year: yearToEdit,
                        data: JSON.stringify(result.payload.parsedData, null, 2)
                    });
                    renderHolidayTable();
                    showMessage(editJsonMessage, 'success', 'JSON数据保存成功！');
                    setTimeout(function() {
                        closeDetailsModal();
                    }, 200);
                } catch (error) {
                    showMessage(editJsonMessage, 'error', '保存失败: JSON格式错误或 ' + error.message);
                }
            });
        })();
    `;
}

async function loadAdminPageData(env) {
    const kvKeys = await env.HOLIDAYS_KV.list();
    const yearsData = [];

    for (const key of kvKeys.keys) {
        if (!key.name?.startsWith(HOLIDAY_KEY_PREFIX)) {
            continue;
        }

        const year = key.name.slice(HOLIDAY_KEY_PREFIX.length);
        if (!isValidYear(year)) {
            continue;
        }

        try {
            const parsedData = await getHolidayDataByYear(env, year);
            if (parsedData) {
                yearsData.push({ year, parsedData });
            }
        } catch (error) {
            console.error(`Error loading holiday data for ${year}:`, error);
        }
    }

    yearsData.sort((a, b) => Number.parseInt(b.year, 10) - Number.parseInt(a.year, 10));
    return yearsData;
}

async function handleAdminPage(request, env) {
    const userIsLoggedIn = await isLoggedIn(request);
    const yearsData = await loadAdminPageData(env);
    const systemSetting = await getSystemSettings(env);
    const allCallCounters = systemSetting.call_counters && typeof systemSetting.call_counters === 'object'
        ? systemSetting.call_counters
        : {};

    let dynamicStatsEntriesHtml = '';
    for (const [apiName, count] of Object.entries(allCallCounters)) {
        const displayPath = `/${apiName.startsWith('open/') ? '' : 'open/'}${apiName}`;
        dynamicStatsEntriesHtml += `
                <div class="stats-entry">
                    <code class="api-name">${workerEscapeHtml(displayPath)}</code>
                    <span class="api-colon">:</span>
                    <div class="api-count-wrapper">
                        <span class="api-count">${workerEscapeHtml(String(count))}</span>
                        <span class="api-unit">次</span>
                    </div>
                </div>
            `;
    }

    const authActionsHtml = userIsLoggedIn
        ? `
            <div class="auth-actions">
                <a href="/settings" class="auth-link" id="settingsBtn">设置</a>
                <a href="/logout" class="auth-link">登出</a>
            </div>
        `
        : '<a href="/login" class="auth-link">登录</a>';

    const clientScriptContent = generateClientScriptContent(buildClientInitialData(yearsData), userIsLoggedIn);

    const html = `
  <!DOCTYPE html>
  <html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>节假日管理</title>
    <link rel="icon" type="image/png" href="${FAVICON_URL}">
    <link rel="shortcut icon" href="${FAVICON_URL}">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif; margin: 0; background-color: #f4f7f6; color: #333;
            display: flex;
            justify-content: center;
            align-items: flex-start;
            min-height: 100vh;
            padding: 20px;
            box-sizing: border-box;
        }
        .main-wrapper {
            display: flex;
            justify-content: space-between;
            gap: 20px;
            max-width: 1200px;
            width: 100%;
            align-items: flex-start;
        }
        .stats-sidebar {
            flex-shrink: 0;
            width: 300px;
            background-color: #fff;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
            position: sticky;
            top: 20px;
        }
        .stats-sidebar h2 {
            color: #0056b3;
            padding-bottom: 0;
            margin-bottom: 10px;
            font-size: 1.3em;
        }
        .stats-line {
            height: 1px;
            background-color: #e0e0e0;
            margin: 10px 0 10px 0;
        }
        .stats-entry {
            display: grid;
            grid-template-columns: minmax(min-content, 180px) max-content 1fr;
            align-items: center;
            margin-bottom: 10px;
            font-size: 1em;
            gap: 5px;
        }
        .api-name {
            background-color: #f0f0f0;
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 0.9em;
            color: #555;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .api-colon {
            color: #555;
            text-align: right;
            padding-right: 5px;
        }
        .api-count-wrapper {
            display: flex;
            align-items: center;
            justify-content: flex-end;
        }
        .api-count {
            color: #007bff;
            font-weight: bold;
            font-size: 1.2em;
        }
        .api-unit {
            color: #555;
            font-size: 1em;
            margin-left: 3px;
        }
        .container {
            flex-grow: 1;
            background-color: #fff;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
        }
        h1 { color: #0056b3; border-bottom: 2px solid #e0e0e0; padding-bottom: 10px; margin-bottom: 25px; display: inline-block; }
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
            border-bottom: none;
        }
        .page-header .auth-actions {
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .auth-link {
            font-size: 1.1em;
            color: #007bff;
            text-decoration: none;
            padding: 5px 10px;
            border-radius: 8px;
            transition: background-color 0.2s;
        }
        .auth-link:hover {
            background-color: #e9ecef;
            color: #0056b3;
        }
        .admin-header-section {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 25px;
            border-bottom: 2px solid #e0e0e0;
            padding-bottom: 10px;
        }
        .admin-header-section h2 {
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
            border-radius: 8px;
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
        .delete-btn { background-color: #dc3545; border-radius: 8px; }
        .delete-btn:hover { background-color: #c82333; }
        .delete-btn:disabled {
            background-color: #cccccc;
            cursor: not-allowed;
            transform: none;
        }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { border: 1px solid #eee; padding: 12px; text-align: left; font-size: 15px; vertical-align: middle; }
        th:nth-child(1), td:nth-child(1) { width: 10%; min-width: 70px; text-align: center; }
        th:nth-child(2), td:nth-child(2) { width: 60%; min-width: 250px; }
        th:nth-child(3), td:nth-child(3) { width: 30%; min-width: 180px; text-align: center; }
        tbody tr:hover {
            background-color: #f9f9f9;
        }
        .json-summary {
            display: block;
            max-width: 100%;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-family: monospace;
            font-size: 0.85em;
            color: #555;
            padding: 2px 0;
        }
        .operation-buttons {
            display: flex;
            justify-content: center;
            gap: 10px;
            flex-wrap: nowrap;
        }
        .operation-buttons .view-details-btn {
            background-color: #6c757d;
            padding: 8px 12px;
            font-size: 14px;
            min-width: 80px;
            border-radius: 8px;
        }
        .operation-buttons .view-details-btn:hover {
            background-color: #5a6268;
        }
        .operation-buttons .delete-btn {
            padding: 8px 12px;
            font-size: 14px;
            min-width: 80px;
            margin-left: 0;
            border-radius: 8px;
        }
        .modal {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            overflow: auto;
            background-color: rgba(0,0,0,0.4);
            justify-content: center;
            align-items: center;
        }
        .modal.is-active { display: flex; }
        .modal-content {
            background-color: #fefefe;
            margin: auto;
            padding: 30px;
            border: 1px solid #888;
            border-radius: 10px;
            width: 80%;
            max-width: 600px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.3);
            position: relative;
        }
        .modal-details {
            max-width: 800px;
            width: 90%;
            padding-bottom: 20px;
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
            width: 100%;
            box-sizing: border-box;
        }
        .modal-content input[type="number"] { width: 100px; }
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
        .message.info { background-color: #d1ecf1; color: #0c5460; border-color: #bee5eb; }
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
        .json-editor[readonly] {
            cursor: default;
            background-color: #f0f0f0;
        }
        .modal-actions-group {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            margin-top: 5px;
        }
        #editJsonBtn {
            background-color: #ffc107;
            color: #fff;
        }
        #editJsonBtn:hover {
            background-color: #e0a800;
            transform: translateY(-1px);
        }
        #saveEditedJsonBtn {
            background-color: #28a745;
            color: #fff;
        }
        #saveEditedJsonBtn:hover {
            background-color: #218838;
            transform: translateY(-1px);
        }
        @media (max-width: 900px) {
            .main-wrapper {
                flex-direction: column;
                align-items: center;
            }
            .stats-sidebar {
                width: 90%;
                max-width: 500px;
                position: static;
                margin-bottom: 20px;
                order: 1;
            }
            .container {
                width: 90%;
                order: 0;
            }
            .page-header .auth-actions {
                gap: 5px;
            }
        }
    </style>
  </head>
  <body>
    <div class="main-wrapper">
        <div class="container">
            <div class="page-header">
                <h1>节假日信息管理系统</h1>
                ${authActionsHtml}
            </div>

            <div class="admin-header-section">
                <h2>已保存节假日数据</h2>
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
                <tbody id="holidayTableBody"></tbody>
            </table>
        </div>

        <div class="stats-sidebar">
            <h2>API 调用统计</h2>
            <div class="stats-line"></div>
            ${dynamicStatsEntriesHtml}
            <div class="stats-line"></div>
        </div>
    </div>

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

    <div id="viewDetailsModal" class="modal">
        <div class="modal-content modal-details">
            <span class="close-button" id="closeDetailsModal">&times;</span>
            <h2>节假日详细信息 (<span id="detailHolidayYear"></span> 年)</h2>
            <textarea id="detailJsonContentTextarea" class="json-editor" readonly></textarea>
            <div id="editJsonMessage" class="message" style="display:none; margin-top: 5px;"></div>
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

    return htmlResponse(html);
}

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
            border-radius: 8px;
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

async function handleLogin(request, env) {
    if (request.method === 'GET') {
        const url = new URL(request.url);
        const errorMessage = url.searchParams.get('error') ? '用户名或密码不正确。' : '';
        return htmlResponse(loginPageHtml(errorMessage));
    }

    if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    const formData = await request.formData();
    const username = String(formData.get('username') ?? '');
    const password = String(formData.get('password') ?? '');

    if (username !== env.USERNAME || password !== env.PASSWORD) {
        return redirectResponse('/login?error=1', request.url);
    }

    return redirectResponse('/', request.url, {
        'Set-Cookie': createAuthCookie(request, true),
        ...getNoCacheHeaders(),
    });
}

async function handleLogout(request) {
    return redirectResponse('/', request.url, {
        'Set-Cookie': createAuthCookie(request, false),
        ...getNoCacheHeaders(),
    });
}

async function readRequestJson(request) {
    try {
        return await request.json();
    } catch (error) {
        throw new Error('请求体必须为合法 JSON。');
    }
}

async function handleSaveHoliday(request, env) {
    try {
        const { year, holidayText } = await readRequestJson(request);
        const normalizedYear = String(year ?? '').trim();
        const normalizedText = String(holidayText ?? '').trim();

        if (!isValidYear(normalizedYear) || !normalizedText) {
            return jsonResponse({ success: false, message: '年份必须为四位数字，且节假日信息不能为空。' }, 400);
        }

        const parsedHolidaysArray = parseHolidayText(normalizedYear, normalizedText);
        const savedData = await saveHolidayDataByYear(env, normalizedYear, parsedHolidaysArray);

        return jsonResponse({
            success: true,
            message: '数据保存成功。',
            parsedData: savedData,
        });
    } catch (error) {
        console.error('保存节假日数据时发生错误:', error);
        return jsonResponse({ success: false, message: `保存失败: ${error.message}` }, 500);
    }
}

async function handleDeleteHoliday(request, env) {
    try {
        const { year } = await readRequestJson(request);
        const normalizedYear = String(year ?? '').trim();
        if (!isValidYear(normalizedYear)) {
            return jsonResponse({ success: false, message: '年份不能为空且必须为四位数字。' }, 400);
        }

        await env.HOLIDAYS_KV.delete(buildHolidayKvKey(normalizedYear));
        return jsonResponse({ success: true, message: '数据删除成功。' });
    } catch (error) {
        console.error('删除节假日数据时发生错误:', error);
        return jsonResponse({ success: false, message: `删除失败: ${error.message}` }, 500);
    }
}

async function handleSaveEditedJson(request, env) {
    try {
        const { year, editedJsonString } = await readRequestJson(request);
        const normalizedYear = String(year ?? '').trim();
        const normalizedJsonString = String(editedJsonString ?? '').trim();

        if (!isValidYear(normalizedYear) || !normalizedJsonString) {
            return jsonResponse({ success: false, message: '年份必须为四位数字，且编辑后的JSON数据不能为空。' }, 400);
        }

        let parsedData;
        try {
            parsedData = normalizeHolidayArray(JSON.parse(normalizedJsonString));
        } catch (error) {
            return jsonResponse({ success: false, message: `JSON格式错误: ${error.message}` }, 400);
        }

        const savedData = await saveHolidayDataByYear(env, normalizedYear, parsedData);
        return jsonResponse({ success: true, message: 'JSON数据保存成功！', parsedData: savedData });
    } catch (error) {
        console.error('保存编辑后的JSON数据时发生错误:', error);
        return jsonResponse({ success: false, message: `保存失败: ${error.message}` }, 500);
    }
}

async function updateCallCounter(env, apiName) {
    try {
        const systemSetting = await getSystemSettings(env);
        if (!systemSetting.call_counters || typeof systemSetting.call_counters !== 'object') {
            systemSetting.call_counters = {};
        }
        systemSetting.call_counters[apiName] = (systemSetting.call_counters[apiName] || 0) + 1;
        await saveSystemSettings(env, systemSetting);
    } catch (error) {
        console.error(`Error updating system_setting in KV for ${apiName} call counter:`, error);
    }
}

async function getTimeZone(env) {
    try {
        const systemSetting = await getSystemSettings(env);
        return systemSetting.time_zone || DEFAULT_TIME_ZONE;
    } catch (error) {
        console.error('Error reading time_zone from KV:', error);
        return DEFAULT_TIME_ZONE;
    }
}

async function getCurrentDateInTimeZone(env) {
    const tz = await getTimeZone(env);
    const formatter = new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone: tz,
    });
    const parts = formatter.formatToParts(new Date());

    let year = '';
    let month = '';
    let day = '';

    for (const part of parts) {
        if (part.type === 'year') year = part.value;
        if (part.type === 'month') month = part.value;
        if (part.type === 'day') day = part.value;
    }

    return {
        currentDate: `${year}-${month}-${day}`,
        currentYear: year,
        currentMonth: `${year}-${month}`,
    };
}

function getFilteredTimeZones() {
    const filteredTimeZonesMap = new Map();

    for (const tz of TIME_ZONES) {
        if (PREFERRED_TIME_ZONES[tz.offset] === tz.value) {
            filteredTimeZonesMap.set(tz.offset, tz);
        }
    }

    for (const tz of TIME_ZONES) {
        if (!filteredTimeZonesMap.has(tz.offset)) {
            filteredTimeZonesMap.set(tz.offset, tz);
        }
    }

    return Array.from(filteredTimeZonesMap.values()).sort((a, b) => a.offset - b.offset);
}

function settingsPageHtml(currentTimeZone, message = '', messageType = '') {
    const messageHtml = message
        ? `<div class="message ${messageType}" style="display:block; margin-top: 20px;">${workerEscapeHtml(message)}</div>`
        : '';

    const optionsHtml = getFilteredTimeZones()
        .map((tz) => `<option value="${tz.value}" ${tz.value === currentTimeZone ? 'selected' : ''}>${tz.label}</option>`)
        .join('');

    return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>系统设置 - 节假日信息管理系统</title>
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
              border-radius: 8px;
              box-sizing: border-box;
              font-size: 1.05em;
              appearance: none;
              background-color: #f8f8f8;
              cursor: pointer;
              background-image: url('data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%3E%3Cpath%20fill%3D%22%23333%22%20d%3D%22M6%209L0%203h12z%22%2F%3E%3C%2Fsvg%3E');
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
                gap: 20px;
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

async function handleSettings(request, env) {
    let currentTimeZone = await getTimeZone(env);
    let message = '';
    let messageType = '';

    if (request.method === 'POST') {
        try {
            const formData = await request.formData();
            const newTimeZone = String(formData.get('timeZone') ?? '').trim();
            if (!newTimeZone) {
                message = '未选择时区。';
                messageType = 'error';
            } else {
                const systemSetting = await getSystemSettings(env);
                systemSetting.time_zone = newTimeZone;
                await saveSystemSettings(env, systemSetting);
                currentTimeZone = newTimeZone;
                message = '设置已保存成功！';
                messageType = 'success';
            }
        } catch (error) {
            console.error('保存设置时发生错误:', error);
            message = `保存失败: ${error.message}`;
            messageType = 'error';
        }
    }

    return htmlResponse(settingsPageHtml(currentTimeZone, message, messageType));
}

async function handleDateInfo(request, env) {
    const url = new URL(request.url);
    let dateParam = url.searchParams.get('date');

    if (!dateParam) {
        const { currentDate } = await getCurrentDateInTimeZone(env);
        dateParam = currentDate;
    }

    if (!isValidDateString(dateParam)) {
        return jsonResponse({ message: '日期格式不正确，应为 YYYY-MM-DD。' }, 400);
    }

    const requestedDate = dateParam;
    const year = requestedDate.slice(0, 4);
    const tz = await getTimeZone(env);
    const requestedDateObj = createUtcDate(requestedDate);
    const dayOfWeekEnglish = requestedDateObj.toLocaleString('en-US', { weekday: 'long', timeZone: tz });
    const humanReadableWeek = WEEK_DAYS_CHINESE_MAP[dayOfWeekEnglish] || '';

    let isWorkDay = 1;
    let isOfficialHoliday = 0;
    let isWorkAdjustmentDay = 0;
    let holidayName = '';

    let holidaysConfig = [];
    try {
        holidaysConfig = await getHolidayDataByYear(env, year) || [];
    } catch (error) {
        return jsonResponse({ message: error.message }, 500);
    }

    for (const holidayEntry of holidaysConfig) {
        if (holidayEntry.workAdjustmentDates?.includes(requestedDate)) {
            isWorkDay = 1;
            isWorkAdjustmentDay = 1;
            holidayName = `调休上班 (原${holidayEntry.name})`;
            await updateCallCounter(env, 'dateInfo');
            return jsonResponse({
                date: requestedDate,
                week: humanReadableWeek,
                isWorkDay,
                isOfficialHoliday,
                isWorkAdjustmentDay,
                holidayName,
            });
        }
    }

    if (dayOfWeekEnglish === 'Saturday' || dayOfWeekEnglish === 'Sunday') {
        isWorkDay = 0;
        holidayName = '周末';
    }

    for (const holidayEntry of holidaysConfig) {
        if (!holidayEntry.startDate || !holidayEntry.endDate) continue;

        const start = createUtcDate(holidayEntry.startDate);
        const end = createUtcDate(holidayEntry.endDate);
        const current = createUtcDate(requestedDate);

        if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && current >= start && current <= end) {
            isWorkDay = 0;
            isOfficialHoliday = 1;
            holidayName = holidayEntry.name;
            break;
        }
    }

    await updateCallCounter(env, 'dateInfo');
    return jsonResponse({
        date: requestedDate,
        week: humanReadableWeek,
        isWorkDay,
        isOfficialHoliday,
        isWorkAdjustmentDay,
        holidayName,
    });
}

async function handleYearInfo(request, env) {
    const url = new URL(request.url);
    let yearParam = url.searchParams.get('year');

    if (!yearParam) {
        const { currentYear } = await getCurrentDateInTimeZone(env);
        yearParam = currentYear;
    }

    if (!isValidYear(yearParam)) {
        return jsonResponse({ message: '年份格式不正确，应为四位数字 (YYYY)。' }, 400);
    }

    try {
        const holidaysConfig = await getHolidayDataByYear(env, yearParam);
        if (!holidaysConfig) {
            return jsonResponse({ message: `未找到 ${yearParam} 年的节假日数据。` }, 404);
        }
        await updateCallCounter(env, 'yearInfo');
        return jsonResponse(holidaysConfig);
    } catch (error) {
        return jsonResponse({ message: error.message }, 500);
    }
}

async function handleMonthInfo(request, env) {
    const url = new URL(request.url);
    let monthParam = url.searchParams.get('month');

    if (!monthParam) {
        const { currentMonth } = await getCurrentDateInTimeZone(env);
        monthParam = currentMonth;
    }

    if (!isValidMonthString(monthParam)) {
        return jsonResponse({ message: '月份格式不正确，应为 YYYY-MM。' }, 400);
    }

    const [year, monthString] = monthParam.split('-');
    const month = Number.parseInt(monthString, 10);

    try {
        const holidaysConfig = await getHolidayDataByYear(env, year);
        if (!holidaysConfig) {
            return jsonResponse({ message: `未找到 ${year} 年的节假日数据，因此无法获取 ${monthParam} 月份的数据。` }, 404);
        }

        const filteredHolidays = [];
        const targetMonthStartUTC = new Date(Date.UTC(Number.parseInt(year, 10), month - 1, 1, 0, 0, 0, 0));
        const targetMonthEndUTC = new Date(Date.UTC(Number.parseInt(year, 10), month, 0, 23, 59, 59, 999));

        for (const holiday of holidaysConfig) {
            if (!holiday.startDate || !holiday.endDate) {
                continue;
            }

            const holidayStart = createUtcDate(holiday.startDate);
            const holidayEnd = createUtcDate(holiday.endDate);
            if (Number.isNaN(holidayStart.getTime()) || Number.isNaN(holidayEnd.getTime())) {
                continue;
            }

            const overlaps = holidayStart <= targetMonthEndUTC && holidayEnd >= targetMonthStartUTC;
            if (overlaps) {
                filteredHolidays.push(holiday);
            }
        }

        await updateCallCounter(env, 'monthInfo');
        return jsonResponse(filteredHolidays);
    } catch (error) {
        return jsonResponse({ message: error.message }, 500);
    }
}
