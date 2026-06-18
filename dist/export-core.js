const DEFAULT_CONTEXT_WINDOW = 1;
const TEXT_ENCODER = new TextEncoder();
const CSV_BOM = '\uFEFF';
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;

function padNumber(value, width) {
    return String(value).padStart(width, '0');
}

function normalizeNewlines(value) {
    return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeText(value) {
    return normalizeNewlines(value).trimEnd();
}

function formatMaybe(value) {
    const text = normalizeText(value);
    return text || '(empty)';
}

function sanitizeSegment(value, fallback = 'untitled') {
    const sanitized = String(value || fallback)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+$/, '')
        .slice(0, 80);
    return sanitized || fallback;
}

function toPosixPath(value) {
    return String(value || '').replace(/\\/g, '/');
}

function getMessageText(record) {
    const displayText = record?.extra?.display_text;
    if (typeof displayText === 'string' && displayText.length > 0) {
        return displayText;
    }
    return typeof record?.mes === 'string' ? record.mes : '';
}

function getMessageRole(record) {
    if (record?.is_user === true) return 'user';
    if (record?.is_system === true) return 'system';
    return 'assistant';
}

function getDisplayRole(role) {
    if (role === 'user') return 'User';
    if (role === 'system') return 'System';
    return 'Assistant';
}

function markdownQuote(text) {
    const value = normalizeNewlines(text);
    if (!value) return '> (empty)';
    return value.split('\n').map(line => `> ${line}`).join('\n');
}

