import { characters, getRequestHeaders, saveChatConditional } from '../../../../../script.js';
import { download } from '../../../../utils.js';
import { buildExportModel, createCompressedChatExportBundleByMode } from './export-core.js';

const BUTTON_ID = 'acsus_chat_exporter_button';
const EXPORT_MENU_LABEL = '聊天记录导出';
const DIALOG_ID = 'acsus_chat_exporter_dialog';
const PROGRESS_MIN = 0;
const PROGRESS_MAX = 100;
const EXPORT_MODES = [
    {
        value: 'user-context',
        title: 'AI 阅读包',
        description: 'User 输入 + 前后 1 条上下文 + 索引统计',
    },
    {
        value: 'user-only',
        title: '纯 User 输入',
        description: '只含 User 输入 MD/CSV，文件最小',
    },
    {
        value: 'full',
        title: '完整归档',
        description: '全部聊天 MD + User 输入 + 索引统计',
    },
    {
        value: 'index-stats',
        title: '索引统计',
        description: 'manifest、索引、统计、CSV',
    },
];
let isExporting = false;

function showSuccess(message) {
    if (globalThis.toastr) {
        globalThis.toastr.success(message);
    }
}

function showError(message) {
    if (globalThis.toastr) {
        globalThis.toastr.error(message);
    }
}

function setButtonBusy(button, busy, label = EXPORT_MENU_LABEL) {
    const icon = button.querySelector('.extensionsMenuExtensionButton');
    const text = button.querySelector('.acsus-chat-exporter-label');
    button.classList.toggle('acsus-chat-exporter-busy', busy);
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (icon) {
        icon.classList.toggle('fa-file-zipper', !busy);
        icon.classList.toggle('fa-spinner', busy);
        icon.classList.toggle('fa-spin', busy);
    }
    if (text) {
        text.textContent = label;
    }
}

function getCharacterNameByAvatar(avatar) {
    const character = characters.find(item => item?.avatar === avatar);
    return character?.name || avatar?.replace(/\.png$/i, '') || '';
}

async function fetchRecentChats() {
    const response = await fetch('/api/chats/recent', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            max: Number.MAX_SAFE_INTEGER - 1,
            pinned: [],
            metadata: false,
        }),
        cache: 'no-cache',
    });

    if (!response.ok) {
        throw new Error('无法读取聊天列表。');
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [];
}

async function fetchRawChat(chatInfo) {
    const isGroup = Boolean(chatInfo.group);
    const body = {
        is_group: isGroup,
        avatar_url: isGroup ? null : chatInfo.avatar,
        file: chatInfo.file_name,
        exportfilename: chatInfo.file_name,
        format: 'jsonl',
    };
    const response = await fetch('/api/chats/export', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data?.message || `无法导出 ${chatInfo.file_name}`);
    }
    return String(data.result || '');
}

function makeSourceFromChatInfo(chatInfo, raw) {
    const isGroup = Boolean(chatInfo.group);
    const avatarName = chatInfo.avatar ? chatInfo.avatar.replace(/\.png$/i, '') : '';
    const sourcePath = isGroup
        ? `visible-api/group chats/${chatInfo.file_name}`
        : `visible-api/chats/${avatarName}/${chatInfo.file_name}`;

    return {
        scope: 'visible-api',
        sourcePath,
        fileName: chatInfo.file_name || '',
        chatName: String(chatInfo.file_name || '').replace(/\.jsonl$/i, ''),
        characterName: isGroup ? `Group ${chatInfo.group}` : getCharacterNameByAvatar(chatInfo.avatar),
        avatar: chatInfo.avatar || '',
        groupId: chatInfo.group || '',
        raw,
    };
}

async function collectBrowserVisibleSources(onProgress) {
    const chats = await fetchRecentChats();
    const sources = [];
    for (let index = 0; index < chats.length; index += 1) {
        const chatInfo = chats[index];
        onProgress(index + 1, chats.length);
        const raw = await fetchRawChat(chatInfo);
        sources.push(makeSourceFromChatInfo(chatInfo, raw));
    }
    return sources;
}

