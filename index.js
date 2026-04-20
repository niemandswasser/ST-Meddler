/**
 * ST-Meddler — расширение SillyTavern
 * Плавающий персонаж, который комментирует ваш РП
 */

import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    generateQuietPrompt,
    getRequestHeaders,
} from '../../../../script.js';

import {
    extension_settings,
    getContext,
} from '../../../extensions.js';

const MODULE_NAME = 'st_meddler';
const DEBUG_PREFIX = '[ST-Meddler]';

const defaultSettings = {
    enabled: true,
    // Источник личности
    characterSource: 'card',    // 'card' | 'custom'
    characterId: null,          // индекс карточки ST
    characterName: '',          // имя (из карточки или вручную)
    characterAvatar: '',        // файл аватара карточки ST
    personalityText: '',        // кастомная личность (когда characterSource === 'custom')
    // Источник изображения
    imageSource: 'card',        // 'card' | 'upload' | 'none'
    spriteData: '',             // base64 PNG (когда imageSource === 'upload')
    frequency: 5,
    frequencyLocked: false,
    messageCount: 0,
    widgetPosition: { x: 20, y: 20 },
    widgetMinimized: false,
    language: 'russian',
    maxContextMessages: 10,
    contextLocked: false,
    autoShow: true,
    commentaryStyle: 'snarky',  // snarky | supportive | analytical | chaotic | custom
    customTone: '',
    displayMode: 'widget',
    uiTheme: 'soft',            // soft | pink | lavender | mint | night | custom
    uiAvatarSize: 'medium',     // small | medium | large | custom
    uiAvatarSizeCustom: 80,     // px, when uiAvatarSize === 'custom'
    uiAvatarStyle: 'circle',    // 'circle' | 'full'
    uiBubblePosition: 'right',  // right | left | top | bottom
    uiBubbleWidth: 220,
    uiOpacity: 100,
    sleepMode: false,
    sleepTimeout: 8,
    systemPrompt: '',
    commentaryLength: 'short',  // short | medium | long
    uiCustomColors: {
        primary: '#b0c4de',
        secondary: '#e8eef5',
        accent: '#7a9cc0',
        text: '#3a4a5c',
    },
    uiTickerSpeed: 50,
    uiTickerAlwaysScroll: true,
    quickApiEnabled: false,
    quickApiUrl: '',
    quickApiKey: '',
    quickApiModel: '',
    chatHistoryLimit: 10,
    // Профиль подключения ST — меддлер шлёт запрос на нём, не трогая активный профиль таверны
    connectionProfile: '',
    // Показывать плашку с активной моделью рядом с аватаром
    showActiveModel: false,
    // Пер-чат сохранение истории: { [chatKey]: { updatedAt, messages: [{role, content, ts}] } }
    perChatHistory: {},
};

// Лимиты пер-чат хранилища
const PER_CHAT_MSG_LIMIT = 100;   // макс. реплик на чат
const PER_CHAT_CHATS_LIMIT = 20;  // макс. чатов суммарно (старые авто-обрезаются)

// Цветовые темы
const UI_THEMES = {
    soft:     { primary: '#b0c4de', secondary: '#e8eef5', accent: '#7a9cc0', text: '#3a4a5c', name: '🩶 Нейтральная' },
    pink:     { primary: '#f0a0b0', secondary: '#fce8ec', accent: '#d07080', text: '#5a3a42', name: '🌸 Розовая' },
    lavender: { primary: '#a090c8', secondary: '#e4def8', accent: '#7060a8', text: '#3a2a58', name: '💜 Лаванда' },
    mint:     { primary: '#7abfa0', secondary: '#d8f0e8', accent: '#4a9a78', text: '#1a4030', name: '🌿 Мята' },
    peach:    { primary: '#d4a070', secondary: '#f8ead8', accent: '#b07840', text: '#4a2a10', name: '🍑 Персик' },
    night:    { primary: '#5858a0', secondary: '#18182a', accent: '#8888d0', text: '#c8c8f0', name: '🌙 Ночь' },
    custom:   { name: '🎨 Свой цвет' },
};


const AVATAR_SIZES = { small: 55, medium: 70, large: 90 };

const LANGUAGES = {
    russian: { name: '🇷🇺 Русский', instruction: 'Отвечай на русском языке.' },
    english: { name: '🇺🇸 English',  instruction: 'Respond in English.' },
};

const COMMENTARY_STYLES = {
    snarky:     'Тон: Остроумный, слегка саркастичный, развлекательный, но не злобный.',
    supportive: 'Тон: Восторженный, ободряющий, поддерживающий участников.',
    analytical: 'Тон: Наблюдательный, проницательный, фокусируется на нарративных выборах.',
    chaotic:    'Тон: Непредсказуемый, юмористический, абсурдный, ломающий четвёртую стену.',
    custom:     '',
};

// =====================================
// Состояние
// =====================================
let meddler = {
    widget: null,
    bar: null,
    isDragging: false,
    wasDragging: false,
    dragOffset: { x: 0, y: 0 },
    dragStartPos: { x: 0, y: 0 },
    lastCommentary: '',
    lastBarMessage: '',
    isGenerating: false,
    recentChatNames: [],
    lastTriggerTime: 0,
    chatJustChanged: false,
    sleepTimer: null,
    pendingBarText: null,
    /** @type {Array<any>} */
    chatHistory: [],
};

// =====================================
// Настройки
// =====================================
function loadSettings() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }
    // Миграция со старого spriteType
    const s = extension_settings[MODULE_NAME];
    if (s.spriteType !== undefined) {
        if (!s.imageSource) s.imageSource = s.spriteType === 'custom' ? 'upload' : 'card';
        if (!s.characterSource) s.characterSource = 'card';
        delete s.spriteType;
    }
}

function getSettings() { return extension_settings[MODULE_NAME]; }
function saveSettings() { saveSettingsDebounced(); }

// =====================================
// Пер-чат история (персистентная)
// =====================================

/** Ключ текущего ST-чата (chatId + характер). null, если чат ещё не открыт. */
function getCurrentChatKey() {
    try {
        const ctx = SillyTavern.getContext();
        const chatId = ctx.chatId || ctx.getCurrentChatId?.();
        if (!chatId) return null;
        const charPart = ctx.characterId != null ? `:char${ctx.characterId}` : (ctx.groupId ? `:grp${ctx.groupId}` : '');
        return `${chatId}${charPart}`;
    } catch {
        return null;
    }
}

function getPerChatStore() {
    const s = getSettings();
    if (!s.perChatHistory || typeof s.perChatHistory !== 'object') s.perChatHistory = {};
    return s.perChatHistory;
}

/** Загрузить историю текущего чата из хранилища в meddler.chatHistory. */
function loadChatHistoryForCurrentChat() {
    const key = getCurrentChatKey();
    if (!key) { meddler.chatHistory = []; return; }
    const store = getPerChatStore();
    const entry = store[key];
    meddler.chatHistory = Array.isArray(entry?.messages) ? entry.messages.slice() : [];
}

/** Сохранить текущий meddler.chatHistory в хранилище для текущего чата + авто-обрезка. */
function persistChatHistoryForCurrentChat() {
    const key = getCurrentChatKey();
    if (!key) return;
    const store = getPerChatStore();
    /** @type {Array<any>} */
    const trimmed = meddler.chatHistory.slice(-PER_CHAT_MSG_LIMIT);
    if (trimmed.length === 0) {
        delete store[key];
    } else {
        store[key] = { updatedAt: Date.now(), messages: trimmed };
    }
    // Авто-обрезка старых чатов
    const keys = Object.keys(store);
    if (keys.length > PER_CHAT_CHATS_LIMIT) {
        keys
            .map(k => ({ k, t: store[k]?.updatedAt || 0 }))
            .sort((a, b) => a.t - b.t)
            .slice(0, keys.length - PER_CHAT_CHATS_LIMIT)
            .forEach(({ k }) => { delete store[k]; });
    }
    saveSettings();
}

/**
 * Записать одно сообщение в постоянную историю и сохранить.
 * @param {'user'|'assistant'} role
 * @param {string} content
 */
function pushPersistentMessage(role, content) {
    if (!content) return;
    meddler.chatHistory.push(/** @type {any} */ ({ role, content, ts: Date.now() }));
    if (meddler.chatHistory.length > PER_CHAT_MSG_LIMIT) {
        meddler.chatHistory.splice(0, meddler.chatHistory.length - PER_CHAT_MSG_LIMIT);
    }
    persistChatHistoryForCurrentChat();
}

/** Перерисовать панель истории из meddler.chatHistory (в обратном порядке — новые сверху). */
function rerenderHistoryPanel() {
    /** @type {Array<any>} */
    const items = meddler.chatHistory.slice().reverse();
    /** @type {Array<HTMLElement|null>} */
    const containers = [meddler.widget, meddler.bar];
    containers.forEach(el => {
        if (!el) return;
        const h = el.querySelector('.meddler-history');
        if (!h) return;
        h.innerHTML = '';
        for (const m of items) {
            const item = document.createElement('div');
            item.className = m.role === 'user' ? 'meddler-history-item user-msg' : 'meddler-history-item';
            const p = document.createElement('p');
            p.textContent = m.content;
            item.appendChild(p);
            h.appendChild(item);
        }
    });
}

// =====================================
// Слэш-команды / профили
// =====================================
async function executeSlashCommand(command) {
    try {
        const context = SillyTavern.getContext();
        if (context.executeSlashCommandsWithOptions) {
            const result = await context.executeSlashCommandsWithOptions(command, {
                handleExecutionErrors: false,
                handleParserErrors: false,
            });
            return result?.pipe || '';
        }
    } catch (e) { console.error(DEBUG_PREFIX, e); }
    return '';
}


// =====================================
// Quick API — прямые запросы, ST не трогаем
// =====================================
// Низкоуровневый POST в OpenAI-совместимый endpoint
async function postQuickApi(messages, max_tokens) {
    const settings = getSettings();
    const base = settings.quickApiUrl.replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (settings.quickApiKey) headers['Authorization'] = `Bearer ${settings.quickApiKey}`;

    const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: settings.quickApiModel, messages, max_tokens, temperature: 0.9 }),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${text ? ': ' + text.slice(0, 120) : ''}`);
    }

    const json = await res.json();
    return json.choices?.[0]?.message?.content?.trim() || '';
}

// Прямой запрос к OpenAI-совместимому endpoint
async function generateWithQuickApi(prompt) {
    const settings = getSettings();
    const maxTokensMap = { short: 100, medium: 250, long: 500 };
    const max_tokens = maxTokensMap[settings.commentaryLength] || 100;

    // Если задан системный промт — разбиваем на system+user, иначе всё в user
    let messages;
    if (settings.systemPrompt?.trim()) {
        const langInstruction = LANGUAGES[settings.language]?.instruction || LANGUAGES.russian.instruction;
        const lengthMap = { short: '1–2 предложения', medium: '3–5 предложений', long: '6–8 предложений' };
        const context = getContext();
        const recentMessages = context.chat?.slice(-settings.maxContextMessages) || [];
        meddler.recentChatNames = [];
        const chatLog = recentMessages.map(msg => {
            const name = msg.is_user ? 'Пользователь' : (msg.name || 'Персонаж');
            if (!meddler.recentChatNames.includes(name)) meddler.recentChatNames.push(name);
            return `[${name}]: ${msg.mes}`;
        }).join('\n\n');
        messages = [
            { role: 'system', content: settings.systemPrompt.trim() },
            { role: 'user', content: `### ЖУРНАЛ РП\n${chatLog}\n\n(Длина: ${lengthMap[settings.commentaryLength] || lengthMap.short}. ${langInstruction} Только реплика, без описания действий.)` },
        ];
    } else {
        messages = [{ role: 'user', content: prompt }];
    }

    return postQuickApi(messages, max_tokens);
}

async function fetchQuickApiModels() {
    const settings = getSettings();
    const btn     = document.getElementById('meddler-quickapi-fetch-models');
    const hint    = document.getElementById('meddler-models-hint');
    const select  = document.getElementById('meddler-quickapi-model-select');

    if (!settings.quickApiUrl) {
        if (hint) { hint.textContent = '⚠️ Сначала введите URL API'; hint.style.display = 'block'; }
        return;
    }

    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; }
    if (hint) { hint.textContent = 'Загружаю...'; hint.style.display = 'block'; }

    try {
        const headers = {};
        if (settings.quickApiKey) headers['Authorization'] = `Bearer ${settings.quickApiKey}`;
        const res = await fetch(`${settings.quickApiUrl.replace(/\/+$/, '')}/models`, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const models = (json.data || json.models || []).map(m => m.id || m).filter(Boolean).sort();

        if (select) {
            select.innerHTML = '<option value="">— выберите модель —</option>';
            models.forEach(id => {
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = id;
                if (settings.quickApiModel === id) opt.selected = true;
                select.appendChild(opt);
            });
        }
        if (hint) { hint.textContent = `✓ ${models.length} моделей загружено`; hint.style.display = 'block'; }
    } catch (e) {
        if (hint) { hint.textContent = `✗ ${e.message}`; hint.style.display = 'block'; }
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-rotate"></i>'; }
    }
}

function updateQuickApiStatus() {
    const settings = getSettings();
    const el = document.getElementById('meddler-quickapi-status');
    if (!el) return;
    if (!settings.quickApiEnabled) { el.innerHTML = '<span class="meddler-status-inactive">Quick API отключён</span>'; return; }
    if (!settings.quickApiUrl) { el.innerHTML = '<span class="meddler-status-warning">⚠️ Введите URL API</span>'; return; }
    if (!settings.quickApiModel) { el.innerHTML = '<span class="meddler-status-warning">⚠️ Введите название модели</span>'; return; }
    el.innerHTML = `<span class="meddler-status-active">✓ ${settings.quickApiUrl} → <strong>${settings.quickApiModel}</strong></span>`;
}