function csvEscape(value) {
    const text = normalizeNewlines(value).replace(/\n/g, '\\n');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function createTextFile(path, text) {
    return { path, data: `${normalizeNewlines(text)}\n` };
}

function getChatTitle(source) {
    return source.characterName || source.chatName || source.fileName || source.sourcePath || 'Untitled chat';
}

function getScopeDirectory(scope) {
    switch (scope) {
        case 'group':
            return 'group';
        case 'orphan-character':
            return 'orphan-character';
        case 'root':
            return 'root';
        case 'visible-api':
            return 'visible-api';
        case 'character':
        default:
            return 'character';
    }
}

function parseJsonl(raw) {
    const lines = normalizeNewlines(raw).split('\n');
    const records = [];
    const badLines = [];

    lines.forEach((line, index) => {
        const lineNumber = index + 1;
        if (!line.trim()) return;
        try {
            records.push({ lineNumber, record: JSON.parse(line) });
        } catch (error) {
            badLines.push({
                lineNumber,
                message: error instanceof Error ? error.message : String(error),
                preview: line.slice(0, 160),
            });
        }
    });

    return { records, badLines };
}

function buildChatModel(source, index) {
    const chatId = `C${padNumber(index + 1, 4)}`;
    const parsed = parseJsonl(source.raw ?? '');
    const scope = source.scope || 'character';
    const title = getChatTitle(source);
    const safeBaseName = `${chatId}-${sanitizeSegment(title)}`;
    const mdPath = `chats/${getScopeDirectory(scope)}/${safeBaseName}.md`;
    let visibleIndex = 0;
    let skippedSystem = 0;
    let skippedNonMessage = 0;
    let metadata = null;
    const messages = [];

    for (const item of parsed.records) {
        const record = item.record;
        if (item.lineNumber === 1 && record?.chat_metadata && !record?.mes) {
            metadata = record.chat_metadata;
            continue;
        }

        if (record?.is_system === true) {
            skippedSystem += 1;
            continue;
        }

        const text = normalizeText(getMessageText(record));
        const hasMessageShape = text || typeof record?.name === 'string' || typeof record?.is_user === 'boolean';
        if (!hasMessageShape) {
            skippedNonMessage += 1;
            continue;
        }

        visibleIndex += 1;
        const anchor = `${chatId}:R${padNumber(item.lineNumber, 5)}:V${padNumber(visibleIndex, 5)}`;
        messages.push({
            anchor,
            htmlId: anchor.replace(/:/g, '-'),
            chatId,
            lineNumber: item.lineNumber,
            visibleIndex,
            role: getMessageRole(record),
            name: String(record?.name || ''),
            sendDate: String(record?.send_date || ''),
            text,
        });
    }

    return {
        id: chatId,
        title,
        scope,
        sourcePath: toPosixPath(source.sourcePath || source.fileName || `${chatId}.jsonl`),
        fileName: source.fileName || '',
        chatName: source.chatName || '',
        characterName: source.characterName || '',
        avatar: source.avatar || '',
        groupId: source.groupId || '',
        mdPath,
        metadata,
        messages,
        badLines: parsed.badLines,
        skippedSystem,
        skippedNonMessage,
        rawBytes: TEXT_ENCODER.encode(source.raw ?? '').length,
    };
}

export function buildExportModel(sources, options = {}) {
    const generatedAt = options.generatedAt || new Date().toISOString();
    const contextWindow = Number.isFinite(options.contextWindow) ? Math.max(0, options.contextWindow) : DEFAULT_CONTEXT_WINDOW;
    const sortedSources = [...sources].sort((a, b) => String(a.sourcePath || a.fileName).localeCompare(String(b.sourcePath || b.fileName)));
    const chats = sortedSources.map(buildChatModel);
    const userInputs = [];

    for (const chat of chats) {
        chat.messages.forEach((message, index) => {
            if (message.role !== 'user') return;
            const before = chat.messages.slice(Math.max(0, index - contextWindow), index);
            const after = chat.messages.slice(index + 1, index + 1 + contextWindow);
            userInputs.push({
                ...message,
                chatTitle: chat.title,
                chatMdPath: chat.mdPath,
                sourcePath: chat.sourcePath,
                contextBefore: before,
                contextAfter: after,
            });
        });
    }

    const stats = {
        chatCount: chats.length,
        messageCount: chats.reduce((sum, chat) => sum + chat.messages.length, 0),
        userInputCount: userInputs.length,
        badLineCount: chats.reduce((sum, chat) => sum + chat.badLines.length, 0),
        skippedSystemCount: chats.reduce((sum, chat) => sum + chat.skippedSystem, 0),
        skippedNonMessageCount: chats.reduce((sum, chat) => sum + chat.skippedNonMessage, 0),
        groupChatCount: chats.filter(chat => chat.scope === 'group').length,
        orphanChatCount: chats.filter(chat => chat.scope === 'orphan-character').length,
        rootChatCount: chats.filter(chat => chat.scope === 'root').length,
        sourceBytes: chats.reduce((sum, chat) => sum + chat.rawBytes, 0),
    };

    return {
        generatedAt,
        contextWindow,
        sourceMode: options.sourceMode || 'unknown',
        chats,
        userInputs,
        stats,
    };
}

function renderMessage(message, headingLevel = 3) {
    const heading = '#'.repeat(headingLevel);
    const meta = [
        `role=${getDisplayRole(message.role)}`,
        `visible=${message.visibleIndex}`,
        `line=${message.lineNumber}`,
        message.name ? `name=${message.name}` : '',
        message.sendDate ? `date=${message.sendDate}` : '',
    ].filter(Boolean).join(' | ');

    return [
        `<a id="${message.htmlId}"></a>`,
        `${heading} ${message.anchor} | ${meta}`,
        '',
        markdownQuote(message.text),
    ].join('\n');
}

function renderContextList(messages) {
    if (!messages.length) return '(none)';
    return messages.map(message => [
        `- ${message.anchor} | ${getDisplayRole(message.role)} | ${message.name || '(no name)'}`,
        '',
        markdownQuote(message.text),
    ].join('\n')).join('\n\n');
}

export function renderChatMarkdown(chat) {
    const body = chat.messages.length
        ? chat.messages.map(message => renderMessage(message)).join('\n\n')
        : '_No visible messages._';

    return [
        `# ${chat.id} ${chat.title}`,
        '',
        `- Source: \`${chat.sourcePath}\``,
        `- Scope: \`${chat.scope}\``,
        `- Visible messages: ${chat.messages.length}`,
        `- User inputs: ${chat.messages.filter(message => message.role === 'user').length}`,
        `- Skipped system messages: ${chat.skippedSystem}`,
        `- Bad JSONL lines: ${chat.badLines.length}`,
        '',
        '## Messages',
        '',
        body,
    ].join('\n');
}

export function renderAllUserInputsMarkdown(model, inputs = model.userInputs) {
    const body = inputs.length
        ? inputs.map(input => [
            `## ${input.anchor} | ${input.chatTitle}`,
            '',
            `- Source chat: [${input.chatMdPath}](./${input.chatMdPath}#${input.htmlId})`,
            `- Source JSONL: \`${input.sourcePath}\``,
            `- Visible index: ${input.visibleIndex}`,
            `- JSONL line: ${input.lineNumber}`,
            `- Name: ${input.name || '(no name)'}`,
            input.sendDate ? `- Date: ${input.sendDate}` : '',
            '',
            '### Previous context',
            '',
            renderContextList(input.contextBefore),
            '',
            '### User input',
            '',
            markdownQuote(input.text),
            '',
            '### Next context',
            '',
            renderContextList(input.contextAfter),
        ].filter(line => line !== '').join('\n')).join('\n\n')
        : '_No user inputs found._';

    return [
        '# All User Inputs',
        '',
        `- Generated at: ${model.generatedAt}`,
        `- Context window: ${model.contextWindow}`,
        `- User inputs: ${inputs.length}`,
        '',
        body,
    ].join('\n');
}

function renderUserInputsByChatMarkdown(model, chat) {
    const inputs = model.userInputs.filter(input => input.chatId === chat.id);
    return renderAllUserInputsMarkdown(model, inputs).replace('# All User Inputs', `# User Inputs - ${chat.id} ${chat.title}`);
}

export function renderIndexMarkdown(model) {
    const rows = model.chats.map(chat => {
        const userCount = chat.messages.filter(message => message.role === 'user').length;
        return `| ${chat.id} | ${chat.scope} | [${chat.title}](${chat.mdPath}) | ${chat.messages.length} | ${userCount} | \`${chat.sourcePath}\` |`;
    }).join('\n');

    return [
        '# SillyTavern Chat Export Index',
        '',
        `- Generated at: ${model.generatedAt}`,
        `- Source mode: ${model.sourceMode}`,
        `- Chats: ${model.stats.chatCount}`,
        `- Visible messages: ${model.stats.messageCount}`,
        `- User inputs: ${model.stats.userInputCount}`,
        '',
        '| ID | Scope | Chat | Messages | User Inputs | Source |',
        '|---|---|---|---:|---:|---|',
        rows || '| - | - | - | 0 | 0 | - |',
    ].join('\n');
}

export function renderStatsMarkdown(model) {
    return [
        '# Export Stats',
        '',
        `- Generated at: ${model.generatedAt}`,
        `- Source mode: ${model.sourceMode}`,
        `- Chats: ${model.stats.chatCount}`,
        `- Group chats: ${model.stats.groupChatCount}`,
        `- Orphan chats: ${model.stats.orphanChatCount}`,
        `- Root chat files: ${model.stats.rootChatCount}`,
        `- Visible messages: ${model.stats.messageCount}`,
        `- User inputs: ${model.stats.userInputCount}`,
        `- Bad JSONL lines: ${model.stats.badLineCount}`,
        `- Skipped system messages: ${model.stats.skippedSystemCount}`,
        `- Skipped non-message records: ${model.stats.skippedNonMessageCount}`,
        `- Source bytes: ${model.stats.sourceBytes}`,
    ].join('\n');
}

export function renderReportMarkdown(model) {
    const badLineDetails = model.chats
        .filter(chat => chat.badLines.length > 0)
        .map(chat => [
            `## ${chat.id} ${chat.title}`,
            '',
            ...chat.badLines.map(line => `- Line ${line.lineNumber}: ${line.message}; preview=\`${line.preview.replace(/`/g, "'")}\``),
        ].join('\n'))
        .join('\n\n');

    return [
        '# Export Report',
        '',
        `- Generated at: ${model.generatedAt}`,
        `- Source mode: ${model.sourceMode}`,
        `- Context window: ${model.contextWindow}`,
        `- Chats processed: ${model.stats.chatCount}`,
        `- Bad JSONL lines: ${model.stats.badLineCount}`,
        `- Skipped system messages: ${model.stats.skippedSystemCount}`,
        `- Skipped non-message records: ${model.stats.skippedNonMessageCount}`,
        '',
        '## Coverage Notes',
        '',
        model.sourceMode === 'browser-visible-api'
            ? 'This browser export uses SillyTavern visible chat APIs. Orphan chat directories without matching characters may require the local Node script.'
            : 'This local script export reads chat files from the selected data directory and can include orphan chat directories.',
        '',
        '## Bad Lines',
        '',
        badLineDetails || '_No bad JSONL lines found._',
    ].join('\n');
}

