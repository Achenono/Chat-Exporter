#!/usr/bin/env node
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw } from 'node:zlib';

const DEFAULT_DATA_DIR = 'data/default-user';
const DEFAULT_OUT_DIR = 'tmp/chat-exporter-test';
const DEFAULT_CONTEXT_WINDOW = 1;
const CSV_BOM = '\uFEFF';
const ZIP_METHOD_DEFLATE = 8;
const ZIP_FLAG_UTF8_DATA_DESCRIPTOR = 0x0808;
const TEXT_ENCODER = new TextEncoder();
const MAX_BAD_LINE_SAMPLES = 200;

function parseArgs(argv) {
    const options = {
        dataDir: DEFAULT_DATA_DIR,
        outDir: DEFAULT_OUT_DIR,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        packages: new Set(['full', 'user', 'index']),
        limit: null,
        splitPackages: false,
        mode: 'full',
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--data-dir') {
            options.dataDir = argv[++index];
        } else if (arg === '--out-dir') {
            options.outDir = argv[++index];
        } else if (arg === '--context-window') {
            options.contextWindow = Number(argv[++index]);
        } else if (arg === '--packages') {
            options.packages = new Set(String(argv[++index] || '').split(',').map(item => item.trim()).filter(Boolean));
        } else if (arg === '--limit') {
            options.limit = Number(argv[++index]);
        } else if (arg === '--split-packages') {
            options.splitPackages = true;
        } else if (arg === '--mode') {
            options.mode = String(argv[++index] || 'full');
        }
    }

    return options;
}

function padNumber(value, width) {
    return String(value).padStart(width, '0');
}

function normalizeNewlines(value) {
    return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeText(value) {
    return normalizeNewlines(value).trimEnd();
}

function toPosixPath(value) {
    return String(value || '').replace(/\\/g, '/');
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

function markdownQuote(text) {
    const value = normalizeNewlines(text);
    if (!value) return '> (empty)';
    return value.split('\n').map(line => `> ${line}`).join('\n');
}

function csvEscape(value) {
    const text = normalizeNewlines(value).replace(/\n/g, '\\n');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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

function getChatTitle(source) {
    return source.characterName || source.chatName || source.fileName || source.sourcePath || 'Untitled chat';
}

function makeChatDescriptor(source, index) {
    const id = `C${padNumber(index + 1, 4)}`;
    const scope = source.scope || 'character';
    const title = getChatTitle(source);
    const safeBaseName = `${id}-${sanitizeSegment(title)}`;
    return {
        ...source,
        id,
        title,
        scope,
        mdPath: `chats/${getScopeDirectory(scope)}/${safeBaseName}.md`,
    };
}

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function readDirSafe(directory, options = {}) {
    try {
        return await fs.readdir(directory, options);
    } catch {
        return [];
    }
}

async function collectCharacterNames(dataDir) {
    const charactersDir = path.join(dataDir, 'characters');
    const files = await readDirSafe(charactersDir, { withFileTypes: true });
    return new Set(files
        .filter(file => file.isFile() && path.extname(file.name).toLowerCase() === '.png')
        .map(file => path.basename(file.name, '.png')));
}

async function collectJsonlFiles(directory) {
    const entries = await readDirSafe(directory, { withFileTypes: true });
    return entries
        .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.jsonl')
        .map(entry => path.join(directory, entry.name));
}

async function collectSources(dataDir, limit) {
    const resolvedDataDir = path.resolve(dataDir);
    const chatsDir = path.join(resolvedDataDir, 'chats');
    const groupChatsDir = path.join(resolvedDataDir, 'group chats');
    const characterNames = await collectCharacterNames(resolvedDataDir);
    const sources = [];

    if (await pathExists(chatsDir)) {
        const entries = await readDirSafe(chatsDir, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(chatsDir, entry.name);
            if (entry.isDirectory()) {
                const chatFiles = await collectJsonlFiles(entryPath);
                for (const filePath of chatFiles) {
                    sources.push({
                        absolutePath: filePath,
                        scope: characterNames.has(entry.name) ? 'character' : 'orphan-character',
                        characterName: entry.name,
                        fileName: path.basename(filePath),
                        chatName: path.basename(filePath, '.jsonl'),
                        sourcePath: toPosixPath(path.relative(resolvedDataDir, filePath)),
                    });
                }
            } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.jsonl') {
                sources.push({
                    absolutePath: entryPath,
                    scope: 'root',
                    characterName: '',
                    fileName: entry.name,
                    chatName: path.basename(entry.name, '.jsonl'),
                    sourcePath: toPosixPath(path.relative(resolvedDataDir, entryPath)),
                });
            }
        }
    }

    const groupFiles = await collectJsonlFiles(groupChatsDir);
    for (const filePath of groupFiles) {
        sources.push({
            absolutePath: filePath,
            scope: 'group',
            characterName: 'Group chat',
            fileName: path.basename(filePath),
            chatName: path.basename(filePath, '.jsonl'),
            sourcePath: toPosixPath(path.relative(resolvedDataDir, filePath)),
        });
    }

    sources.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
    return Number.isFinite(limit) && limit > 0 ? sources.slice(0, limit) : sources;
}

async function* readJsonlItems(filePath) {
    const input = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 256 * 1024 });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;

    for await (const line of lines) {
        lineNumber += 1;
        if (!line.trim()) continue;
        try {
            yield { type: 'record', lineNumber, record: JSON.parse(line) };
        } catch (error) {
            yield {
                type: 'bad-line',
                lineNumber,
                message: error instanceof Error ? error.message : String(error),
                preview: line.slice(0, 160),
            };
        }
    }
}