async function connectQuickApi() {
    const settings = getSettings();
    if (!settings.quickApiEnabled) { alert('Сначала включите Quick API!'); return; }
    if (!settings.quickApiUrl) { alert('Введите URL API!'); return; }
    if (!settings.quickApiModel) { alert('Введите название модели!'); return; }

    const btn = document.getElementById('meddler-quickapi-connect');
    const orig = btn?.innerHTML;
    try {
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Проверка...'; }
        const headers = {};
        if (settings.quickApiKey) headers['Authorization'] = `Bearer ${settings.quickApiKey}`;
        const res = await fetch(`${settings.quickApiUrl.replace(/\/+$/, '')}/models`, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (btn) { btn.innerHTML = '<i class="fa-solid fa-check"></i> Доступен!'; }
        setTimeout(() => { if (btn) { btn.innerHTML = orig; btn.disabled = false; } }, 2000);
    } catch (e) {
        if (btn) { btn.innerHTML = '<i class="fa-solid fa-xmark"></i> Ошибка'; setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2000); }
        alert(`Не удалось подключиться: ${e.message}`);
    }
}

// =====================================
// Профиль подключения ST — изолированный запрос
// =====================================
// Маппинг profile.api → ключ секрета (api_key_<source>). Перекрытия — где имя секрета не совпадает.
/** @type {Record<string, string>} */
const PROFILE_API_TO_SECRET_KEY = {
    'oai': 'api_key_openai',
    'google': 'api_key_makersuite',
    'openrouter-text': 'api_key_openrouter',
    'kcpp': 'api_key_koboldcpp',
    'oobabooga': 'api_key_ooba',
    'textgenerationwebui': 'api_key_ooba',
};

/** @param {string | undefined | null} apiName */
function profileApiToSecretKey(apiName) {
    if (!apiName) return null;
    const lower = String(apiName).toLowerCase();
    if (PROFILE_API_TO_SECRET_KEY[lower]) return PROFILE_API_TO_SECRET_KEY[lower];
    return `api_key_${lower}`;
}

/**
 * Читаем состояние секретов и возвращаем id активного секрета для ключа.
 * @param {string} secretKey
 * @returns {Promise<string|null>}
 */