export function renderUserInputCsv(model) {
    const header = [
        'anchor',
        'chat_id',
        'chat_title',
        'source_path',
        'chat_md_path',
        'line_number',
        'visible_index',
        'name',
        'send_date',
        'text',
    ];
    const rows = model.userInputs.map(input => [
        input.anchor,
        input.chatId,
        input.chatTitle,
        input.sourcePath,
        input.chatMdPath,
        input.lineNumber,
        input.visibleIndex,
        input.name,
        input.sendDate,
        input.text,
    ].map(csvEscape).join(','));
    return `${CSV_BOM}${[header.join(','), ...rows].join('\n')}`;
}

export function renderUserInputsOnlyMarkdown(model) {
    const body = model.userInputs.length
        ? model.userInputs.map(input => [
            `## ${input.anchor} | ${input.chatTitle}`,
            '',
            `- Source chat: \`${input.chatMdPath}\``,
            `- Source JSONL: \`${input.sourcePath}\``,
            `- Visible index: ${input.visibleIndex}`,
            `- JSONL line: ${input.lineNumber}`,
            `- Name: ${input.name || '(no name)'}`,
            input.sendDate ? `- Date: ${input.sendDate}` : '',
            '',
            markdownQuote(input.text),
        ].filter(line => line !== '').join('\n')).join('\n\n')
        : '_No user inputs found._';

    return [
        '# User Inputs Only',
        '',
        `- Generated at: ${model.generatedAt}`,
        `- User inputs: ${model.userInputs.length}`,
        '',
        body,
    ].join('\n');
}