async function deflateRaw(dataBytes) {
    if (typeof CompressionStream !== 'function') {
        throw new Error('当前浏览器不支持 ZIP 压缩导出。请换新版 Chrome/Edge，或使用本地脚本导出。');
    }

    const formats = ['deflate-raw', 'deflate'];
    for (const format of formats) {
        try {
            const stream = new Blob([dataBytes]).stream().pipeThrough(new CompressionStream(format));
            const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
            if (format === 'deflate') {
                if (compressed.length <= 6) {
                    throw new Error('Deflate output is too small.');
                }
                return compressed.slice(2, -4);
            }
            return compressed;
        } catch (error) {
            if (format === formats[formats.length - 1]) {
                throw error;
            }
        }
    }

    throw new Error('当前浏览器不支持 ZIP 压缩导出。');
}

function closeExportDialog(dialog) {
    dialog.remove();
    if (dialog.acsusEscapeHandler) {
        document.removeEventListener('keydown', dialog.acsusEscapeHandler);
    }
}

function clampProgress(value) {
    return Math.max(PROGRESS_MIN, Math.min(PROGRESS_MAX, Math.round(Number(value) || 0)));
}

function createProgressDialog() {
    document.getElementById(DIALOG_ID)?.remove();

    const overlay = document.createElement('div');
    overlay.id = DIALOG_ID;
    overlay.className = 'acsus-chat-exporter-dialog-backdrop acsus-chat-exporter-progress-backdrop';
    overlay.innerHTML = [
        '<div class="acsus-chat-exporter-dialog acsus-chat-exporter-progress-dialog" role="dialog" aria-modal="true" aria-labelledby="acsus_chat_exporter_progress_title">',
        '<div class="acsus-chat-exporter-dialog-header">',
        '<div id="acsus_chat_exporter_progress_title" class="acsus-chat-exporter-dialog-title">正在准备聊天导出</div>',
        '<div class="fa-solid fa-spinner fa-spin acsus-chat-exporter-progress-icon" aria-hidden="true"></div>',
        '</div>',
        '<div class="acsus-chat-exporter-progress-body">',
        '<p class="acsus-chat-exporter-progress-message">浏览器正在整理并压缩 ZIP，请等待完成，不要刷新网页或关闭标签页。</p>',
        '<div class="acsus-chat-exporter-progress-track" aria-hidden="true">',
        '<div class="acsus-chat-exporter-progress-bar"></div>',
        '</div>',
        '<div class="acsus-chat-exporter-progress-meta">',
        '<span class="acsus-chat-exporter-progress-stage">初始化</span>',
        '<span class="acsus-chat-exporter-progress-percent">0%</span>',
        '</div>',
        '<div class="acsus-chat-exporter-progress-detail">正在启动导出任务...</div>',
        '</div>',
        '<div class="acsus-chat-exporter-dialog-actions">',
        '<button type="button" class="menu_button acsus-chat-exporter-progress-close" disabled>处理中...</button>',
        '</div>',
        '</div>',
    ].join('');

    const title = overlay.querySelector('.acsus-chat-exporter-dialog-title');
    const icon = overlay.querySelector('.acsus-chat-exporter-progress-icon');
    const message = overlay.querySelector('.acsus-chat-exporter-progress-message');
    const bar = overlay.querySelector('.acsus-chat-exporter-progress-bar');
    const stage = overlay.querySelector('.acsus-chat-exporter-progress-stage');
    const percent = overlay.querySelector('.acsus-chat-exporter-progress-percent');
    const detail = overlay.querySelector('.acsus-chat-exporter-progress-detail');
    const closeButton = overlay.querySelector('.acsus-chat-exporter-progress-close');

    const update = ({
        titleText,
        iconClass = 'fa-solid fa-spinner fa-spin',
        messageText,
        stageText,
        detailText,
        progress,
        closable = false,
        closeLabel = '完成',
        tone = '',
    } = {}) => {
        const nextProgress = clampProgress(progress);
        overlay.classList.toggle('is-success', tone === 'success');
        overlay.classList.toggle('is-error', tone === 'error');
        if (titleText) title.textContent = titleText;
        if (iconClass) icon.className = `${iconClass} acsus-chat-exporter-progress-icon`;
        if (messageText) message.textContent = messageText;
        if (stageText) stage.textContent = stageText;
        if (detailText) detail.textContent = detailText;
        bar.style.width = `${nextProgress}%`;
        percent.textContent = `${nextProgress}%`;
        closeButton.disabled = !closable;
        closeButton.textContent = closable ? closeLabel : '处理中...';
        if (closable) {
            closeButton.focus();
        }
    };

    closeButton.addEventListener('click', () => {
        if (!closeButton.disabled) {
            closeExportDialog(overlay);
        }
    });

    document.body.append(overlay);
    update({ progress: 1 });

    return { update };
}