async function* iterateChatEvents(chat) {
    let visibleIndex = 0;

    for await (const item of readJsonlItems(chat.absolutePath)) {
        if (item.type === 'bad-line') {
            yield item;
            continue;
        }

        const record = item.record;
        if (item.lineNumber === 1 && record?.chat_metadata && !record?.mes) {
            yield { type: 'metadata' };
            continue;
        }

        if (record?.is_system === true) {
            yield { type: 'skipped-system' };
            continue;
        }

        const text = normalizeText(getMessageText(record));
        const hasMessageShape = text || typeof record?.name === 'string' || typeof record?.is_user === 'boolean';
        if (!hasMessageShape) {
            yield { type: 'skipped-non-message' };
            continue;
        }

        visibleIndex += 1;
        const anchor = `${chat.id}:R${padNumber(item.lineNumber, 5)}:V${padNumber(visibleIndex, 5)}`;
        yield {
            type: 'message',
            message: {
                anchor,
                htmlId: anchor.replace(/:/g, '-'),
                chatId: chat.id,
                lineNumber: item.lineNumber,
                visibleIndex,
                role: getMessageRole(record),
                name: String(record?.name || ''),
                sendDate: String(record?.send_date || ''),
                text,
                chatTitle: chat.title,
                chatMdPath: chat.mdPath,
                sourcePath: chat.sourcePath,
            },
        };
    }
}

async function scanChat(chat) {
    let messageCount = 0;
    let userCount = 0;
    let badLineCount = 0;
    let skippedSystem = 0;
    let skippedNonMessage = 0;
    const badLineSamples = [];
    const stat = await fs.stat(chat.absolutePath).catch(() => ({ size: 0 }));

    for await (const event of iterateChatEvents(chat)) {
        if (event.type === 'message') {
            messageCount += 1;
            if (event.message.role === 'user') userCount += 1;
        } else if (event.type === 'bad-line') {
            badLineCount += 1;
            if (badLineSamples.length < MAX_BAD_LINE_SAMPLES) {
                badLineSamples.push({
                    lineNumber: event.lineNumber,
                    message: event.message,
                    preview: event.preview,
                });
            }
        } else if (event.type === 'skipped-system') {
            skippedSystem += 1;
        } else if (event.type === 'skipped-non-message') {
            skippedNonMessage += 1;
        }
    }

    return {
        ...chat,
        messageCount,
        userCount,
        badLineCount,
        skippedSystem,
        skippedNonMessage,
        rawBytes: stat.size,
        badLineSamples,
    };
}

async function buildModel(dataDir, limit, contextWindow) {
    const sources = await collectSources(dataDir, limit);
    const chats = [];
    const generatedAt = new Date().toISOString();

    process.stderr.write(`scan chats=${sources.length}\n`);
    for (let index = 0; index < sources.length; index += 1) {
        const chat = makeChatDescriptor(sources[index], index);
        chats.push(await scanChat(chat));
        if ((index + 1) % 25 === 0 || index + 1 === sources.length) {
            process.stderr.write(`scan ${index + 1}/${sources.length}\n`);
        }
    }

    const stats = {
        chatCount: chats.length,
        messageCount: chats.reduce((sum, chat) => sum + chat.messageCount, 0),
        userInputCount: chats.reduce((sum, chat) => sum + chat.userCount, 0),
        badLineCount: chats.reduce((sum, chat) => sum + chat.badLineCount, 0),
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
        sourceMode: 'local-node-script-streaming',
        chats,
        stats,
    };
}