export function renderManifestJson(model) {
    return JSON.stringify({
        generatedAt: model.generatedAt,
        sourceMode: model.sourceMode,
        contextWindow: model.contextWindow,
        stats: model.stats,
        chats: model.chats.map(chat => ({
            id: chat.id,
            title: chat.title,
            scope: chat.scope,
            sourcePath: chat.sourcePath,
            mdPath: chat.mdPath,
            visibleMessages: chat.messages.length,
            userInputs: chat.messages.filter(message => message.role === 'user').length,
            badLines: chat.badLines.length,
        })),
    }, null, 2);
}

export function createPackageFiles(model) {
    const chatFiles = model.chats.map(chat => createTextFile(chat.mdPath, renderChatMarkdown(chat)));
    const userByChatFiles = model.chats
        .filter(chat => chat.messages.some(message => message.role === 'user'))
        .map(chat => createTextFile(`by-chat/${sanitizeSegment(`${chat.id}-${chat.title}`)}.md`, renderUserInputsByChatMarkdown(model, chat)));

    return {
        full: [
            createTextFile('INDEX.md', renderIndexMarkdown(model)),
            createTextFile('EXPORT_REPORT.md', renderReportMarkdown(model)),
            createTextFile('USER_INPUTS_ALL.md', renderAllUserInputsMarkdown(model)),
            ...chatFiles,
        ],
        user: [
            createTextFile('ALL_USER_INPUTS.md', renderAllUserInputsMarkdown(model)),
            createTextFile('USER_INPUT_INDEX.csv', renderUserInputCsv(model)),
            createTextFile('EXPORT_REPORT.md', renderReportMarkdown(model)),
            ...userByChatFiles,
        ],
        index: [
            createTextFile('MANIFEST.json', renderManifestJson(model)),
            createTextFile('INDEX.md', renderIndexMarkdown(model)),
            createTextFile('STATS.md', renderStatsMarkdown(model)),
            createTextFile('USER_INPUT_INDEX.csv', renderUserInputCsv(model)),
            createTextFile('EXPORT_REPORT.md', renderReportMarkdown(model)),
        ],
    };
}