async function getActiveSecretId(secretKey) {
    try {
        const res = await fetch('/api/secrets/read', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        if (!res.ok) return null;
        const state = await res.json();
        const arr = state?.[secretKey];
        if (!Array.isArray(arr)) return null;
        const active = arr.find(/** @param {any} s */ s => s?.active);
        return active?.id || null;
    } catch {
        return null;
    }
}

/**
 * Прямой POST в /api/secrets/rotate — без UI-событий (в отличие от rotateSecret из secrets.js).
 * @param {string} secretKey
 * @param {string} secretId
 */
async function rotateSecretServerOnly(secretKey, secretId) {
    try {
        const res = await fetch('/api/secrets/rotate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ key: secretKey, id: secretId }),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/** @param {string} profileName */
function getConnectionProfile(profileName) {
    if (!profileName) return null;
    try {
        const context = SillyTavern.getContext();
        const cm = context.extensionSettings?.connectionManager;
        if (!cm?.profiles?.length) return null;
        return cm.profiles.find(/** @param {any} p */ p => p.name === profileName) || null;
    } catch {
        return null;
    }
}

/** @param {any} resp */
function extractTextFromProfileResponse(resp) {
    if (!resp) return null;
    if (typeof resp === 'string') return resp;
    if (Array.isArray(resp)) {
        const texts = resp.filter(/** @param {any} b */ b => b?.type === 'text' && typeof b.text === 'string').map(/** @param {any} b */ b => b.text);
        if (texts.length) return texts.join('\n');
    }
    if (resp.content !== undefined && resp.content !== null) {
        if (typeof resp.content === 'string') return resp.content;
        if (Array.isArray(resp.content)) {
            const texts = resp.content.filter(/** @param {any} b */ b => b?.type === 'text' && typeof b.text === 'string').map(/** @param {any} b */ b => b.text);
            if (texts.length) return texts.join('\n');
        }
    }
    if (resp.choices?.[0]?.message?.content) {
        const c = resp.choices[0].message.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) {
            const texts = c.filter(/** @param {any} b */ b => b?.type === 'text' && typeof b.text === 'string').map(/** @param {any} b */ b => b.text);
            if (texts.length) return texts.join('\n');
        }
    }
    if (typeof resp.text === 'string') return resp.text;
    if (typeof resp.message === 'string') return resp.message;
    if (resp.message?.content && typeof resp.message.content === 'string') return resp.message.content;
    return null;
}

/**
 * @param {string} prompt
 * @param {number} max_tokens
 */
async function generateWithConnectionProfile(prompt, max_tokens) {
    const settings = getSettings();
    const context = SillyTavern.getContext();
    if (!context.ConnectionManagerRequestService) {
        throw new Error('ConnectionManagerRequestService недоступен');
    }
    const profile = getConnectionProfile(settings.connectionProfile);
    if (!profile) throw new Error(`Профиль "${settings.connectionProfile}" не найден`);

    const messages = [{ role: 'user', content: prompt }];

    // Подхватываем авторизацию профиля. ConnectionManagerRequestService сам secret-id не применяет —
    // бэкенд читает активный секрет для source. Временно переключаем активный секрет на тот,
    // что указан в профиле, и восстанавливаем в finally. Прямой POST в /api/secrets/rotate
    // не шлёт клиентских событий (не дёргает #main_api change → нет переподключения ST).
    const profileSecretId = profile['secret-id'] || null;
    const secretKey = profileApiToSecretKey(profile.api);
    let previousSecretId = null;
    let rotated = false;

    if (profileSecretId && secretKey) {
        try {
            previousSecretId = await getActiveSecretId(secretKey);
            if (previousSecretId !== profileSecretId) {
                rotated = await rotateSecretServerOnly(secretKey, profileSecretId);
                if (!rotated) console.warn(DEBUG_PREFIX, `Не удалось активировать secret-id профиля (${secretKey}). Используется активный секрет ST.`);
            }
        } catch (e) {
            console.warn(DEBUG_PREFIX, 'Ошибка подмены секрета:', e);
        }
    }

    try {
        const response = await context.ConnectionManagerRequestService.sendRequest(
            profile.id,
            messages,
            max_tokens,
            {
                stream: false,
                extractData: true,
                includePreset: true,
                includeInstruct: true,
            },
        );

        const text = extractTextFromProfileResponse(response);
        if (text == null) throw new Error('Неверный формат ответа API');
        return text.trim();
    } finally {
        if (rotated && previousSecretId && secretKey) {
            await rotateSecretServerOnly(secretKey, previousSecretId).catch(() => {});
        }
    }
}

function populateProfileDropdown() {
    const select = document.getElementById('meddler-profile-select');
    if (!select) return;
    const settings = getSettings();
    select.innerHTML = '<option value="">— Использовать активный в ST —</option>';
    try {
        const context = SillyTavern.getContext();
        const cm = context.extensionSettings?.connectionManager;
        const profiles = cm?.profiles || [];
        profiles.forEach(p => {
            if (!p?.name) return;
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = p.name;
            if (settings.connectionProfile === p.name) opt.selected = true;
            select.appendChild(opt);
        });
    } catch (e) {
        console.warn(DEBUG_PREFIX, 'Ошибка загрузки профилей:', e);
    }
    updateProfileStatus();
}

function getActiveModelLabel() {
    const settings = getSettings();
    if (settings.quickApiEnabled && settings.quickApiUrl && settings.quickApiModel) {
        return { source: '⚡', name: settings.quickApiModel };
    }
    if (settings.connectionProfile) {
        const p = getConnectionProfile(settings.connectionProfile);
        if (p) return { source: '🧩', name: p.model || p.name || '?' };
    }
    try {
        const context = SillyTavern.getContext();
        const cm = context.extensionSettings?.connectionManager;
        const activeId = cm?.selectedProfile;
        const activeProfile = cm?.profiles?.find(/** @param {any} p */ p => p.id === activeId);
        if (activeProfile) return { source: 'ST', name: activeProfile.model || activeProfile.name || '?' };
    } catch {}
    return { source: 'ST', name: '—' };
}

function updateActiveModelBadge() {
    const settings = getSettings();
    const show = !!settings.showActiveModel;
    const { source, name } = getActiveModelLabel();
    const text = `${source} ${name}`;
    /** @type {Array<HTMLElement|null>} */
    const containers = [meddler.widget, meddler.bar];
    containers.forEach(el => {
        if (!el) return;
        const badge = /** @type {HTMLElement|null} */ (el.querySelector('.meddler-model-badge'));
        if (!badge) return;
        badge.style.display = show ? '' : 'none';
        badge.setAttribute('title', `Активная модель: ${name}`);
        const label = badge.querySelector('.meddler-model-badge-text');
        if (label) label.textContent = text;
    });
}

function updateProfileStatus() {
    const settings = getSettings();
    const el = document.getElementById('meddler-profile-status');
    if (!el) return;
    if (!settings.connectionProfile) {
        el.innerHTML = '<span class="meddler-status-inactive">Профиль не задан — используется активный в ST</span>';
        return;
    }
    const profile = getConnectionProfile(settings.connectionProfile);
    if (!profile) {
        el.innerHTML = `<span class="meddler-status-warning">⚠️ Профиль «${settings.connectionProfile}» не найден</span>`;
        return;
    }
    const details = [profile.api, profile.model].filter(Boolean).join(' · ');
    el.innerHTML = `<span class="meddler-status-active">✓ <strong>${profile.name}</strong>${details ? ' — ' + details : ''}</span>`;
}

// =====================================
// Тема UI
// =====================================
function applyUITheme() {
    const settings = getSettings();
    const widget = meddler.widget;
    if (!widget) return;

    const colors = settings.uiTheme === 'custom' ? settings.uiCustomColors : (UI_THEMES[settings.uiTheme] || UI_THEMES.soft);
    widget.style.setProperty('--kb-primary',   colors.primary);
    widget.style.setProperty('--kb-secondary', colors.secondary);
    widget.style.setProperty('--kb-accent',    colors.accent);
    widget.style.setProperty('--kb-text',      colors.text);

    const avatarSize = settings.uiAvatarSize === 'custom'
        ? (parseInt(settings.uiAvatarSizeCustom) || 80)
        : (AVATAR_SIZES[settings.uiAvatarSize] || AVATAR_SIZES.medium);
    widget.style.setProperty('--kb-avatar-size',   `${avatarSize}px`);
    widget.style.setProperty('--kb-bubble-offset', `${avatarSize + 10}px`);

    widget.classList.toggle('avatar-full', settings.uiAvatarStyle === 'full');

    widget.classList.remove('bubble-right', 'bubble-left', 'bubble-top', 'bubble-bottom');
    widget.classList.add(`bubble-${settings.uiBubblePosition}`);

    widget.style.setProperty('--kb-opacity', settings.uiOpacity / 100);
    widget.style.setProperty('--kb-bubble-width', `${settings.uiBubbleWidth ?? 220}px`);
}

function applyBarTheme() {
    const settings = getSettings();
    const bar = meddler.bar;
    if (!bar) return;
    const colors = settings.uiTheme === 'custom' ? settings.uiCustomColors : (UI_THEMES[settings.uiTheme] || UI_THEMES.soft);
    bar.style.setProperty('--kb-primary',   colors.primary);
    bar.style.setProperty('--kb-secondary', colors.secondary);
    bar.style.setProperty('--kb-accent',    colors.accent);
    bar.style.setProperty('--kb-text',      colors.text);
    bar.style.setProperty('--kb-opacity',   settings.uiOpacity / 100);
}

// =====================================
// Источник изображения
// =====================================
function getAvatarSource() {
    const settings = getSettings();
    if (settings.imageSource === 'upload' && settings.spriteData) {
        return settings.spriteData;
    }
    if (settings.imageSource === 'card' && settings.characterAvatar) {
        return `/characters/${encodeURIComponent(settings.characterAvatar)}`;
    }
    return '';
}

// =====================================
// Виджет
// =====================================
function createWidget() {
    if (meddler.widget) meddler.widget.remove();
    const settings = getSettings();

    const widget = document.createElement('div');
    widget.id = 'meddler-widget';
    widget.className = settings.widgetMinimized ? 'minimized' : '';

    widget.innerHTML = `
        <div class="meddler-avatar-bubble">
            <img class="meddler-avatar" src="" alt="Meddler" draggable="false" />
            <div class="meddler-avatar-placeholder">
                <i class="fa-solid fa-ghost"></i>
            </div>
            <div class="meddler-notification-dot"></div>
            <div class="meddler-model-badge" style="display:none;">
                <span class="meddler-model-badge-text"></span>
            </div>
        </div>
        <div class="meddler-speech-bubble">
            <div class="meddler-speech-content">
                <p class="meddler-text">Нажми на меня~</p>
            </div>
            <div class="meddler-speech-tail"></div>
            <div class="meddler-bubble-actions">
                <button class="meddler-bubble-regen" title="Перегенерировать">🔃</button>
                <button class="meddler-bubble-close" title="Закрыть">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        </div>
        <div class="meddler-typing-bubble">
            <div class="meddler-typing">
                <span class="dot"></span><span class="dot"></span><span class="dot"></span>
            </div>
            <div class="meddler-speech-tail"></div>
        </div>
        <div class="meddler-panel">
            <div class="meddler-panel-header">
                <div class="meddler-panel-title">
                    <span class="meddler-name">Meddler</span>
                    <span class="meddler-subtitle">наблюдает...</span>
                </div>
                <div class="meddler-panel-controls">
                    <button class="meddler-btn meddler-panel-clear" title="Очистить">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                    <button class="meddler-btn meddler-panel-close" title="Закрыть">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
            <div class="meddler-panel-body">
                <div class="meddler-history">
                    <div class="meddler-history-item"><p>Выбери персонажа в настройках~</p></div>
                </div>
            </div>
            <div class="meddler-chat-input-row">
                <input type="text" class="meddler-chat-input" placeholder="Спросить..." maxlength="500" />
                <button class="meddler-chat-send" title="Отправить"><i class="fa-solid fa-paper-plane"></i></button>
            </div>
            <div class="meddler-panel-footer">
                <div class="meddler-status-row">
                    <span class="meddler-status-icon">◉</span>
                    <span class="meddler-status">Жду...</span>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(widget);
    meddler.widget = widget;
    widget.style.left = `${settings.widgetPosition.x}px`;
    widget.style.top  = `${settings.widgetPosition.y}px`;
    applyUITheme();
    updateWidgetCharacter();
    setupWidgetEvents();
    updateActiveModelBadge();
    if (meddler.chatHistory.length === 0) loadChatHistoryForCurrentChat();
    rerenderHistoryPanel();
    if (settings.sleepMode) sleepWidget();
}

function createBar() {
    if (meddler.bar) meddler.bar.remove();

    const bar = document.createElement('div');
    bar.id = 'meddler-bar';

    bar.innerHTML = `
        <div class="meddler-bar-avatar">
            <img class="meddler-bar-avatar-img" src="" alt="" />
            <div class="meddler-bar-avatar-placeholder"><i class="fa-solid fa-ghost"></i></div>
            <div class="meddler-model-badge" style="display:none;">
                <span class="meddler-model-badge-text"></span>
            </div>
        </div>
        <div class="meddler-bar-content">
            <span class="meddler-bar-name">Meddler</span>
            <span class="meddler-bar-separator">:</span>
            <div class="meddler-bar-text-container">
                <span class="meddler-bar-text">Жду начала РП~</span>
            </div>
        </div>
        <div class="meddler-bar-typing">
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        </div>
        <button class="meddler-bar-regen-btn" title="Перегенерировать">🔃</button>
        <div class="meddler-bar-panel">
            <div class="meddler-bar-panel-inner">
                <div class="meddler-panel-header">
                    <div class="meddler-panel-title">
                        <span class="meddler-name">Meddler</span>
                        <span class="meddler-subtitle">наблюдает...</span>
                    </div>
                    <div class="meddler-panel-controls">
                        <button class="meddler-btn meddler-panel-clear" title="Очистить"><i class="fa-solid fa-trash-can"></i></button>
                        <button class="meddler-btn meddler-panel-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>
                <div class="meddler-panel-body">
                    <div class="meddler-history">
                        <div class="meddler-history-item"><p>Выбери персонажа в настройках~</p></div>
                    </div>
                </div>
                <div class="meddler-chat-input-row">
                    <input type="text" class="meddler-chat-input" placeholder="Спросить..." maxlength="500" />
                    <button class="meddler-chat-send" title="Отправить"><i class="fa-solid fa-paper-plane"></i></button>
                </div>
                <div class="meddler-panel-footer">
                    <div class="meddler-status-row">
                        <span class="meddler-status-icon">◉</span>
                        <span class="meddler-status">Жду...</span>
                    </div>
                </div>
            </div>
        </div>
    `;

    const qrBar = document.getElementById('qr--bar');
    const sendForm = document.getElementById('send_form');
    const inputArea = document.getElementById('form_sheld');

    if (qrBar?.parentNode) {
        qrBar.parentNode.insertBefore(bar, qrBar);
    } else if (sendForm?.parentNode) {
        sendForm.parentNode.insertBefore(bar, sendForm);
    } else if (inputArea) {
        inputArea.insertBefore(bar, inputArea.firstChild);
    } else {
        document.body.appendChild(bar);
        Object.assign(bar.style, { position: 'fixed', bottom: '120px', left: '0', right: '0', padding: '6px 15px' });
    }

    meddler.bar = bar;
    applyBarTheme();
    updateBarCharacter();
    setupBarEvents();
    updateActiveModelBadge();
    if (meddler.chatHistory.length === 0) loadChatHistoryForCurrentChat();
    rerenderHistoryPanel();
}

// =====================================
// Обновление персонажа
// =====================================
function setAvatarEl(imgEl, placeholderEl, src, fallbackAvatar) {
    if (src) {
        imgEl.src = src;
        imgEl.style.display = 'block';
        if (placeholderEl) placeholderEl.style.display = 'none';
        imgEl.onerror = function() {
            if (fallbackAvatar) {
                this.src = `/thumbnail?type=avatar&file=${encodeURIComponent(fallbackAvatar)}`;
                this.onerror = function() {
                    this.style.display = 'none';
                    if (placeholderEl) placeholderEl.style.display = 'flex';
                };
            } else {
                this.style.display = 'none';
                if (placeholderEl) placeholderEl.style.display = 'flex';
            }
        };
    } else {
        imgEl.src = '';
        imgEl.style.display = 'none';
        if (placeholderEl) placeholderEl.style.display = 'flex';
    }
}

function updateWidgetCharacter() {
    const settings = getSettings();
    const widget = meddler.widget;
    if (!widget) return;

    const src = getAvatarSource();
    const fallback = settings.imageSource === 'card' ? settings.characterAvatar : '';
    setAvatarEl(
        widget.querySelector('.meddler-avatar'),
        widget.querySelector('.meddler-avatar-placeholder'),
        src, fallback
    );

    const nameEl = widget.querySelector('.meddler-name');
    if (nameEl) nameEl.textContent = settings.characterName || 'Meddler';
}

function updateBarCharacter() {
    const settings = getSettings();
    const bar = meddler.bar;
    if (!bar) return;

    const src = getAvatarSource();
    const fallback = settings.imageSource === 'card' ? settings.characterAvatar : '';
    setAvatarEl(
        bar.querySelector('.meddler-bar-avatar-img'),
        bar.querySelector('.meddler-bar-avatar-placeholder'),
        src, fallback
    );

    const displayName = settings.characterName || 'Meddler';
    const nameEl = bar.querySelector('.meddler-bar-name');
    const panelNameEl = bar.querySelector('.meddler-bar-panel .meddler-name');
    if (nameEl) nameEl.textContent = displayName;
    if (panelNameEl) panelNameEl.textContent = displayName;
}

// =====================================
// Превью изображения в настройках
// =====================================
function updateSpritePreview() {
    const settings = getSettings();
    const previewImg = document.getElementById('meddler-sprite-preview-img');
    const previewPh  = document.getElementById('meddler-sprite-preview-placeholder');
    if (!previewImg) return;

    const src = getAvatarSource();
    if (src) {
        previewImg.src = src;
        previewImg.style.display = 'block';
        if (previewPh) previewPh.style.display = 'none';
    } else {
        previewImg.style.display = 'none';
        if (previewPh) previewPh.style.display = 'flex';
    }
}

// =====================================
// События виджета
// =====================================
function setupWidgetEvents() {
    const widget = meddler.widget;
    if (!widget) return;

    const avatarBubble  = widget.querySelector('.meddler-avatar-bubble');
    const bubbleClose   = widget.querySelector('.meddler-bubble-close');
    const bubbleRegen   = widget.querySelector('.meddler-bubble-regen');
    const panelClose    = widget.querySelector('.meddler-panel-close');
    const panelClear    = widget.querySelector('.meddler-panel-clear');
    const speechBubble  = widget.querySelector('.meddler-speech-bubble');

    bubbleRegen?.addEventListener('click', (e) => { e.stopPropagation(); generateCommentary(true); });

    avatarBubble.addEventListener('mousedown', startDrag);
    avatarBubble.addEventListener('touchstart', startDragTouch, { passive: false });
    document.addEventListener('mousemove', drag);
    document.addEventListener('touchmove', dragTouch, { passive: false });
    document.addEventListener('mouseup', stopDrag);
    document.addEventListener('touchend', stopDrag);

    avatarBubble.addEventListener('click', () => {
        if (meddler.wasDragging) { meddler.wasDragging = false; return; }
        if (widget.classList.contains('panel-open')) {
            widget.classList.remove('panel-open');
        } else if (widget.classList.contains('has-speech')) {
            widget.classList.add('panel-open');
        } else {
            generateCommentary(true);
        }
    });

    avatarBubble.addEventListener('dblclick', (e) => { e.preventDefault(); openSettingsPanel(); });

    if (speechBubble) {
        speechBubble.addEventListener('click', (e) => {
            if (e.target === bubbleClose || bubbleClose?.contains(e.target)) return;
            widget.classList.add('panel-open');
        });
    }

    bubbleClose?.addEventListener('click', (e) => { e.stopPropagation(); hideSpeechBubble(); });
    panelClose?.addEventListener('click', () => widget.classList.remove('panel-open'));
    panelClear?.addEventListener('click', () => {
        meddler.chatHistory = [];
        persistChatHistoryForCurrentChat();
        rerenderHistoryPanel();
    });

    const chatInput = widget.querySelector('.meddler-chat-input');
    const chatSend  = widget.querySelector('.meddler-chat-send');
    const sendChat = () => {
        const q = chatInput?.value?.trim();
        if (!q) return;
        chatInput.value = '';
        generateChatReply(q);
    };
    chatSend?.addEventListener('click', (e) => { e.stopPropagation(); sendChat(); });
    chatInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    chatInput?.addEventListener('click', (e) => e.stopPropagation());

    document.addEventListener('click', (e) => {
        if (widget.classList.contains('panel-open') && !widget.contains(e.target)) {
            widget.classList.remove('panel-open');
        }
    });
}

function showSpeechBubble() {
    const widget = meddler.widget;
    if (!widget) return;
    wakeWidget();
    widget.classList.remove('panel-open');
    widget.classList.add('has-speech', 'speech-new');
    const dot = widget.querySelector('.meddler-notification-dot');
    dot?.classList.add('visible');
    setTimeout(() => { widget.classList.remove('speech-new'); dot?.classList.remove('visible'); }, 3000);
    scheduleSleep();
}

function hideSpeechBubble() {
    meddler.widget?.classList.remove('has-speech', 'speech-new');
}

function sleepWidget() {
    const widget = meddler.widget;
    if (!widget) return;
    widget.classList.remove('has-speech', 'speech-new', 'panel-open');
    widget.classList.add('sleeping');
}

function wakeWidget() {
    const widget = meddler.widget;
    if (!widget) return;
    widget.classList.remove('sleeping');
}

function scheduleSleep() {
    const settings = getSettings();
    if (!settings.sleepMode || settings.displayMode !== 'widget') return;
    if (meddler.sleepTimer) clearTimeout(meddler.sleepTimer);
    meddler.sleepTimer = setTimeout(() => {
        sleepWidget();
        meddler.sleepTimer = null;
    }, (settings.sleepTimeout || 8) * 1000);
}

// =====================================
// Drag
// =====================================
function startDrag(e) {
    meddler.isDragging = true; meddler.wasDragging = false;
    const rect = meddler.widget.getBoundingClientRect();
    meddler.dragStartPos = { x: e.clientX, y: e.clientY };
    meddler.dragOffset  = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    meddler.widget.classList.add('dragging');
}
function startDragTouch(e) {
    const t = e.touches[0]; meddler.isDragging = true; meddler.wasDragging = false;
    const rect = meddler.widget.getBoundingClientRect();
    meddler.dragStartPos = { x: t.clientX, y: t.clientY };
    meddler.dragOffset  = { x: t.clientX - rect.left, y: t.clientY - rect.top };
    meddler.widget.classList.add('dragging');
}
function drag(e) {
    if (!meddler.isDragging) return;
    if (Math.abs(e.clientX - meddler.dragStartPos.x) > 5 || Math.abs(e.clientY - meddler.dragStartPos.y) > 5)
        meddler.wasDragging = true;
    meddler.widget.style.left = `${Math.max(0, Math.min(window.innerWidth  - 80, e.clientX - meddler.dragOffset.x))}px`;
    meddler.widget.style.top  = `${Math.max(0, Math.min(window.innerHeight - 80, e.clientY - meddler.dragOffset.y))}px`;
}
function dragTouch(e) {
    if (!meddler.isDragging) return;
    e.preventDefault();
    const t = e.touches[0];
    if (Math.abs(t.clientX - meddler.dragStartPos.x) > 5 || Math.abs(t.clientY - meddler.dragStartPos.y) > 5)
        meddler.wasDragging = true;
    meddler.widget.style.left = `${Math.max(0, Math.min(window.innerWidth  - 80, t.clientX - meddler.dragOffset.x))}px`;
    meddler.widget.style.top  = `${Math.max(0, Math.min(window.innerHeight - 80, t.clientY - meddler.dragOffset.y))}px`;
}
function stopDrag() {
    if (!meddler.isDragging) return;
    meddler.isDragging = false;
    meddler.widget.classList.remove('dragging');
    const settings = getSettings();
    settings.widgetPosition = { x: parseInt(meddler.widget.style.left), y: parseInt(meddler.widget.style.top) };
    saveSettings();
}

// =====================================
// Бар
// =====================================
function setupBarEvents() {
    const bar = meddler.bar;
    if (!bar) return;

    const avatar = bar.querySelector('.meddler-bar-avatar');
    avatar?.addEventListener('click', (e) => { e.stopPropagation(); toggleBarPanel(); });
    avatar?.addEventListener('touchend', (e) => {
        e.preventDefault(); e.stopPropagation(); toggleBarPanel();
        if (navigator.vibrate) navigator.vibrate(50);
    });

    bar.querySelector('.meddler-bar-regen-btn')?.addEventListener('click', (e) => { e.stopPropagation(); generateCommentary(true); });
    bar.querySelector('.meddler-bar-regen-btn')?.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); generateCommentary(true); });

    bar.querySelector('.meddler-panel-close')?.addEventListener('click', (e) => { e.stopPropagation(); closeBarPanel(); });
    bar.querySelector('.meddler-panel-clear')?.addEventListener('click', (e) => {
        e.stopPropagation();
        meddler.chatHistory = [];
        meddler.lastBarMessage = '';
        persistChatHistoryForCurrentChat();
        rerenderHistoryPanel();
    });

    const chatInput = bar.querySelector('.meddler-chat-input');
    const chatSend  = bar.querySelector('.meddler-chat-send');
    const sendChat = () => {
        const q = chatInput?.value?.trim();
        if (!q) return;
        chatInput.value = '';
        generateChatReply(q);
    };
    chatSend?.addEventListener('click', (e) => { e.stopPropagation(); sendChat(); });
    chatInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    chatInput?.addEventListener('click', (e) => e.stopPropagation());

    document.addEventListener('click', (e) => {
        if (bar.classList.contains('panel-open') && !bar.contains(e.target)) closeBarPanel();
    });
}

function positionBarPanel() {
    const bar = meddler.bar; if (!bar) return;
    const panel = bar.querySelector('.meddler-bar-panel'); if (!panel) return;
    const rect = bar.getBoundingClientRect();
    const padding = 10; const panelW = 300; const panelH = 350;

    ['bottom','top','left','right','transform'].forEach(p => panel.style.removeProperty(p));

    if (rect.top >= panelH + padding || rect.top > window.innerHeight - rect.bottom) {
        panel.style.bottom = 'calc(100% + 8px)';
    } else {
        panel.style.top = 'calc(100% + 8px)';
    }

    const cx = rect.left + rect.width / 2;
    if (cx - panelW / 2 < padding) { panel.style.left = `${padding - rect.left}px`; }
    else if (cx + panelW / 2 > window.innerWidth - padding) { panel.style.right = `${rect.right - window.innerWidth + padding}px`; }
    else { panel.style.left = '50%'; panel.style.transform = 'translateX(-50%)'; }
}

function toggleBarPanel() { meddler.bar?.classList.contains('panel-open') ? closeBarPanel() : openBarPanel(); }
function openBarPanel()  { if (!meddler.bar) return; positionBarPanel(); meddler.bar.classList.add('panel-open'); }
function closeBarPanel() { meddler.bar?.classList.remove('panel-open'); }

function applyBarTickerAnimation() {
    const bar = meddler.bar; if (!bar) return;
    const settings = getSettings();
    const textEl = bar.querySelector('.meddler-bar-text');
    const container = bar.querySelector('.meddler-bar-text-container');
    if (!textEl || !container) return;

    bar.classList.remove('ticker-active');
    textEl.style.removeProperty('animation');
    void textEl.offsetWidth;

    requestAnimationFrame(() => requestAnimationFrame(() => {
        const tw = textEl.scrollWidth, cw = container.clientWidth;
        if (settings.uiTickerAlwaysScroll || tw > cw) {
            const gap = 100, dist = tw + gap;
            bar.style.setProperty('--scroll-duration', `${dist / settings.uiTickerSpeed}s`);
            bar.style.setProperty('--scroll-offset', `-${((tw + gap) / tw * 100).toFixed(1)}%`);
            bar.classList.add('ticker-active');
        }
    }));
}

function applyPendingBarText(textEl) {
    const bar = meddler.bar; if (!bar || !textEl) return;
    const text = meddler.pendingBarText;
    if (text == null) return;
    meddler.pendingBarText = null;
    textEl.textContent = text;
    applyBarTickerAnimation();
    if (text !== meddler.lastBarMessage) {
        meddler.lastBarMessage = text;
        const h = bar.querySelector('.meddler-history');
        if (h) {
            const item = document.createElement('div');
            item.className = 'meddler-history-item new';
            item.innerHTML = `<p>${text}</p>`;
            h.insertBefore(item, h.firstChild);
            const items = h.querySelectorAll('.meddler-history-item');
            if (items.length > 10) items[items.length - 1].remove();
            setTimeout(() => item.classList.remove('new'), 500);
        }
        bar.classList.add('has-new');
        setTimeout(() => bar.classList.remove('has-new'), 500);
    }
}

function updateBarCommentaryText(text) {
    const bar = meddler.bar; if (!bar) return;
    const textEl = bar.querySelector('.meddler-bar-text');
    if (!textEl) return;

    const isScrolling = bar.classList.contains('ticker-active') && !bar.classList.contains('is-typing');

    if (isScrolling) {
        // Queue — apply after current scroll cycle finishes
        meddler.pendingBarText = text;
        if (!textEl._pendingListener) {
            const listener = () => {
                textEl._pendingListener = null;
                applyPendingBarText(textEl);
            };
            textEl._pendingListener = listener;
            textEl.addEventListener('animationiteration', listener, { once: true });
        }
    } else {
        meddler.pendingBarText = null;
        textEl.textContent = text;
        if (!bar.classList.contains('is-typing')) applyBarTickerAnimation();
        if (text !== meddler.lastBarMessage) {
            meddler.lastBarMessage = text;
            const h = bar.querySelector('.meddler-history');
            if (h) {
                const item = document.createElement('div');
                item.className = 'meddler-history-item new';
                item.innerHTML = `<p>${text}</p>`;
                h.insertBefore(item, h.firstChild);
                const items = h.querySelectorAll('.meddler-history-item');
                if (items.length > 10) items[items.length - 1].remove();
                setTimeout(() => item.classList.remove('new'), 500);
            }
            bar.classList.add('has-new');
            setTimeout(() => bar.classList.remove('has-new'), 500);
        }
    }
}

function showBarTypingIndicator(show) {
    const bar = meddler.bar; if (!bar) return;
    if (show) { bar.classList.add('is-typing'); }
    else { bar.classList.remove('is-typing'); requestAnimationFrame(() => requestAnimationFrame(() => applyBarTickerAnimation())); }
}

function updateBarStatus(s) {
    const el = meddler.bar?.querySelector('.meddler-status');
    if (el) el.textContent = s;
}

function switchDisplayMode(mode) {
    const settings = getSettings();
    if (meddler.widget) meddler.widget.style.display = 'none';
    if (meddler.bar)    meddler.bar.style.display = 'none';

    if (mode === 'widget') {
        if (!meddler.widget) createWidget();
        if (settings.enabled) meddler.widget.style.display = 'block';
    } else if (mode === 'bar') {
        if (!meddler.bar) createBar();
        if (settings.enabled) meddler.bar.style.display = 'flex';
        setTimeout(() => applyBarTickerAnimation(), 100);
    }
}

// =====================================
// Текст комментария
// =====================================
function updateCommentaryText(text) {
    const settings = getSettings();
    const widget = meddler.widget;
    if (widget) {
        const speechText = widget.querySelector('.meddler-speech-bubble .meddler-text');
        if (speechText) speechText.textContent = text;

        const h = widget.querySelector('.meddler-history');
        if (h) {
            const item = document.createElement('div');
            item.className = 'meddler-history-item new';
            item.innerHTML = `<p>${text}</p>`;
            h.insertBefore(item, h.firstChild);
            const items = h.querySelectorAll('.meddler-history-item');
            if (items.length > 10) items[items.length - 1].remove();
            setTimeout(() => item.classList.remove('new'), 500);
        }
        if (settings.displayMode === 'widget') showSpeechBubble();
    }
    if (meddler.bar) updateBarCommentaryText(text);
}

function openSettingsPanel() {
    const menu = document.getElementById('extensionsMenu');
    if (menu) {
        menu.click();
        setTimeout(() => document.getElementById('meddler-settings')?.scrollIntoView({ behavior: 'smooth' }), 300);
    }
}

// =====================================
// Персонажи ST
// =====================================
function populateCharacterDropdown() {
    const dropdown = document.getElementById('meddler-character-select');
    if (!dropdown) return;
    const settings = getSettings();
    const chars = getContext().characters || [];

    dropdown.innerHTML = '<option value="">-- Выбрать персонажа --</option>';
    chars.forEach((char, index) => {
        if (!char?.name) return;
        const opt = document.createElement('option');
        opt.value = char.avatar || index;
        opt.textContent = char.name;
        opt.dataset.index = index;
        opt.dataset.avatar = char.avatar || '';
        if (settings.characterAvatar && char.avatar === settings.characterAvatar) opt.selected = true;
        else if (!settings.characterAvatar && settings.characterName && char.name === settings.characterName) opt.selected = true;
        dropdown.appendChild(opt);
    });
}

function onCharacterSelect(e) {
    const settings = getSettings();
    const opt = e.target.selectedOptions[0];

    if (!opt || opt.value === '') {
        settings.characterId = null;
        settings.characterName = '';
        settings.characterAvatar = '';
    } else {
        const chars = getContext().characters || [];
        const idx = parseInt(opt.dataset.index);
        const char = chars[idx];
        if (char) {
            settings.characterId  = idx;
            settings.characterName  = char.name;
            settings.characterAvatar = char.avatar || '';
        }
    }

    updateWidgetCharacter();
    updateBarCharacter();
    updateSpritePreview();
    saveSettings();
}

// =====================================
// Построение промпта
// =====================================
function buildCommentaryPrompt() {
    const settings = getSettings();
    const context = getContext();
    const chars = context.characters || [];

    const recentMessages = context.chat.slice(-settings.maxContextMessages);
    meddler.recentChatNames = [];

    const chatLog = recentMessages.map(msg => {
        const name = msg.is_user ? 'Пользователь' : (msg.name || 'Персонаж');
        if (!meddler.recentChatNames.includes(name)) meddler.recentChatNames.push(name);
        return `[${name}]: ${msg.mes}`;
    }).join('\n\n');

    const lengthMap = { short: '1–2 предложения', medium: '3–5 предложений', long: '6–8 предложений' };
    const lengthRule = lengthMap[settings.commentaryLength] || lengthMap.short;
    const langInstruction = LANGUAGES[settings.language]?.instruction || LANGUAGES.russian.instruction;
    const name = settings.characterName || 'Meddler';

    // Если задан свой системный промт — используем только его
    if (settings.systemPrompt?.trim()) {
        return `${settings.systemPrompt.trim()}

### ЖУРНАЛ РП
${chatLog}

### ОТВЕТ
(Длина: ${lengthRule}. ${langInstruction} Только реплика ${name}, без описания действий):`.trim();
    }

    // Автоматический промт
    let characterPersonality = '';
    if (settings.characterSource === 'custom') {
        characterPersonality = settings.personalityText || '';
    } else {
        if (settings.characterId !== null && chars[settings.characterId]) {
            const char = chars[settings.characterId];
            characterPersonality = char.description || '';
            if (char.personality) characterPersonality += '\n' + char.personality;
        }
    }

    let styleText;
    if (settings.commentaryStyle === 'custom' && settings.customTone) {
        styleText = settings.customTone;
    } else {
        styleText = COMMENTARY_STYLES[settings.commentaryStyle] || COMMENTARY_STYLES.snarky;
    }

    const personaBlock = characterPersonality
        ? `Ты — ${name}.\n[Личность]\n${characterPersonality}`
        : `Ты — ${name}.\n[Стиль]\n${styleText}`;

    return `
### ЛИЧНОСТЬ
${personaBlock}

### ЗАДАЧА
Ты наблюдаешь за журналом ролевой игры ниже как сторонний зритель.
Дай одну короткую реплику в характере своего персонажа, реагируя на происходящее.

### ПРАВИЛА
1. Реагируй согласно своей личности (${name}).
2. НЕ участвуй в ролевой игре.
3. НЕ цитируй диалоги дословно.
4. Длина: ${lengthRule}.
5. ${langInstruction}

### ЖУРНАЛ РП
${chatLog}

### ОТВЕТ
(Как ${name} — только моя реакция):
`.trim();
}

// =====================================
// Промпт болтовни
// =====================================
function buildChatPrompt(question) {
    const settings = getSettings();
    const context = getContext();
    const chars = context.characters || [];

    const recentMessages = context.chat?.slice(-settings.maxContextMessages) || [];
    meddler.recentChatNames = [];
    const chatLog = recentMessages.map(msg => {
        const name = msg.is_user ? 'Пользователь' : (msg.name || 'Персонаж');
        if (!meddler.recentChatNames.includes(name)) meddler.recentChatNames.push(name);
        return `[${name}]: ${msg.mes}`;
    }).join('\n\n');

    const lengthMap = { short: '1–2 предложения', medium: '3–5 предложений', long: '6–8 предложений' };
    const lengthRule = lengthMap[settings.commentaryLength] || lengthMap.short;
    const langInstruction = LANGUAGES[settings.language]?.instruction || LANGUAGES.russian.instruction;
    const name = settings.characterName || 'Meddler';

    const limit = Math.max(0, parseInt(settings.chatHistoryLimit) || 0);
    const mem = limit > 0 ? meddler.chatHistory.slice(-limit) : [];
    const memText = mem.length
        ? mem.map(m => `[${m.role === 'user' ? 'Пользователь' : name}]: ${m.content}`).join('\n\n')
        : '(пусто)';

    if (settings.systemPrompt?.trim()) {
        return `${settings.systemPrompt.trim()}

### ЖУРНАЛ РП (для контекста)
${chatLog || '(пусто)'}

### ВАША БЕСЕДА С ПОЛЬЗОВАТЕЛЕМ
${memText}

### НОВАЯ РЕПЛИКА ПОЛЬЗОВАТЕЛЯ
${question}

### ОТВЕТ
(Длина: ${lengthRule}. ${langInstruction} Только прямая реплика ${name} пользователю):`.trim();
    }

    let characterPersonality = '';
    if (settings.characterSource === 'custom') {
        characterPersonality = settings.personalityText || '';
    } else if (settings.characterId !== null && chars[settings.characterId]) {
        const char = chars[settings.characterId];
        characterPersonality = char.description || '';
        if (char.personality) characterPersonality += '\n' + char.personality;
    }

    let styleText;
    if (settings.commentaryStyle === 'custom' && settings.customTone) {
        styleText = settings.customTone;
    } else {
        styleText = COMMENTARY_STYLES[settings.commentaryStyle] || COMMENTARY_STYLES.snarky;
    }

    const personaBlock = characterPersonality
        ? `Ты — ${name}.\n[Личность]\n${characterPersonality}`
        : `Ты — ${name}.\n[Стиль]\n${styleText}`;

    return `
### ЛИЧНОСТЬ
${personaBlock}

### ЗАДАЧА
Ты общаешься с пользователем напрямую. Пользователь видел ролевую игру ниже и пишет тебе. Отвечай ему в своём характере, учитывая контекст РП и вашу предыдущую беседу.

### ПРАВИЛА
1. Отвечай от первого лица как ${name}, прямой репликой пользователю.
2. НЕ участвуй в ролевой игре и НЕ отвечай за её персонажей.
3. НЕ цитируй диалоги РП дословно.
4. Длина: ${lengthRule}.
5. ${langInstruction}

### ЖУРНАЛ РП (для контекста)
${chatLog || '(пусто)'}

### ВАША БЕСЕДА С ПОЛЬЗОВАТЕЛЕМ
${memText}

### НОВАЯ РЕПЛИКА ПОЛЬЗОВАТЕЛЯ
${question}

### ОТВЕТ
(Как ${name}, ответ пользователю):
`.trim();
}

// =====================================
// Очистка ответа
// =====================================
function cleanCommentaryResponse(raw) {
    if (!raw) return null;
    const context = getContext();
    const lastMsg = context.chat.at(-1)?.mes || '';
    if (lastMsg.length > 10 && raw.includes(lastMsg)) return null;

    let cleaned = raw.trim();
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'")))
        cleaned = cleaned.slice(1, -1).trim();

    [
        /^(Here'?s?\s+(is\s+)?(my\s+)?commentary:?\s*)/i,
        /^(Commentary|Response|Вот\s+мой\s+комментарий|Мой\s+комментарий|Комментарий):?\s*/i,
        /^(As\s+.+?,?\s+(I\s+)?(think|say|comment|observe):?\s*)/i,
        /^\(Как\s+.*?\):?\s*/i,
        /^\(As\s+.*?\):?\s*/i,
    ].forEach(p => { cleaned = cleaned.replace(p, ''); });

    const lines = cleaned.split('\n').filter(line => {
        const t = line.trim();
        if (!t) return false;
        if (/^(\[)?[A-Za-zА-Яа-я\s]{1,30}(\])?\s*:\s*.+/.test(t)) return false;
        if (meddler.recentChatNames?.some(n => t.toLowerCase().startsWith(n.toLowerCase() + ':'))) return false;
        if (/^[-=_*]{3,}$/.test(t)) return false;
        return true;
    });

    cleaned = lines.join(' ').trim();
    return cleaned.length >= 2 ? cleaned : null;
}

// =====================================
// Генерация комментария
// =====================================
async function generateCommentary(force = false) {
    const settings = getSettings();
    if (!settings.enabled && !force) return;
    if (meddler.isGenerating) return;

    const hasCharacter = settings.characterSource === 'custom'
        ? !!settings.personalityText || !!settings.characterName
        : settings.characterId !== null;

    if (!hasCharacter) {
        updateCommentaryText('Настрой персонажа в настройках~');
        return;
    }

    const context = getContext();
    if (!context.chat?.length) { updateCommentaryText('Жду начала РП...'); return; }

    if (!force) {
        settings.messageCount++;
        if (settings.messageCount < settings.frequency) { saveSettings(); return; }
        settings.messageCount = 0; saveSettings();
    }

    meddler.isGenerating = true;
    showTypingIndicator(true);
    updateStatus('Думаю...');

    try {
        let raw;

        if (settings.quickApiEnabled && settings.quickApiUrl && settings.quickApiModel) {
            // Прямой запрос — ST-шный API не трогаем вообще
            updateStatus('Генерирую...');
            const prompt = buildCommentaryPrompt();
            raw = await generateWithQuickApi(prompt);
        } else if (settings.connectionProfile && getConnectionProfile(settings.connectionProfile)) {
            // Генерация через отдельный профиль ST — активный профиль таверны не меняется
            updateStatus('Генерирую (профиль)...');
            const prompt = buildCommentaryPrompt();
            /** @type {Record<string, number>} */
            const maxTokensMap = { short: 150, medium: 350, long: 700 };
            const max_tokens = maxTokensMap[settings.commentaryLength] || 150;
            raw = await generateWithConnectionProfile(prompt, max_tokens);
        } else {
            // Стандартный путь через ST (текущие настройки генерации)
            const prompt = buildCommentaryPrompt();
            updateStatus('Генерирую...');
            // skipWIAN=true — не тащим World Info и Author's Note из таверны
            raw = await generateQuietPrompt(prompt, false, true);
        }

        if (raw) {
            const result = cleanCommentaryResponse(raw);
            updateCommentaryText(result ?? '*наблюдает молча*');
            if (result) meddler.lastCommentary = result;
        } else {
            updateCommentaryText('*задумчиво смотрит* (нет ответа)');
        }

        updateStatus('Наблюдаю...');
    } catch (e) {
        console.error(DEBUG_PREFIX, e);
        updateCommentaryText(`*бормочет* (ошибка: ${e.message || 'API error'})`);
        updateStatus('Ошибка!');
    } finally {
        meddler.isGenerating = false;
        showTypingIndicator(false);
    }
}

function addUserMessageToHistory(text) {
    [meddler.widget, meddler.bar].forEach(el => {
        if (!el) return;
        const h = el.querySelector('.meddler-history');
        if (!h) return;
        const item = document.createElement('div');
        item.className = 'meddler-history-item user-msg new';
        const p = document.createElement('p');
        p.textContent = text;
        item.appendChild(p);
        h.insertBefore(item, h.firstChild);
        const items = h.querySelectorAll('.meddler-history-item');
        if (items.length > 20) items[items.length - 1].remove();
        setTimeout(() => item.classList.remove('new'), 500);
    });
}

async function generateChatReply(rawQuestion) {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (meddler.isGenerating) return;
    const question = (rawQuestion || '').trim();
    if (!question) return;

    const hasCharacter = settings.characterSource === 'custom'
        ? !!settings.personalityText || !!settings.characterName
        : settings.characterId !== null;
    if (!hasCharacter) {
        updateCommentaryText('Настрой персонажа в настройках~');
        return;
    }

    addUserMessageToHistory(question);

    meddler.isGenerating = true;
    showTypingIndicator(true);
    updateStatus('Думаю...');

    try {
        const prompt = buildChatPrompt(question);
        let raw;
        /** @type {Record<string, number>} */
        const maxTokensMap = { short: 150, medium: 350, long: 700 };
        const max_tokens = maxTokensMap[settings.commentaryLength] || 150;

        if (settings.quickApiEnabled && settings.quickApiUrl && settings.quickApiModel) {
            raw = await postQuickApi([{ role: 'user', content: prompt }], max_tokens);
        } else if (settings.connectionProfile && getConnectionProfile(settings.connectionProfile)) {
            raw = await generateWithConnectionProfile(prompt, max_tokens);
        } else {
            raw = await generateQuietPrompt(prompt, false, true);
        }

        const cleaned = cleanCommentaryResponse(raw) || (raw?.trim() || '');
        const reply = cleaned || '*молчит*';
        updateCommentaryText(reply);
        if (cleaned) {
            pushPersistentMessage('user', question);
            pushPersistentMessage('assistant', cleaned);
            meddler.lastCommentary = cleaned;
        }
        updateStatus('Наблюдаю...');
    } catch (e) {
        console.error(DEBUG_PREFIX, e);
        updateCommentaryText(`*бормочет* (ошибка: ${e.message || 'API error'})`);
        updateStatus('Ошибка!');
    } finally {
        meddler.isGenerating = false;
        showTypingIndicator(false);
    }
}

function updateStatus(status) {
    const el = meddler.widget?.querySelector('.meddler-status');
    if (el) el.textContent = status;
    updateBarStatus(status);
}

function showTypingIndicator(show) {
    const widget = meddler.widget;
    if (widget) {
        if (show) { widget.classList.add('is-typing', 'is-generating'); widget.classList.remove('has-speech'); }
        else { widget.classList.remove('is-typing', 'is-generating'); }
    }
    if (meddler.bar) {
        meddler.bar.classList.toggle('is-generating', show);
        showBarTypingIndicator(show);
    }
}

function onMessageReceived() {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (meddler.chatJustChanged) return;
    const now = Date.now();
    if (now - meddler.lastTriggerTime < 1000) return;
    meddler.lastTriggerTime = now;
    generateCommentary(false);
}

function onChatChanged() {
    const settings = getSettings();
    settings.messageCount = 0; saveSettings();
    meddler.chatJustChanged = true;
    meddler.lastBarMessage = '';
    loadChatHistoryForCurrentChat();
    setTimeout(() => { meddler.chatJustChanged = false; }, 2000);
    if (settings.autoShow) switchDisplayMode(settings.displayMode);

    rerenderHistoryPanel();

    if (meddler.chatHistory.length > 0) {
        const last = meddler.chatHistory[meddler.chatHistory.length - 1];
        if (last?.role === 'assistant' && last.content) {
            meddler.lastCommentary = last.content;
            setSpeechTextOnly(last.content);
        } else {
            setSpeechTextOnly('С возвращением~ Продолжаем?');
        }
    } else {
        setSpeechTextOnly('Новый чат! Жду чего-нибудь интересного...');
    }
    updateStatus('Наблюдаю...');
}

/**
 * Обновить только текст пузыря и bar-строки, не трогая панель истории.
 * @param {string} text
 */
function setSpeechTextOnly(text) {
    /** @type {HTMLElement|null} */
    const widget = meddler.widget;
    if (widget) {
        const speechText = widget.querySelector('.meddler-speech-bubble .meddler-text');
        if (speechText) speechText.textContent = text;
    }
    /** @type {HTMLElement|null} */
    const bar = meddler.bar;
    if (bar) {
        const textEl = bar.querySelector('.meddler-bar-text');
        if (textEl) textEl.textContent = text;
        meddler.lastBarMessage = text;
    }
}

function updateDisplayModeOptions(mode) {
    document.getElementById('meddler-widget-options').style.display = mode === 'widget' ? 'block' : 'none';
    document.getElementById('meddler-bar-options').style.display   = mode === 'bar'    ? 'block' : 'none';
}

// =====================================
// UI настроек
// =====================================
async function setupSettingsUI() {
    const html = `
    <div id="meddler-settings" class="meddler-settings-panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>ST-Meddler</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <div class="meddler-setting-row">
                    <label class="checkbox_label" for="meddler-enabled">
                        <input type="checkbox" id="meddler-enabled" />
                        <span>Включить ST-Meddler</span>
                    </label>
                </div>

                <div class="meddler-setting-row">
                    <label for="meddler-display-mode">Режим отображения:</label>
                    <select id="meddler-display-mode" class="text_pole">
                        <option value="widget">🎈 Плавающий виджет</option>
                        <option value="bar">📜 Строка над чатом</option>
                    </select>
                </div>

                <hr class="sysHR" />
                <h4 class="meddler-section-title">Персонаж-комментатор</h4>

                <!-- Источник личности -->
                <div class="meddler-setting-row">
                    <label>Откуда брать личность:</label>
                    <div class="meddler-radio-group">
                        <label class="meddler-radio-label">
                            <input type="radio" name="meddler-char-source" id="meddler-source-card" value="card" />
                            <span>📋 Карточка персонажа ST</span>
                        </label>
                        <label class="meddler-radio-label">
                            <input type="radio" name="meddler-char-source" id="meddler-source-custom" value="custom" />
                            <span>✏️ Написать вручную</span>
                        </label>
                    </div>
                </div>

                <!-- Карточка ST -->
                <div id="meddler-card-section" class="meddler-setting-row meddler-subsection">
                    <label for="meddler-character-select">Персонаж:</label>
                    <div class="meddler-char-select-row">
                        <select id="meddler-character-select" class="text_pole"></select>
                        <button id="meddler-refresh-chars" class="menu_button" title="Обновить список">
                            <i class="fa-solid fa-rotate"></i>
                        </button>
                    </div>
                    <small>Личность берётся из описания/характера карточки</small>
                </div>

                <!-- Вручную -->
                <div id="meddler-custom-section" class="meddler-setting-row meddler-subsection" style="display:none;">
                    <div class="meddler-setting-row">
                        <label for="meddler-custom-name">Имя персонажа:</label>
                        <input type="text" id="meddler-custom-name" class="text_pole" placeholder="Имя для отображения..." />
                    </div>
                    <label for="meddler-custom-personality">Личность / описание характера:</label>
                    <textarea id="meddler-custom-personality" class="meddler-tone-textarea"
                        placeholder="Опиши персонажа: кто он, как говорит, что его характеризует...&#10;Пример: Ты — ворчливый старый маг, который всё видит насквозь и постоянно бормочет под нос."></textarea>
                    <small>Используется вместо карточки как инструкция для ИИ</small>
                </div>

                <hr class="sysHR" />
                <h4 class="meddler-section-title">Изображение персонажа</h4>

                <div class="meddler-setting-row">
                    <label>Источник картинки:</label>
                    <div class="meddler-radio-group">
                        <label class="meddler-radio-label">
                            <input type="radio" name="meddler-img-source" id="meddler-img-card" value="card" />
                            <span>🖼️ С карточки ST</span>
                        </label>
                        <label class="meddler-radio-label">
                            <input type="radio" name="meddler-img-source" id="meddler-img-upload" value="upload" />
                            <span>📁 Загрузить PNG</span>
                        </label>
                        <label class="meddler-radio-label">
                            <input type="radio" name="meddler-img-source" id="meddler-img-none" value="none" />
                            <span>— Без картинки</span>
                        </label>
                    </div>
                </div>

                <div class="meddler-sprite-upload-area">
                    <div class="meddler-sprite-preview">
                        <img id="meddler-sprite-preview-img" src="" alt="" style="display:none;" />
                        <div class="meddler-sprite-preview-placeholder" id="meddler-sprite-preview-placeholder">
                            <i class="fa-solid fa-image"></i>
                        </div>
                    </div>
                    <div class="meddler-sprite-controls" id="meddler-upload-controls" style="display:none;">
                        <input type="file" id="meddler-sprite-file" accept=".png,image/png" style="display:none;" />
                        <button class="menu_button" id="meddler-sprite-upload-btn">
                            <i class="fa-solid fa-upload"></i> Загрузить PNG
                        </button>
                        <button class="menu_button" id="meddler-sprite-clear-btn">
                            <i class="fa-solid fa-trash-can"></i> Удалить
                        </button>
                        <small>Рекомендуется до 256×256 px</small>
                    </div>
                </div>

                <hr class="sysHR" />
                <h4 class="meddler-section-title">Поведение и тон</h4>

                <div class="meddler-setting-row">
                    <label for="meddler-style-select">Стиль комментариев:</label>
                    <select id="meddler-style-select" class="text_pole">
                        <option value="snarky">🎭 Саркастичный</option>
                        <option value="supportive">🎉 Поддерживающий</option>
                        <option value="analytical">🔍 Аналитический</option>
                        <option value="chaotic">🌀 Хаотичный</option>
                        <option value="custom">✏️ Свой тон</option>
                    </select>
                    <small>Тон перекрывается личностью персонажа, если она задана</small>
                </div>

                <div id="meddler-custom-tone-section" class="meddler-setting-row" style="display:none;">
                    <label for="meddler-custom-tone">Описание тона:</label>
                    <textarea id="meddler-custom-tone" class="meddler-tone-textarea"
                        placeholder="Тон: мистический, загадочный, говорит загадками..."></textarea>
                </div>

                <div class="meddler-setting-row">
                    <label for="meddler-language-select">Язык комментариев:</label>
                    <select id="meddler-language-select" class="text_pole">
                        <option value="russian">🇷🇺 Русский</option>
                        <option value="english">🇺🇸 English</option>
                    </select>
                </div>

                <div class="meddler-setting-row">
                    <label for="meddler-length-select">Длина комментария:</label>
                    <select id="meddler-length-select" class="text_pole">
                        <option value="short">🩳 Короткий (1–2 предложения)</option>
                        <option value="medium">📝 Средний (3–5 предложений)</option>
                        <option value="long">📜 Длинный (6–8 предложений)</option>
                    </select>
                </div>

                <div class="meddler-setting-row">
                    <label for="meddler-system-prompt">Системный промт:</label>
                    <textarea id="meddler-system-prompt" class="meddler-tone-textarea"
                        placeholder="Опционально. Полностью заменяет автоматический промт. Журнал РП и инструкция по длине добавятся автоматически в конец."></textarea>
                    <small>Если задан — авто-промт с личностью и тоном игнорируется</small>
                </div>

                <hr class="sysHR" />
                <h4 class="meddler-section-title">🔌 API</h4>

                <small class="meddler-hint">Приоритет: Quick API → Профиль подключения → активные настройки ST. Профиль и Quick API шлют запросы изолированно, активный профиль ST не меняется.</small>

                <div class="meddler-drawer">
                    <div class="meddler-drawer-toggle" id="meddler-profile-drawer-toggle">
                        <b>🧩 Профиль подключения ST</b>
                        <i class="meddler-drawer-chevron fa-solid fa-chevron-down"></i>
                    </div>
                    <div class="meddler-drawer-content" id="meddler-profile-drawer-content">
                        <small class="meddler-hint">Меддлер использует выбранный профиль SillyTavern, НЕ переключая активный профиль в таверне. Запросы ST и меддлера идут раздельно. Если в профиле задан secret-id, меддлер на время запроса подменит активный ключ этого источника и вернёт обратно после ответа (UI-переподключения ST не происходит). Пусто — используется активный профиль ST.</small>
                        <div class="meddler-setting-row">
                            <label for="meddler-profile-select">Профиль для меддлера:</label>
                            <div class="meddler-model-row">
                                <select id="meddler-profile-select" class="text_pole">
                                    <option value="">— Использовать активный в ST —</option>
                                </select>
                                <button type="button" id="meddler-profile-refresh" class="menu_button" title="Обновить список профилей">
                                    <i class="fa-solid fa-rotate"></i>
                                </button>
                            </div>
                        </div>
                        <div class="meddler-setting-row">
                            <div id="meddler-profile-status" class="meddler-quickapi-status">
                                <span class="meddler-status-inactive">Профиль не задан</span>
                            </div>
                        </div>
                        <div class="meddler-setting-row meddler-quickapi-buttons">
                            <button type="button" id="meddler-profile-check" class="menu_button"><i class="fa-solid fa-plug"></i> Проверить</button>
                            <button type="button" id="meddler-profile-test" class="menu_button"><i class="fa-solid fa-flask"></i> Тест</button>
                        </div>
                    </div>
                </div>

                <div class="meddler-drawer">
                    <div class="meddler-drawer-toggle" id="meddler-quickapi-drawer-toggle">
                        <b>⚡ Quick API</b>
                        <i class="meddler-drawer-chevron fa-solid fa-chevron-down"></i>
                    </div>
                    <div class="meddler-drawer-content" id="meddler-quickapi-drawer-content">
                        <div class="meddler-setting-row">
                            <label class="checkbox_label" for="meddler-quickapi-enabled">
                                <input type="checkbox" id="meddler-quickapi-enabled" />
                                <span>Включить Quick API override</span>
                            </label>
                        </div>
                        <div id="meddler-quickapi-options" class="meddler-quickapi-options">
                            <div class="meddler-setting-row">
                                <label for="meddler-quickapi-url">URL API (base):</label>
                                <input type="text" id="meddler-quickapi-url" class="text_pole" placeholder="https://your-server.com/v1" />
                            </div>
                            <div class="meddler-setting-row">
                                <label for="meddler-quickapi-key">Ключ API:</label>
                                <input type="password" id="meddler-quickapi-key" class="text_pole" placeholder="sk-... (необязательно)" />
                            </div>
                            <div class="meddler-setting-row">
                                <label>Модель — из списка:</label>
                                <div class="meddler-model-row">
                                    <select id="meddler-quickapi-model-select" class="text_pole">
                                        <option value="">— нажмите ⟳ для загрузки —</option>
                                    </select>
                                    <button type="button" id="meddler-quickapi-fetch-models" class="menu_button" title="Загрузить список моделей с API">
                                        <i class="fa-solid fa-rotate"></i>
                                    </button>
                                </div>
                                <small id="meddler-models-hint" style="display:none;"></small>
                            </div>
                            <div class="meddler-model-or">— или —</div>
                            <div class="meddler-setting-row">
                                <label for="meddler-quickapi-model-input">Модель — вручную:</label>
                                <input type="text" id="meddler-quickapi-model-input" class="text_pole" placeholder="gpt-4o, claude-3-5-sonnet, ..." autocomplete="off" />
                            </div>
                            <div class="meddler-setting-row">
                                <div id="meddler-quickapi-status" class="meddler-quickapi-status">
                                    <span class="meddler-status-inactive">Quick API отключён</span>
                                </div>
                            </div>
                            <div class="meddler-setting-row meddler-quickapi-buttons">
                                <button type="button" id="meddler-quickapi-connect" class="menu_button"><i class="fa-solid fa-plug"></i> Проверить</button>
                                <button type="button" id="meddler-quickapi-test" class="menu_button"><i class="fa-solid fa-flask"></i> Тест</button>
                            </div>
                        </div>
                    </div>
                </div>

                <hr class="sysHR" />
                <h4 class="meddler-section-title">⏱️ Таймер и контекст</h4>

                <div class="meddler-setting-row">
                    <label for="meddler-frequency">Частота комментариев:</label>
                    <div class="range-block-enhanced">
                        <input type="range" id="meddler-frequency" min="1" max="20" />
                        <input type="number" id="meddler-frequency-input" min="1" max="20" class="meddler-num-input" />
                        <button id="meddler-frequency-lock" class="meddler-lock-btn"><i class="fa-solid fa-lock-open"></i></button>
                    </div>
                    <small>Комментировать каждые N сообщений</small>
                </div>

                <div class="meddler-setting-row">
                    <label for="meddler-context">Сообщений для анализа:</label>
                    <div class="range-block-enhanced">
                        <input type="range" id="meddler-context" min="1" max="30" />
                        <input type="number" id="meddler-context-input" min="1" max="30" class="meddler-num-input" />
                        <button id="meddler-context-lock" class="meddler-lock-btn"><i class="fa-solid fa-lock-open"></i></button>
                    </div>
                    <small>Сколько последних сообщений учитывать</small>
                </div>

                <hr class="sysHR" />
                <h4 class="meddler-section-title">💬 Болтовня</h4>

                <small class="meddler-hint">Открой панель (нажми на аватар) и спроси персонажа — он ответит с учётом РП и вашей прошлой беседы.</small>

                <div class="meddler-setting-row">
                    <label for="meddler-chat-memory">Память болтовни:</label>
                    <div class="range-block">
                        <input type="range" id="meddler-chat-memory" min="0" max="30" />
                        <span id="meddler-chat-memory-value">10 реплик</span>
                    </div>
                    <small>Сколько последних реплик разговора персонаж помнит. 0 — без памяти.</small>
                </div>

                <div class="meddler-setting-row meddler-button-row">
                    <button id="meddler-chat-clear" class="menu_button">
                        <i class="fa-solid fa-broom"></i> Очистить память болтовни
                    </button>
                </div>

                <hr class="sysHR" />
                <h4 class="meddler-section-title">✨ Оформление</h4>

                <div class="meddler-setting-row">
                    <label for="meddler-theme-select">Тема:</label>
                    <select id="meddler-theme-select" class="text_pole">
                        <option value="soft">🩶 Нейтральная</option>
                        <option value="pink">🌸 Розовая</option>
                        <option value="lavender">💜 Лаванда</option>
                        <option value="mint">🌿 Мята</option>
                        <option value="peach">🍑 Персик</option>
                        <option value="night">🌙 Ночь</option>
                        <option value="custom">🎨 Свой цвет</option>
                    </select>
                </div>

                <div id="meddler-custom-colors" class="meddler-custom-colors" style="display:none;">
                    <div class="meddler-color-row"><label>Основной:</label><input type="color" id="meddler-color-primary" /></div>
                    <div class="meddler-color-row"><label>Фон:</label><input type="color" id="meddler-color-secondary" /></div>
                    <div class="meddler-color-row"><label>Акцент:</label><input type="color" id="meddler-color-accent" /></div>
                    <div class="meddler-color-row"><label>Текст:</label><input type="color" id="meddler-color-text" /></div>
                </div>

                <div id="meddler-widget-options" class="meddler-display-options">
                    <div class="meddler-setting-row">
                        <label for="meddler-bubble-position">Позиция пузыря:</label>
                        <select id="meddler-bubble-position" class="text_pole">
                            <option value="right">➡️ Справа от аватара</option>
                            <option value="left">⬅️ Слева от аватара</option>
                            <option value="top">⬆️ Над аватаром</option>
                            <option value="bottom">⬇️ Под аватаром</option>
                        </select>
                    </div>
                    <div class="meddler-setting-row">
                        <label for="meddler-bubble-width">Ширина пузыря:</label>
                        <div class="range-block">
                            <input type="range" id="meddler-bubble-width" min="120" max="400" />
                            <span id="meddler-bubble-width-value">220px</span>
                        </div>
                    </div>
                    <div class="meddler-setting-row">
                        <label for="meddler-avatar-size">Размер аватара:</label>
                        <div style="display:flex;gap:6px;align-items:center;flex:1;">
                            <select id="meddler-avatar-size" class="text_pole" style="flex:1;">
                                <option value="small">Маленький (55px)</option>
                                <option value="medium">Средний (70px)</option>
                                <option value="large">Большой (90px)</option>
                                <option value="custom">✏️ Свой</option>
                            </select>
                            <input type="number" id="meddler-avatar-size-custom" class="text_pole"
                                min="30" max="400" style="width:64px;display:none;" placeholder="px" />
                        </div>
                    </div>
                    <div class="meddler-setting-row">
                        <label>Форма аватара:</label>
                        <div class="meddler-radio-group">
                            <label class="meddler-radio-label">
                                <input type="radio" name="meddler-avatar-style" id="meddler-avatar-style-circle" value="circle" />
                                <span>⭕ Круглая рамка</span>
                            </label>
                            <label class="meddler-radio-label">
                                <input type="radio" name="meddler-avatar-style" id="meddler-avatar-style-full" value="full" />
                                <span>🖼️ Целая картинка</span>
                            </label>
                        </div>
                    </div>
                    <div class="meddler-setting-row">
                        <label for="meddler-opacity">Прозрачность:</label>
                        <div class="range-block">
                            <input type="range" id="meddler-opacity" min="20" max="100" />
                            <span id="meddler-opacity-value">100%</span>
                        </div>
                    </div>
                    <div class="meddler-setting-row">
                        <label class="checkbox_label" for="meddler-sleep-mode">
                            <input type="checkbox" id="meddler-sleep-mode" />
                            <span>Режим сна</span>
                        </label>
                        <small>Виджет невидим — появляется когда приходит комментарий, затем засыпает снова</small>
                    </div>
                    <div id="meddler-sleep-options" class="meddler-sleep-options" style="display:none;">
                        <div class="meddler-setting-row">
                            <label for="meddler-sleep-timeout">Засыпать через:</label>
                            <div class="range-block">
                                <input type="range" id="meddler-sleep-timeout" min="2" max="60" />
                                <span id="meddler-sleep-timeout-value">8 сек</span>
                            </div>
                        </div>
                    </div>
                    <div class="meddler-setting-row">
                        <label class="checkbox_label" for="meddler-show-active-model">
                            <input type="checkbox" id="meddler-show-active-model" />
                            <span>Показывать активную модель</span>
                        </label>
                        <small>Маленькое окошко у аватара: ⚡ Quick API, 🧩 Профиль или ST. По умолчанию выключено.</small>
                    </div>
                </div>

                <div id="meddler-bar-options" class="meddler-display-options">
                    <div class="meddler-setting-row">
                        <label for="meddler-ticker-speed">Скорость строки:</label>
                        <div class="range-block">
                            <input type="range" id="meddler-ticker-speed" min="20" max="150" />
                            <span id="meddler-ticker-speed-value">50 px/s</span>
                        </div>
                    </div>
                    <div class="meddler-setting-row">
                        <label class="checkbox_label" for="meddler-ticker-always">
                            <input type="checkbox" id="meddler-ticker-always" />
                            <span>Всегда прокручивать</span>
                        </label>
                    </div>
                </div>

                <hr class="sysHR" />

                <div class="meddler-setting-row">
                    <label class="checkbox_label" for="meddler-autoshow">
                        <input type="checkbox" id="meddler-autoshow" />
                        <span>Показывать при смене чата</span>
                    </label>
                </div>

                <div class="meddler-setting-row meddler-button-row">
                    <button id="meddler-show-widget" class="menu_button">Показать</button>
                    <button id="meddler-hide-widget" class="menu_button">Скрыть</button>
                    <button id="meddler-reset-position" class="menu_button">Сбросить позицию</button>
                </div>
                <div class="meddler-setting-row meddler-button-row">
                    <button id="meddler-force-comment" class="menu_button">
                        <i class="fa-solid fa-comment"></i> Прокомментировать сейчас
                    </button>
                </div>
                <div class="meddler-setting-row">
                    <small class="meddler-hint">💡 Нажатие на аватару в режиме строки — открыть/закрыть панель истории</small>
                </div>

            </div>
        </div>
    </div>
    `;

    const target = document.getElementById('extensions_settings2');
    if (target) target.insertAdjacentHTML('beforeend', html);

    const settings = getSettings();

    // Enabled
    bind('meddler-enabled', 'change', e => { settings.enabled = e.target.checked; saveSettings(); switchDisplayMode(settings.displayMode); }, el => { el.checked = settings.enabled; });

    // Display mode
    bind('meddler-display-mode', 'change', e => {
        settings.displayMode = e.target.value; saveSettings();
        switchDisplayMode(settings.displayMode); updateDisplayModeOptions(settings.displayMode);
    }, el => { el.value = settings.displayMode; updateDisplayModeOptions(settings.displayMode); });

    // --- Character source ---
    const cardSection   = document.getElementById('meddler-card-section');
    const customSection = document.getElementById('meddler-custom-section');

    function applyCharSourceUI() {
        const isCustom = settings.characterSource === 'custom';
        cardSection.style.display   = isCustom ? 'none' : 'block';
        customSection.style.display = isCustom ? 'block' : 'none';
        document.getElementById(isCustom ? 'meddler-source-custom' : 'meddler-source-card').checked = true;
    }
    applyCharSourceUI();

    ['meddler-source-card', 'meddler-source-custom'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', e => {
            if (e.target.checked) {
                settings.characterSource = e.target.value;
                saveSettings(); applyCharSourceUI();
            }
        });
    });

    // Character dropdown
    populateCharacterDropdown();
    document.getElementById('meddler-character-select')?.addEventListener('change', onCharacterSelect);
    document.getElementById('meddler-refresh-chars')?.addEventListener('click', () => populateCharacterDropdown());

    // Custom name + personality
    const customNameInput = document.getElementById('meddler-custom-name');
    if (customNameInput) {
        customNameInput.value = (settings.characterSource === 'custom') ? settings.characterName : '';
        customNameInput.addEventListener('input', e => {
            settings.characterName = e.target.value.trim(); saveSettings();
            updateWidgetCharacter(); updateBarCharacter();
        });
    }
    const customPersonality = document.getElementById('meddler-custom-personality');
    if (customPersonality) {
        customPersonality.value = settings.personalityText || '';
        customPersonality.addEventListener('input', e => { settings.personalityText = e.target.value; saveSettings(); });
    }

    // --- Image source ---
    const uploadControls = document.getElementById('meddler-upload-controls');

    function applyImgSourceUI() {
        const isUpload = settings.imageSource === 'upload';
        if (uploadControls) uploadControls.style.display = isUpload ? 'flex' : 'none';
        const radios = { card: 'meddler-img-card', upload: 'meddler-img-upload', none: 'meddler-img-none' };
        const el = document.getElementById(radios[settings.imageSource] || 'meddler-img-card');
        if (el) el.checked = true;
        updateSpritePreview();
    }
    applyImgSourceUI();

    ['meddler-img-card', 'meddler-img-upload', 'meddler-img-none'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', e => {
            if (e.target.checked) {
                settings.imageSource = e.target.value;
                saveSettings(); applyImgSourceUI();
                updateWidgetCharacter(); updateBarCharacter();
            }
        });
    });

    // Sprite upload
    const spriteFile   = document.getElementById('meddler-sprite-file');
    const uploadBtn    = document.getElementById('meddler-sprite-upload-btn');
    const clearBtn     = document.getElementById('meddler-sprite-clear-btn');

    uploadBtn?.addEventListener('click', () => spriteFile?.click());
    clearBtn?.addEventListener('click', () => {
        settings.spriteData = ''; saveSettings();
        updateSpritePreview(); updateWidgetCharacter(); updateBarCharacter();
    });
    spriteFile?.addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        if (!file.type.includes('png') && !file.name.toLowerCase().endsWith('.png')) { alert('Нужен PNG-файл!'); return; }
        const reader = new FileReader();
        reader.onload = evt => {
            settings.spriteData = evt.target.result;
            settings.imageSource = 'upload';
            saveSettings(); applyImgSourceUI();
            updateWidgetCharacter(); updateBarCharacter();
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    });

    // Style
    const customToneSection = document.getElementById('meddler-custom-tone-section');
    bind('meddler-style-select', 'change', e => {
        settings.commentaryStyle = e.target.value; saveSettings();
        if (customToneSection) customToneSection.style.display = e.target.value === 'custom' ? 'block' : 'none';
    }, el => {
        el.value = settings.commentaryStyle;
        if (customToneSection) customToneSection.style.display = settings.commentaryStyle === 'custom' ? 'block' : 'none';
    });
    bind('meddler-custom-tone', 'input', e => { settings.customTone = e.target.value; saveSettings(); }, el => { el.value = settings.customTone || ''; });

    // Language
    bind('meddler-language-select', 'change', e => { settings.language = e.target.value; saveSettings(); }, el => { el.value = settings.language || 'russian'; });

    // Commentary length
    bind('meddler-length-select', 'change', e => { settings.commentaryLength = e.target.value; saveSettings(); }, el => { el.value = settings.commentaryLength || 'short'; });

    // System prompt
    const sysPromptEl = document.getElementById('meddler-system-prompt');
    if (sysPromptEl) {
        sysPromptEl.value = settings.systemPrompt || '';
        sysPromptEl.addEventListener('input', e => { settings.systemPrompt = e.target.value; saveSettings(); });
    }

    // Frequency
    bindRange('meddler-frequency', 'meddler-frequency-input', 'meddler-frequency-lock',
        () => settings.frequency, v => { settings.frequency = v; saveSettings(); },
        () => settings.frequencyLocked, v => { settings.frequencyLocked = v; saveSettings(); },
        1, 20);

    // Context
    bindRange('meddler-context', 'meddler-context-input', 'meddler-context-lock',
        () => settings.maxContextMessages, v => { settings.maxContextMessages = v; saveSettings(); },
        () => settings.contextLocked, v => { settings.contextLocked = v; saveSettings(); },
        1, 30);

    // Chat memory
    {
        const slider = document.getElementById('meddler-chat-memory');
        const label  = document.getElementById('meddler-chat-memory-value');
        if (slider && label) {
            slider.value = settings.chatHistoryLimit;
            label.textContent = `${settings.chatHistoryLimit} реплик`;
            slider.addEventListener('input', e => {
                settings.chatHistoryLimit = parseInt(e.target.value);
                label.textContent = `${settings.chatHistoryLimit} реплик`;
                saveSettings();
            });
        }
        document.getElementById('meddler-chat-clear')?.addEventListener('click', () => {
            meddler.chatHistory = [];
            persistChatHistoryForCurrentChat();
            rerenderHistoryPanel();
            const btn = document.getElementById('meddler-chat-clear');
            if (btn) {
                const orig = btn.innerHTML;
                btn.innerHTML = '<i class="fa-solid fa-check"></i> Очищено';
                setTimeout(() => { btn.innerHTML = orig; }, 1200);
            }
        });
    }

    // Autoshow
    bind('meddler-autoshow', 'change', e => { settings.autoShow = e.target.checked; saveSettings(); }, el => { el.checked = settings.autoShow; });

    // Buttons
    document.getElementById('meddler-show-widget')?.addEventListener('click', () => {
        if (settings.displayMode === 'widget' && meddler.widget) meddler.widget.style.display = 'block';
        else if (settings.displayMode === 'bar' && meddler.bar) meddler.bar.style.display = 'flex';
    });
    document.getElementById('meddler-hide-widget')?.addEventListener('click', () => {
        if (meddler.widget) meddler.widget.style.display = 'none';
        if (meddler.bar)    meddler.bar.style.display = 'none';
    });
    document.getElementById('meddler-reset-position')?.addEventListener('click', () => {
        settings.widgetPosition = { x: 20, y: 20 };
        if (meddler.widget) { meddler.widget.style.left = '20px'; meddler.widget.style.top = '20px'; }
        saveSettings();
    });
    document.getElementById('meddler-force-comment')?.addEventListener('click', () => generateCommentary(true));

    // Theme
    const customColorsDiv = document.getElementById('meddler-custom-colors');
    bind('meddler-theme-select', 'change', e => {
        settings.uiTheme = e.target.value;
        if (customColorsDiv) customColorsDiv.style.display = e.target.value === 'custom' ? 'block' : 'none';
        applyUITheme(); applyBarTheme(); saveSettings();
    }, el => {
        el.value = settings.uiTheme;
        if (customColorsDiv) customColorsDiv.style.display = settings.uiTheme === 'custom' ? 'block' : 'none';
    });

    [['meddler-color-primary','primary'],['meddler-color-secondary','secondary'],['meddler-color-accent','accent'],['meddler-color-text','text']].forEach(([id, key]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = settings.uiCustomColors[key];
        el.addEventListener('input', e => {
            settings.uiCustomColors[key] = e.target.value;
            if (settings.uiTheme === 'custom') { applyUITheme(); applyBarTheme(); }
            saveSettings();
        });
    });

    // Bubble position
    bind('meddler-bubble-position', 'change', e => { settings.uiBubblePosition = e.target.value; applyUITheme(); saveSettings(); }, el => { el.value = settings.uiBubblePosition; });

    // Bubble width
    const bubbleWidthSlider = document.getElementById('meddler-bubble-width');
    const bubbleWidthLabel  = document.getElementById('meddler-bubble-width-value');
    if (bubbleWidthSlider) {
        bubbleWidthSlider.value = settings.uiBubbleWidth ?? 220;
        if (bubbleWidthLabel) bubbleWidthLabel.textContent = `${bubbleWidthSlider.value}px`;
        bubbleWidthSlider.addEventListener('input', e => {
            settings.uiBubbleWidth = parseInt(e.target.value);
            if (bubbleWidthLabel) bubbleWidthLabel.textContent = `${e.target.value}px`;
            applyUITheme(); saveSettings();
        });
    }

    const avatarSizeSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('meddler-avatar-size'));
    const avatarSizeCustom = /** @type {HTMLInputElement|null} */ (document.getElementById('meddler-avatar-size-custom'));
    function syncAvatarSizeCustomVisibility() {
        if (avatarSizeCustom) avatarSizeCustom.style.display = settings.uiAvatarSize === 'custom' ? 'block' : 'none';
    }
    if (avatarSizeSelect) {
        avatarSizeSelect.value = settings.uiAvatarSize;
        avatarSizeSelect.addEventListener('change', e => {
            settings.uiAvatarSize = /** @type {HTMLSelectElement} */ (e.target).value;
            syncAvatarSizeCustomVisibility();
            applyUITheme(); saveSettings();
        });
    }
    if (avatarSizeCustom) {
        avatarSizeCustom.value = settings.uiAvatarSizeCustom ?? 80;
        avatarSizeCustom.addEventListener('input', e => {
            const v = parseInt(/** @type {HTMLInputElement} */ (e.target).value);
            if (v >= 30 && v <= 400) { settings.uiAvatarSizeCustom = v; applyUITheme(); saveSettings(); }
        });
    }
    syncAvatarSizeCustomVisibility();

    ['meddler-avatar-style-circle', 'meddler-avatar-style-full'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', e => {
            const t = /** @type {HTMLInputElement} */ (e.target);
            if (t?.checked) { settings.uiAvatarStyle = t.value; applyUITheme(); saveSettings(); }
        });
    });
    const avatarStyleEl = /** @type {HTMLInputElement|null} */ (document.getElementById(`meddler-avatar-style-${settings.uiAvatarStyle || 'circle'}`));
    if (avatarStyleEl) avatarStyleEl.checked = true;

    // Opacity
    const opacitySlider = document.getElementById('meddler-opacity');
    const opacityLabel  = document.getElementById('meddler-opacity-value');
    if (opacitySlider && opacityLabel) {
        opacitySlider.value = settings.uiOpacity;
        opacityLabel.textContent = `${settings.uiOpacity}%`;
        opacitySlider.addEventListener('input', e => {
            settings.uiOpacity = parseInt(e.target.value);
            opacityLabel.textContent = `${settings.uiOpacity}%`;
            applyUITheme(); applyBarTheme(); saveSettings();
        });
    }

    // Sleep mode
    {
        const sleepCheck   = document.getElementById('meddler-sleep-mode');
        const sleepOptions = document.getElementById('meddler-sleep-options');
        const sleepSlider  = document.getElementById('meddler-sleep-timeout');
        const sleepLabel   = document.getElementById('meddler-sleep-timeout-value');

        const updateSleepOptionsVisibility = () => {
            if (sleepOptions) sleepOptions.style.display = settings.sleepMode ? 'block' : 'none';
        };

        if (sleepCheck) {
            sleepCheck.checked = settings.sleepMode;
            updateSleepOptionsVisibility();
            sleepCheck.addEventListener('change', e => {
                settings.sleepMode = e.target.checked;
                updateSleepOptionsVisibility();
                saveSettings();
                if (settings.sleepMode) {
                    sleepWidget();
                } else {
                    wakeWidget();
                    if (meddler.sleepTimer) { clearTimeout(meddler.sleepTimer); meddler.sleepTimer = null; }
                }
            });
        }

        if (sleepSlider && sleepLabel) {
            sleepSlider.value = settings.sleepTimeout;
            sleepLabel.textContent = `${settings.sleepTimeout} сек`;
            sleepSlider.addEventListener('input', e => {
                settings.sleepTimeout = parseInt(e.target.value);
                sleepLabel.textContent = `${settings.sleepTimeout} сек`;
                saveSettings();
            });
        }
    }

    bind('meddler-show-active-model', 'change', /** @param {any} e */ e => {
        settings.showActiveModel = e.target.checked;
        saveSettings();
        updateActiveModelBadge();
    }, /** @param {any} el */ el => { el.checked = !!settings.showActiveModel; });

    // Ticker
    const tickerSpeed = document.getElementById('meddler-ticker-speed');
    const tickerLabel = document.getElementById('meddler-ticker-speed-value');
    if (tickerSpeed && tickerLabel) {
        tickerSpeed.value = settings.uiTickerSpeed;
        tickerLabel.textContent = `${settings.uiTickerSpeed} px/s`;
        tickerSpeed.addEventListener('input', e => {
            settings.uiTickerSpeed = parseInt(e.target.value);
            tickerLabel.textContent = `${settings.uiTickerSpeed} px/s`;
            saveSettings(); applyBarTickerAnimation();
        });
    }
    bind('meddler-ticker-always', 'change', e => { settings.uiTickerAlwaysScroll = e.target.checked; saveSettings(); applyBarTickerAnimation(); }, el => { el.checked = settings.uiTickerAlwaysScroll; });

    // Connection Profile (ST) — isolated generation profile
    {
        const toggle  = document.getElementById('meddler-profile-drawer-toggle');
        const content = document.getElementById('meddler-profile-drawer-content');
        if (toggle && content) {
            toggle.addEventListener('click', () => {
                const isOpen = content.classList.contains('open');
                content.classList.toggle('open', !isOpen);
                toggle.querySelector('.meddler-drawer-chevron')?.classList.toggle('rotated', !isOpen);
            });
        }
    }
    document.getElementById('meddler-profile-select')?.addEventListener('change', e => {
        settings.connectionProfile = /** @type {HTMLSelectElement} */ (e.target).value || '';
        saveSettings();
        updateProfileStatus();
        updateActiveModelBadge();
    });
    document.getElementById('meddler-profile-refresh')?.addEventListener('click', () => populateProfileDropdown());
    populateProfileDropdown();

    // Профиль: кнопка «Проверить»
    document.getElementById('meddler-profile-check')?.addEventListener('click', async () => {
        const btn = document.getElementById('meddler-profile-check');
        if (!(btn instanceof HTMLButtonElement)) return;
        const orig = btn.innerHTML;
        try {
            if (!settings.connectionProfile) { alert('Сначала выбери профиль из списка!'); return; }
            const profile = getConnectionProfile(settings.connectionProfile);
            if (!profile) { alert(`Профиль «${settings.connectionProfile}» не найден. Нажми ⟳ для обновления.`); return; }
            const ctx = SillyTavern.getContext();
            if (!ctx.ConnectionManagerRequestService) { alert('Connection Manager недоступен в этом ST.'); return; }
            // Проверяем, что профиль поддерживается CM
            const supported = /** @type {any[]} */ (ctx.ConnectionManagerRequestService.getSupportedProfiles?.() || [])
                .some(/** @param {any} p */ p => p.id === profile.id);
            if (!supported) { alert(`Профиль «${profile.name}» не поддерживается Connection Manager (тип API: ${profile.api || '—'}).`); return; }

            const lines = [
                `✓ Профиль найден: «${profile.name}»`,
                `API: ${profile.api || '—'}`,
                `Модель: ${profile.model || '—'}`,
                `URL: ${profile['api-url'] || '(по умолчанию)'}`,
                `Preset: ${profile.preset || '—'}`,
                `Proxy: ${profile.proxy ? 'задан' : '—'}`,
                `Ключ профиля: ${profile['secret-id'] ? 'задан ✓' : 'не задан (будет использован активный секрет ST)'}`,
            ];
            btn.innerHTML = '<i class="fa-solid fa-check"></i> ОК';
            setTimeout(() => { btn.innerHTML = orig; }, 1500);
            alert(lines.join('\n'));
        } catch (e) {
            btn.innerHTML = orig;
            const msg = /** @type {any} */ (e)?.message || e;
            alert(`Ошибка проверки: ${msg}`);
        }
    });

    // Профиль: кнопка «Тест» — реальный запрос через профиль, вывод результата
    document.getElementById('meddler-profile-test')?.addEventListener('click', async () => {
        const btn = document.getElementById('meddler-profile-test');
        if (!(btn instanceof HTMLButtonElement)) return;
        if (!settings.connectionProfile) { alert('Сначала выбери профиль!'); return; }
        if (!getConnectionProfile(settings.connectionProfile)) { alert('Профиль не найден. Нажми ⟳ для обновления.'); return; }
        const orig = btn.innerHTML;
        try {
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Генерирую...';
            const testPrompt = 'Ответь одной короткой репликой по-русски: скажи "Привет, меддлер на связи!" и больше ничего.';
            const reply = await generateWithConnectionProfile(testPrompt, 80);
            btn.innerHTML = '<i class="fa-solid fa-check"></i> ОК';
            setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2000);
            alert(`Ответ от профиля:\n\n${reply || '(пусто)'}`);
        } catch (e) {
            btn.innerHTML = '<i class="fa-solid fa-xmark"></i> Ошибка';
            setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2500);
            const err = /** @type {any} */ (e);
            const cause = err?.cause?.message || '';
            alert(`Ошибка: ${err?.message || e}${cause ? `\n\n${cause}` : ''}`);
        }
    });

    // Quick API
    bind('meddler-quickapi-enabled', 'change', /** @param {any} e */ e => { settings.quickApiEnabled = e.target.checked; updateQuickApiStatus(); saveSettings(); updateActiveModelBadge(); }, /** @param {any} el */ el => { el.checked = settings.quickApiEnabled; });

    // Quick API drawer — собственный, не зависящий от ST-классов
    {
        const toggle  = document.getElementById('meddler-quickapi-drawer-toggle');
        const content = document.getElementById('meddler-quickapi-drawer-content');
        if (toggle && content) {
            toggle.addEventListener('click', () => {
                const isOpen = content.classList.contains('open');
                content.classList.toggle('open', !isOpen);
                toggle.querySelector('.meddler-drawer-chevron')?.classList.toggle('rotated', !isOpen);
            });
        }
    }

    const urlInput = document.getElementById('meddler-quickapi-url');
    if (urlInput) {
        urlInput.value = settings.quickApiUrl || '';
        urlInput.addEventListener('change', e => { settings.quickApiUrl = e.target.value.trim(); updateQuickApiStatus(); saveSettings(); });
    }

    const keyInput = document.getElementById('meddler-quickapi-key');
    if (keyInput) {
        keyInput.value = settings.quickApiKey || '';
        keyInput.addEventListener('change', e => { settings.quickApiKey = e.target.value.trim(); saveSettings(); });
    }

    const modelSelect = document.getElementById('meddler-quickapi-model-select');
    const modelInput  = document.getElementById('meddler-quickapi-model-input');

    // Восстанавливаем состояние: если модель совпадает с одним из option — select; иначе — в ручной ввод
    if (modelInput) modelInput.value = settings.quickApiModel || '';

    if (modelSelect) {
        modelSelect.addEventListener('change', e => {
            const val = e.target.value;
            if (!val) return;
            settings.quickApiModel = val;
            if (modelInput) modelInput.value = ''; // сбрасываем ручной ввод
            updateQuickApiStatus(); saveSettings(); updateActiveModelBadge();
        });
    }

    if (modelInput) {
        modelInput.addEventListener('input', e => {
            const val = e.target.value.trim();
            settings.quickApiModel = val;
            if (val && modelSelect) modelSelect.value = ''; // сбрасываем select
            updateQuickApiStatus(); saveSettings(); updateActiveModelBadge();
        });
    }

    document.getElementById('meddler-quickapi-fetch-models')?.addEventListener('click', () => fetchQuickApiModels());
    document.getElementById('meddler-quickapi-connect')?.addEventListener('click', () => connectQuickApi());
    document.getElementById('meddler-quickapi-test')?.addEventListener('click', () => {
        if (!settings.quickApiEnabled) { alert('Включи Quick API!'); return; }
        if (!settings.quickApiUrl || !settings.quickApiModel) { alert('Введи URL и модель!'); return; }
        generateCommentary(true);
    });
    updateQuickApiStatus();
}

// =====================================
// Helpers для биндинга
// =====================================
function bind(id, event, handler, initializer) {
    const el = document.getElementById(id);
    if (!el) return;
    if (initializer) initializer(el);
    el.addEventListener(event, handler);
}

function bindRange(sliderId, inputId, lockId, getter, setter, lockedGetter, lockedSetter, min, max) {
    const slider = document.getElementById(sliderId);
    const input  = document.getElementById(inputId);
    const lock   = document.getElementById(lockId);
    if (!slider || !input) return;

    slider.value = getter(); input.value = getter();
    if (lockedGetter()) {
        slider.disabled = input.disabled = true;
        if (lock) { lock.innerHTML = '<i class="fa-solid fa-lock"></i>'; lock.classList.add('locked'); }
    }

    slider.addEventListener('input', e => {
        if (lockedGetter()) return;
        setter(parseInt(e.target.value)); input.value = getter();
    });
    input.addEventListener('change', e => {
        if (lockedGetter()) return;
        const v = Math.max(min, Math.min(max, parseInt(e.target.value) || min));
        setter(v); slider.value = input.value = v;
    });
    lock?.addEventListener('click', () => {
        lockedSetter(!lockedGetter());
        slider.disabled = input.disabled = lockedGetter();
        if (lock) { lock.innerHTML = lockedGetter() ? '<i class="fa-solid fa-lock"></i>' : '<i class="fa-solid fa-lock-open"></i>'; lock.classList.toggle('locked', lockedGetter()); }
    });
}

// =====================================
// Инициализация
// =====================================
jQuery(async () => {
    console.log(DEBUG_PREFIX, 'Инициализация ST-Meddler...');

    loadSettings();

    meddler.chatJustChanged = true;
    setTimeout(() => { meddler.chatJustChanged = false; }, 3000);

    createWidget();
    createBar();
    switchDisplayMode(getSettings().displayMode);

    await setupSettingsUI();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED,     onChatChanged);
    eventSource.on(event_types.CHARACTER_DELETED, populateCharacterDropdown);
    eventSource.on(event_types.CHARACTER_EDITED,  populateCharacterDropdown);

    eventSource.on(event_types.SETTINGS_LOADED, () => {
        setTimeout(async () => {
            populateCharacterDropdown();
            populateProfileDropdown();
            updateWidgetCharacter(); updateBarCharacter();
            updateActiveModelBadge();
        }, 500);
    });

    setTimeout(() => { populateCharacterDropdown(); populateProfileDropdown(); updateActiveModelBadge(); }, 1000);
    setTimeout(() => { populateCharacterDropdown(); populateProfileDropdown(); updateActiveModelBadge(); }, 3000);

    console.log(DEBUG_PREFIX, 'ST-Meddler готов!');
});