async function* iterateUserInputs(chat, contextWindow) {
    const windowSize = Math.max(0, Number.isFinite(contextWindow) ? contextWindow : DEFAULT_CONTEXT_WINDOW);
    const beforeBuffer = [];
    const pending = [];

    for await (const event of iterateChatEvents(chat)) {
        if (event.type !== 'message') continue;
        const message = event.message;

        if (windowSize === 0) {
            if (message.role === 'user') {
                yield { ...message, contextBefore: [], contextAfter: [] };
            }
            continue;
        }

        for (const input of pending) {
            if (input.contextAfter.length < windowSize) {
                input.contextAfter.push(message);
            }
        }
        while (pending.length > 0 && pending[0].contextAfter.length >= windowSize) {
            yield pending.shift();
        }

        if (message.role === 'user') {
            pending.push({
                ...message,
                contextBefore: [...beforeBuffer],
                contextAfter: [],
            });
        }

        beforeBuffer.push(message);
        while (beforeBuffer.length > windowSize) {
            beforeBuffer.shift();
        }
    }

    while (pending.length > 0) {
        yield pending.shift();
    }
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

function renderUserInputBlock(input, includeContext) {
    const lines = [
        `## ${input.anchor} | ${input.chatTitle}`,
        '',
        includeContext
            ? `- Source chat: [${input.chatMdPath}](./${input.chatMdPath}#${input.htmlId})`
            : `- Source chat: \`${input.chatMdPath}\``,
        `- Source JSONL: \`${input.sourcePath}\``,
        `- Visible index: ${input.visibleIndex}`,
        `- JSONL line: ${input.lineNumber}`,
        `- Name: ${input.name || '(no name)'}`,
        input.sendDate ? `- Date: ${input.sendDate}` : '',
        '',
    ].filter(line => line !== '');

    if (includeContext) {
        lines.push(
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
        );
    } else {
        lines.push(markdownQuote(input.text));
    }

    return lines.join('\n');
}

async function* textEntry(text) {
    yield normalizeNewlines(text);
    if (!String(text).endsWith('\n')) yield '\n';
}

async function* allUserInputsMarkdown(model, includeContext, title = 'All User Inputs') {
    yield [
        `# ${title}`,
        '',
        `- Generated at: ${model.generatedAt}`,
        includeContext ? `- Context window: ${model.contextWindow}` : '',
        `- User inputs: ${model.stats.userInputCount}`,
        '',
    ].filter(line => line !== '').join('\n');

    if (model.stats.userInputCount === 0) {
        yield '_No user inputs found._\n';
        return;
    }

    for (const chat of model.chats) {
        for await (const input of iterateUserInputs(chat, includeContext ? model.contextWindow : 0)) {
            yield `\n${renderUserInputBlock(input, includeContext)}\n`;
        }
    }
}

async function* userInputsByChatMarkdown(model, chat) {
    yield [
        `# User Inputs - ${chat.id} ${chat.title}`,
        '',
        `- Generated at: ${model.generatedAt}`,
        `- Context window: ${model.contextWindow}`,
        `- User inputs: ${chat.userCount}`,
        '',
    ].join('\n');

    for await (const input of iterateUserInputs(chat, model.contextWindow)) {
        yield `\n${renderUserInputBlock(input, true)}\n`;
    }
}

async function* userInputCsv(model) {
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
    yield `${CSV_BOM}${header.join(',')}\n`;

    for (const chat of model.chats) {
        for await (const input of iterateUserInputs(chat, 0)) {
            yield [
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
            ].map(csvEscape).join(',');
            yield '\n';
        }
    }
}

async function* chatMarkdown(chat) {
    yield [
        `# ${chat.id} ${chat.title}`,
        '',
        `- Source: \`${chat.sourcePath}\``,
        `- Scope: \`${chat.scope}\``,
        `- Visible messages: ${chat.messageCount}`,
        `- User inputs: ${chat.userCount}`,
        `- Skipped system messages: ${chat.skippedSystem}`,
        `- Bad JSONL lines: ${chat.badLineCount}`,
        '',
        '## Messages',
        '',
    ].join('\n');

    let first = true;
    for await (const event of iterateChatEvents(chat)) {
        if (event.type !== 'message') continue;
        yield `${first ? '' : '\n\n'}${renderMessage(event.message)}`;
        first = false;
    }

    if (first) yield '_No visible messages._';
    yield '\n';
}

function renderIndexMarkdown(model) {
    const rows = model.chats.map(chat => (
        `| ${chat.id} | ${chat.scope} | [${chat.title}](${chat.mdPath}) | ${chat.messageCount} | ${chat.userCount} | \`${chat.sourcePath}\` |`
    )).join('\n');

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

function renderStatsMarkdown(model) {
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

function renderReportMarkdown(model) {
    const badLineDetails = model.chats
        .filter(chat => chat.badLineSamples.length > 0)
        .map(chat => [
            `## ${chat.id} ${chat.title}`,
            '',
            ...chat.badLineSamples.map(line => `- Line ${line.lineNumber}: ${line.message}; preview=\`${line.preview.replace(/`/g, "'")}\``),
            chat.badLineCount > chat.badLineSamples.length ? `- ... ${chat.badLineCount - chat.badLineSamples.length} more bad lines omitted.` : '',
        ].filter(Boolean).join('\n'))
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
        'This local streaming export reads chat files from the selected data directory and can include orphan chat directories.',
        '',
        '## Bad Lines',
        '',
        badLineDetails || '_No bad JSONL lines found._',
    ].join('\n');
}