export function createUserOnlyPackageFiles(model) {
    return [
        createTextFile('USER_INPUTS_ONLY.md', renderUserInputsOnlyMarkdown(model)),
        createTextFile('USER_INPUT_INDEX.csv', renderUserInputCsv(model)),
        createTextFile('EXPORT_REPORT.md', renderReportMarkdown(model)),
    ];
}

function prefixPackageFiles(files, directory) {
    return files.map(file => ({
        path: `${directory}/${file.path}`,
        data: file.data,
    }));
}

function getZipDateParts(date = new Date()) {
    const year = Math.max(date.getFullYear(), 1980);
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { dosTime, dosDate };
}

let crcTable = null;

function getCrcTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let value = i;
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
        }
        crcTable[i] = value >>> 0;
    }
    return crcTable;
}

function crc32(data) {
    const table = getCrcTable();
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i += 1) {
        crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeUint16(output, value) {
    output.push(value & 0xFF, (value >>> 8) & 0xFF);
}

function writeUint32(output, value) {
    output.push(value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF);
}

function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    return TEXT_ENCODER.encode(String(data ?? ''));
}

function appendBytes(output, bytes) {
    for (const byte of bytes) output.push(byte);
}

function createZipFromPreparedEntries(entries) {
    const output = [];
    const centralDirectory = [];
    const { dosTime, dosDate } = getZipDateParts();
    let offset = 0;

    for (const entry of entries) {
        const nameBytes = TEXT_ENCODER.encode(toPosixPath(entry.path));
        const dataBytes = entry.dataBytes;
        const payloadBytes = entry.payloadBytes;
        const method = entry.method;
        const checksum = crc32(dataBytes);
        const localHeader = [];

        writeUint32(localHeader, 0x04034B50);
        writeUint16(localHeader, 20);
        writeUint16(localHeader, 0x0800);
        writeUint16(localHeader, method);
        writeUint16(localHeader, dosTime);
        writeUint16(localHeader, dosDate);
        writeUint32(localHeader, checksum);
        writeUint32(localHeader, payloadBytes.length);
        writeUint32(localHeader, dataBytes.length);
        writeUint16(localHeader, nameBytes.length);
        writeUint16(localHeader, 0);
        appendBytes(localHeader, nameBytes);

        appendBytes(output, localHeader);
        appendBytes(output, payloadBytes);

        const centralHeader = [];
        writeUint32(centralHeader, 0x02014B50);
        writeUint16(centralHeader, 20);
        writeUint16(centralHeader, 20);
        writeUint16(centralHeader, 0x0800);
        writeUint16(centralHeader, method);
        writeUint16(centralHeader, dosTime);
        writeUint16(centralHeader, dosDate);
        writeUint32(centralHeader, checksum);
        writeUint32(centralHeader, payloadBytes.length);
        writeUint32(centralHeader, dataBytes.length);
        writeUint16(centralHeader, nameBytes.length);
        writeUint16(centralHeader, 0);
        writeUint16(centralHeader, 0);
        writeUint16(centralHeader, 0);
        writeUint16(centralHeader, 0);
        writeUint32(centralHeader, 0);
        writeUint32(centralHeader, offset);
        appendBytes(centralHeader, nameBytes);

        appendBytes(centralDirectory, centralHeader);
        offset += localHeader.length + payloadBytes.length;
    }

    const centralDirectoryOffset = output.length;
    appendBytes(output, centralDirectory);
    const centralDirectorySize = centralDirectory.length;
    const endRecord = [];
    writeUint32(endRecord, 0x06054B50);
    writeUint16(endRecord, 0);
    writeUint16(endRecord, 0);
    writeUint16(endRecord, entries.length);
    writeUint16(endRecord, entries.length);
    writeUint32(endRecord, centralDirectorySize);
    writeUint32(endRecord, centralDirectoryOffset);
    writeUint16(endRecord, 0);
    appendBytes(output, endRecord);

    return new Uint8Array(output);
}