function openExportDialog(button) {
    if (isExporting || document.getElementById(DIALOG_ID)) return;

    const overlay = document.createElement('div');
    overlay.id = DIALOG_ID;
    overlay.className = 'acsus-chat-exporter-dialog-backdrop';
    overlay.innerHTML = [
        '<div class="acsus-chat-exporter-dialog" role="dialog" aria-modal="true" aria-labelledby="acsus_chat_exporter_dialog_title">',
        '<div class="acsus-chat-exporter-dialog-header">',
        '<div id="acsus_chat_exporter_dialog_title" class="acsus-chat-exporter-dialog-title">聊天记录导出</div>',
        '<button type="button" class="menu_button menu_button_icon acsus-chat-exporter-dialog-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>',
        '</div>',
        '<div class="acsus-chat-exporter-mode-list">',
        EXPORT_MODES.map((mode, index) => [
            `<label class="acsus-chat-exporter-mode${index === 0 ? ' is-selected' : ''}">`,
            `<input type="radio" name="acsus_chat_exporter_mode" value="${mode.value}"${index === 0 ? ' checked' : ''}>`,
            '<span>',
            `<strong>${mode.title}</strong>`,
            `<small>${mode.description}</small>`,
            '</span>',
            '</label>',
        ].join('')).join(''),
        '</div>',
        '<div class="acsus-chat-exporter-dialog-actions">',
        '<button type="button" class="menu_button acsus-chat-exporter-cancel">取消</button>',
        '<button type="button" class="menu_button acsus-chat-exporter-confirm"><i class="fa-solid fa-download"></i><span>导出</span></button>',
        '</div>',
        '</div>',
    ].join('');

    const closeButton = overlay.querySelector('.acsus-chat-exporter-dialog-close');
    const cancelButton = overlay.querySelector('.acsus-chat-exporter-cancel');
    const confirmButton = overlay.querySelector('.acsus-chat-exporter-confirm');
    const radioInputs = [...overlay.querySelectorAll('input[name="acsus_chat_exporter_mode"]')];
    const labels = [...overlay.querySelectorAll('.acsus-chat-exporter-mode')];

    radioInputs.forEach((input) => {
        input.addEventListener('change', () => {
            labels.forEach(label => label.classList.toggle('is-selected', label.contains(input) && input.checked));
        });
    });

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closeExportDialog(overlay);
        }
    });
    closeButton.addEventListener('click', () => closeExportDialog(overlay));
    cancelButton.addEventListener('click', () => closeExportDialog(overlay));
    confirmButton.addEventListener('click', () => {
        const selected = overlay.querySelector('input[name="acsus_chat_exporter_mode"]:checked');
        const mode = selected?.value || EXPORT_MODES[0].value;
        closeExportDialog(overlay);
        runExport(button, mode);
    });

    overlay.acsusEscapeHandler = (event) => {
        if (event.key === 'Escape') {
            closeExportDialog(overlay);
        }
    };
    document.addEventListener('keydown', overlay.acsusEscapeHandler);
    document.body.append(overlay);
    overlay.querySelector('input[name="acsus_chat_exporter_mode"]:checked')?.focus();
}