function renderManifestJson(model) {
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
            visibleMessages: chat.messageCount,
            userInputs: chat.userCount,
            badLines: chat.badLineCount,
        })),
    }, null, 2);
}

function getBundleDefinition(model, mode) {
    const byChatEntries = model.chats
        .filter(chat => chat.userCount > 0)
        .map(chat => ({
            path: `user-inputs/by-chat/${sanitizeSegment(`${chat.id}-${chat.title}`)}.md`,
            chunks: () => userInputsByChatMarkdown(model, chat),
        }));

    const userInputsEntries = [
        {
            path: 'user-inputs/ALL_USER_INPUTS.md',
            chunks: () => allUserInputsMarkdown(model, true),
        },
        {
            path: 'user-inputs/USER_INPUT_INDEX.csv',
            chunks: () => userInputCsv(model),
        },
        {
            path: 'user-inputs/EXPORT_REPORT.md',
            chunks: () => textEntry(renderReportMarkdown(model)),
        },
        ...byChatEntries,
    ];
    const userOnlyEntries = [
        {
            path: 'user-only/USER_INPUTS_ONLY.md',
            chunks: () => allUserInputsMarkdown(model, false, 'User Inputs Only'),
        },
        {
            path: 'user-only/USER_INPUT_INDEX.csv',
            chunks: () => userInputCsv(model),
        },
        {
            path: 'user-only/EXPORT_REPORT.md',
            chunks: () => textEntry(renderReportMarkdown(model)),
        },
    ];
    const indexEntries = [
        {
            path: 'index-stats/MANIFEST.json',
            chunks: () => textEntry(renderManifestJson(model)),
        },
        {
            path: 'index-stats/INDEX.md',
            chunks: () => textEntry(renderIndexMarkdown(model)),
        },
        {
            path: 'index-stats/STATS.md',
            chunks: () => textEntry(renderStatsMarkdown(model)),
        },
        {
            path: 'index-stats/USER_INPUT_INDEX.csv',
            chunks: () => userInputCsv(model),
        },
        {
            path: 'index-stats/EXPORT_REPORT.md',
            chunks: () => textEntry(renderReportMarkdown(model)),
        },
    ];
    const fullEntries = [
        {
            path: 'full-md/INDEX.md',
            chunks: () => textEntry(renderIndexMarkdown(model)),
        },
        {
            path: 'full-md/EXPORT_REPORT.md',
            chunks: () => textEntry(renderReportMarkdown(model)),
        },
        {
            path: 'full-md/USER_INPUTS_ALL.md',
            chunks: () => allUserInputsMarkdown(model, true),
        },
        ...model.chats.map(chat => ({
            path: `full-md/${chat.mdPath}`,
            chunks: () => chatMarkdown(chat),
        })),
    ];

    switch (mode) {
        case 'user-context':
            return {
                fileName: 'sillytavern-user-context-export.zip',
                entries: [...userInputsEntries, ...indexEntries],
            };
        case 'user-only':
            return {
                fileName: 'sillytavern-user-inputs-only.zip',
                entries: userOnlyEntries,
            };
        case 'index-stats':
            return {
                fileName: 'sillytavern-chat-index-stats.zip',
                entries: indexEntries,
            };
        case 'full':
        default:
            return {
                fileName: 'sillytavern-chat-export.zip',
                entries: [...fullEntries, ...userInputsEntries, ...indexEntries],
            };
    }
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

function crc32Update(crc, data) {
    const table = getCrcTable();
    let value = crc;
    for (const byte of data) {
        value = table[(value ^ byte) & 0xFF] ^ (value >>> 8);
    }
    return value >>> 0;
}

function crc32Final(crc) {
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function getZipDateParts(date = new Date()) {
    const year = Math.max(date.getFullYear(), 1980);
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { dosTime, dosDate };
}

function assertZip32(value, label) {
    if (value > 0xFFFFFFFF) {
        throw new Error(`${label} is larger than ZIP32 supports. Split the export into a smaller mode.`);
    }
}

function createLocalHeader(nameBytes, dosTime, dosDate) {
    const buffer = Buffer.alloc(30 + nameBytes.length);
    buffer.writeUInt32LE(0x04034B50, 0);
    buffer.writeUInt16LE(20, 4);
    buffer.writeUInt16LE(ZIP_FLAG_UTF8_DATA_DESCRIPTOR, 6);
    buffer.writeUInt16LE(ZIP_METHOD_DEFLATE, 8);
    buffer.writeUInt16LE(dosTime, 10);
    buffer.writeUInt16LE(dosDate, 12);
    buffer.writeUInt32LE(0, 14);
    buffer.writeUInt32LE(0, 18);
    buffer.writeUInt32LE(0, 22);
    buffer.writeUInt16LE(nameBytes.length, 26);
    buffer.writeUInt16LE(0, 28);
    Buffer.from(nameBytes).copy(buffer, 30);
    return buffer;
}

function createDataDescriptor(crc, compressedSize, uncompressedSize) {
    assertZip32(compressedSize, 'ZIP entry compressed size');
    assertZip32(uncompressedSize, 'ZIP entry uncompressed size');
    const buffer = Buffer.alloc(16);
    buffer.writeUInt32LE(0x08074B50, 0);
    buffer.writeUInt32LE(crc >>> 0, 4);
    buffer.writeUInt32LE(compressedSize >>> 0, 8);
    buffer.writeUInt32LE(uncompressedSize >>> 0, 12);
    return buffer;
}

function createCentralHeader(entry) {
    const buffer = Buffer.alloc(46 + entry.nameBytes.length);
    buffer.writeUInt32LE(0x02014B50, 0);
    buffer.writeUInt16LE(20, 4);
    buffer.writeUInt16LE(20, 6);
    buffer.writeUInt16LE(ZIP_FLAG_UTF8_DATA_DESCRIPTOR, 8);
    buffer.writeUInt16LE(ZIP_METHOD_DEFLATE, 10);
    buffer.writeUInt16LE(entry.dosTime, 12);
    buffer.writeUInt16LE(entry.dosDate, 14);
    buffer.writeUInt32LE(entry.crc >>> 0, 16);
    buffer.writeUInt32LE(entry.compressedSize >>> 0, 20);
    buffer.writeUInt32LE(entry.uncompressedSize >>> 0, 24);
    buffer.writeUInt16LE(entry.nameBytes.length, 28);
    buffer.writeUInt16LE(0, 30);
    buffer.writeUInt16LE(0, 32);
    buffer.writeUInt16LE(0, 34);
    buffer.writeUInt16LE(0, 36);
    buffer.writeUInt32LE(0, 38);
    buffer.writeUInt32LE(entry.offset >>> 0, 42);
    Buffer.from(entry.nameBytes).copy(buffer, 46);
    return buffer;
}

function createEndRecord(entryCount, centralDirectorySize, centralDirectoryOffset) {
    assertZip32(centralDirectorySize, 'ZIP central directory size');
    assertZip32(centralDirectoryOffset, 'ZIP central directory offset');
    if (entryCount > 0xFFFF) {
        throw new Error('Too many ZIP entries for ZIP32. Use a smaller export mode.');
    }
    const buffer = Buffer.alloc(22);
    buffer.writeUInt32LE(0x06054B50, 0);
    buffer.writeUInt16LE(0, 4);
    buffer.writeUInt16LE(0, 6);
    buffer.writeUInt16LE(entryCount, 8);
    buffer.writeUInt16LE(entryCount, 10);
    buffer.writeUInt32LE(centralDirectorySize >>> 0, 12);
    buffer.writeUInt32LE(centralDirectoryOffset >>> 0, 16);
    buffer.writeUInt16LE(0, 20);
    return buffer;
}

async function* encodeChunks(chunks) {
    for await (const chunk of chunks) {
        if (chunk === undefined || chunk === null) continue;
        if (typeof chunk === 'string') {
            yield TEXT_ENCODER.encode(chunk);
        } else {
            yield chunk;
        }
    }
}

class ZipStreamWriter {
    constructor(filePath) {
        this.filePath = filePath;
        this.output = createWriteStream(filePath);
        this.offset = 0;
        this.centralDirectory = [];
    }

    async write(buffer) {
        this.offset += buffer.length;
        if (!this.output.write(buffer)) {
            await once(this.output, 'drain');
        }
    }

    async addEntry(entryPath, chunks) {
        const nameBytes = TEXT_ENCODER.encode(toPosixPath(entryPath));
        const { dosTime, dosDate } = getZipDateParts();
        const localOffset = this.offset;
        assertZip32(localOffset, 'ZIP local header offset');
        await this.write(createLocalHeader(nameBytes, dosTime, dosDate));

        let crc = 0xFFFFFFFF;
        let uncompressedSize = 0;
        let compressedSize = 0;
        const output = this.output;
        const writer = this;
        const checksum = new Transform({
            transform(chunk, _encoding, callback) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                crc = crc32Update(crc, bytes);
                uncompressedSize += bytes.length;
                callback(null, bytes);
            },
        });
        const payloadWriter = new Writable({
            write(chunk, _encoding, callback) {
                compressedSize += chunk.length;
                writer.offset += chunk.length;
                if (output.write(chunk)) {
                    callback();
                } else {
                    output.once('drain', callback);
                }
            },
        });

        await pipeline(
            Readable.from(encodeChunks(chunks)),
            checksum,
            createDeflateRaw({ level: 6 }),
            payloadWriter,
        );

        const finalCrc = crc32Final(crc);
        await this.write(createDataDescriptor(finalCrc, compressedSize, uncompressedSize));
        this.centralDirectory.push({
            nameBytes,
            dosTime,
            dosDate,
            crc: finalCrc,
            compressedSize,
            uncompressedSize,
            offset: localOffset,
        });
    }

    async close() {
        const centralDirectoryOffset = this.offset;
        for (const entry of this.centralDirectory) {
            await this.write(createCentralHeader(entry));
        }
        const centralDirectorySize = this.offset - centralDirectoryOffset;
        await this.write(createEndRecord(this.centralDirectory.length, centralDirectorySize, centralDirectoryOffset));
        this.output.end();
        await once(this.output, 'finish');
    }
}

async function writeStreamingZip(outDir, fileName, entries) {
    await fs.mkdir(outDir, { recursive: true });
    const finalPath = path.join(outDir, fileName);
    const tempPath = `${finalPath}.partial`;
    await fs.rm(tempPath, { force: true });

    const zip = new ZipStreamWriter(tempPath);
    try {
        for (let index = 0; index < entries.length; index += 1) {
            const entry = entries[index];
            process.stderr.write(`zip ${index + 1}/${entries.length} ${entry.path}\n`);
            await zip.addEntry(entry.path, entry.chunks());
        }
        await zip.close();
        await fs.rename(tempPath, finalPath);
    } catch (error) {
        zip.output.destroy();
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw error;
    }

    return finalPath;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const contextWindow = Math.max(0, Number.isFinite(options.contextWindow) ? options.contextWindow : DEFAULT_CONTEXT_WINDOW);
    const model = await buildModel(options.dataDir, options.limit, contextWindow);
    const definition = getBundleDefinition(model, options.mode);
    const outDir = path.resolve(options.outDir);
    const written = await writeStreamingZip(outDir, definition.fileName, definition.entries);

    process.stdout.write([
        'SillyTavern chat export complete',
        `dataDir=${path.resolve(options.dataDir)}`,
        `outDir=${outDir}`,
        `mode=${options.mode}`,
        `chats=${model.stats.chatCount}`,
        `messages=${model.stats.messageCount}`,
        `userInputs=${model.stats.userInputCount}`,
        `orphanChats=${model.stats.orphanChatCount}`,
        `groupChats=${model.stats.groupChatCount}`,
        `badLines=${model.stats.badLineCount}`,
        `files=${path.basename(written)}`,
        `written=${written}`,
        '',
    ].join('\n'));
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
});