export function createZip(files) {
    const entries = files.map(file => {
        const dataBytes = toBytes(file.data);
        return {
            path: file.path,
            dataBytes,
            payloadBytes: dataBytes,
            method: ZIP_METHOD_STORE,
        };
    });
    return createZipFromPreparedEntries(entries);
}

function yieldToEventLoop() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

export async function createCompressedZip(files, deflateRaw, onProgress) {
    if (typeof deflateRaw !== 'function') {
        throw new Error('Deflate compressor is required for compressed ZIP export.');
    }

    const entries = [];
    for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        onProgress?.({
            stage: 'compressing',
            current: index,
            total: files.length,
            path: file.path,
        });
        const dataBytes = toBytes(file.data);
        const compressedBytes = dataBytes.length > 0 ? await deflateRaw(dataBytes) : dataBytes;
        const useCompressed = compressedBytes.length > 0 && compressedBytes.length < dataBytes.length;
        entries.push({
            path: file.path,
            dataBytes,
            payloadBytes: useCompressed ? compressedBytes : dataBytes,
            method: useCompressed ? ZIP_METHOD_DEFLATE : ZIP_METHOD_STORE,
        });
        onProgress?.({
            stage: 'compressed',
            current: index + 1,
            total: files.length,
            path: file.path,
        });
    }
    onProgress?.({
        stage: 'assembling',
        current: files.length,
        total: files.length,
        path: '',
    });
    await yieldToEventLoop();
    return createZipFromPreparedEntries(entries);
}

export function createChatExportPackages(model) {
    const files = createPackageFiles(model);
    return [
        {
            key: 'full',
            fileName: 'full-md.zip',
            bytes: createZip(files.full),
        },
        {
            key: 'user',
            fileName: 'user-inputs.zip',
            bytes: createZip(files.user),
        },
        {
            key: 'index',
            fileName: 'index-stats.zip',
            bytes: createZip(files.index),
        },
    ];
}

export function createChatExportBundle(model) {
    const files = createPackageFiles(model);
    return createSelectedChatExportBundle(model, {
        key: 'bundle',
        fileName: 'sillytavern-chat-export.zip',
        groups: [
            ['full-md', files.full],
            ['user-inputs', files.user],
            ['index-stats', files.index],
        ],
    });
}

function createSelectedChatExportBundle(model, definition) {
    return {
        key: definition.key,
        fileName: definition.fileName,
        bytes: createZip(definition.groups.flatMap(([directory, files]) => prefixPackageFiles(files, directory))),
    };
}

function getChatExportBundleDefinition(model, mode = 'full') {
    const files = createPackageFiles(model);

    switch (mode) {
        case 'user-context':
            return {
                key: 'user-context',
                fileName: 'sillytavern-user-context-export.zip',
                groups: [
                    ['user-inputs', files.user],
                    ['index-stats', files.index],
                ],
            };
        case 'user-only':
            return {
                key: 'user-only',
                fileName: 'sillytavern-user-inputs-only.zip',
                groups: [
                    ['user-only', createUserOnlyPackageFiles(model)],
                ],
            };
        case 'index-stats':
            return {
                key: 'index-stats',
                fileName: 'sillytavern-chat-index-stats.zip',
                groups: [
                    ['index-stats', files.index],
                ],
            };
        case 'full':
        default:
            return {
                key: 'bundle',
                fileName: 'sillytavern-chat-export.zip',
                groups: [
                    ['full-md', files.full],
                    ['user-inputs', files.user],
                    ['index-stats', files.index],
                ],
            };
    }
}

export function createChatExportBundleByMode(model, mode = 'full') {
    return createSelectedChatExportBundle(model, getChatExportBundleDefinition(model, mode));
}

export async function createCompressedChatExportBundleByMode(model, mode, deflateRaw, onProgress) {
    const definition = getChatExportBundleDefinition(model, mode);
    return {
        key: definition.key,
        fileName: definition.fileName,
        bytes: await createCompressedZip(
            definition.groups.flatMap(([directory, files]) => prefixPackageFiles(files, directory)),
            deflateRaw,
            onProgress,
        ),
    };
}