async function runExport(button, mode) {
    if (isExporting) return;
    isExporting = true;
    setButtonBusy(button, true, '导出中...');
    const progressDialog = createProgressDialog();

    try {
        progressDialog.update({
            progress: 3,
            stageText: '保存当前聊天',
            detailText: '正在保存当前聊天，避免漏掉最新消息。',
        });
        await saveChatConditional();

        progressDialog.update({
            progress: 8,
            stageText: '读取聊天列表',
            detailText: '正在读取 SillyTavern 可见聊天列表。',
        });
        const sources = await collectBrowserVisibleSources((current, total) => {
            const progress = 10 + ((current / Math.max(total, 1)) * 55);
            setButtonBusy(button, true, `导出中 ${current}/${total}`);
            progressDialog.update({
                progress,
                stageText: `读取聊天 ${current}/${total}`,
                detailText: '正在从 SillyTavern API 读取聊天内容。',
            });
        });

        if (sources.length === 0) {
            throw new Error('没有找到可导出的聊天。');
        }

        progressDialog.update({
            progress: 70,
            stageText: '整理 Markdown',
            detailText: '正在整理聊天、User 输入、上下文和索引。',
        });
        const model = buildExportModel(sources, {
            contextWindow: 1,
            sourceMode: 'browser-visible-api',
        });

        setButtonBusy(button, true, '正在压缩...');
        progressDialog.update({
            progress: 76,
            stageText: '压缩 ZIP',
            detailText: '正在压缩导出文件，手机上可能需要多等一会。',
        });
        const bundle = await createCompressedChatExportBundleByMode(model, mode, deflateRaw, (event) => {
            if (event.stage === 'assembling') {
                progressDialog.update({
                    progress: 97,
                    stageText: '写入 ZIP',
                    detailText: '正在写入 ZIP 目录，请继续等待。',
                });
                return;
            }

            const progress = 76 + ((event.current / Math.max(event.total, 1)) * 20);
            progressDialog.update({
                progress,
                stageText: `压缩文件 ${event.current}/${event.total}`,
                detailText: event.path ? `正在处理：${event.path}` : '正在压缩导出文件。',
            });
        });

        progressDialog.update({
            progress: 99,
            stageText: '触发下载',
            detailText: `正在交给浏览器下载：${bundle.fileName}`,
        });
        download(bundle.bytes, bundle.fileName, 'application/zip');
        progressDialog.update({
            titleText: '聊天导出完成',
            iconClass: 'fa-solid fa-circle-check',
            messageText: 'ZIP 已经交给浏览器下载。手机如果没有弹出提示，请打开浏览器下载列表查看。',
            stageText: '完成',
            detailText: `${model.stats.chatCount} 个聊天，${model.stats.userInputCount} 条 User 输入。`,
            progress: 100,
            closable: true,
            closeLabel: '完成',
            tone: 'success',
        });
        showSuccess(`聊天导出完成：${model.stats.chatCount} 个聊天，${model.stats.userInputCount} 条 User 输入。`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        progressDialog.update({
            titleText: '聊天导出失败',
            iconClass: 'fa-solid fa-circle-exclamation',
            messageText: '导出没有完成，当前页面可以继续使用。',
            stageText: '失败',
            detailText: message,
            progress: 100,
            closable: true,
            closeLabel: '关闭',
            tone: 'error',
        });
        showError(message);
    } finally {
        isExporting = false;
        setButtonBusy(button, false);
    }
}

function createButton() {
    const button = document.createElement('div');
    button.id = BUTTON_ID;
    button.className = 'list-group-item flex-container flexGap5';
    button.title = EXPORT_MENU_LABEL;
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    button.innerHTML = [
        '<div class="fa-solid fa-file-zipper extensionsMenuExtensionButton"></div>',
        '<span class="acsus-chat-exporter-label">聊天记录导出</span>',
    ].join('');
    button.addEventListener('click', () => openExportDialog(button));
    button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openExportDialog(button);
        }
    });
    return button;
}

export function init() {
    if (document.getElementById(BUTTON_ID)) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    menu.append(createButton());
}
