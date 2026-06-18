#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateRaw } from 'node:zlib';
import { promisify } from 'node:util';

import { buildExportModel, createCompressedChatExportBundleByMode, createChatExportPackages } from '../dist/export-core.js';

const DEFAULT_DATA_DIR = 'data/default-user';
const DEFAULT_OUT_DIR = 'tmp/chat-exporter-test';
const deflateRawAsync = promisify(deflateRaw);

function parseArgs(argv) {
    const options = {
        dataDir: DEFAULT_DATA_DIR,
        outDir: DEFAULT_OUT_DIR,
        contextWindow: 1,
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

function toPosixPath(value) {
    return String(value).replace(/\\/g, '/');
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
                        scope: characterNames.has(entry.name) ? 'character' : 'orphan-character',
                        characterName: entry.name,
                        fileName: path.basename(filePath),
                        chatName: path.basename(filePath, '.jsonl'),
                        sourcePath: toPosixPath(path.relative(resolvedDataDir, filePath)),
                        raw: await fs.readFile(filePath, 'utf8'),
                    });
                }
            } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.jsonl') {
                sources.push({
                    scope: 'root',
                    characterName: '',
                    fileName: entry.name,
                    chatName: path.basename(entry.name, '.jsonl'),
                    sourcePath: toPosixPath(path.relative(resolvedDataDir, entryPath)),
                    raw: await fs.readFile(entryPath, 'utf8'),
                });
            }
        }
    }

    const groupFiles = await collectJsonlFiles(groupChatsDir);
    for (const filePath of groupFiles) {
        sources.push({
            scope: 'group',
            characterName: 'Group chat',
            fileName: path.basename(filePath),
            chatName: path.basename(filePath, '.jsonl'),
            sourcePath: toPosixPath(path.relative(resolvedDataDir, filePath)),
            raw: await fs.readFile(filePath, 'utf8'),
        });
    }

    sources.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
    return Number.isFinite(limit) && limit > 0 ? sources.slice(0, limit) : sources;
}

async function writePackages(outDir, packages, selectedPackages) {
    await fs.mkdir(outDir, { recursive: true });
    const written = [];
    for (const pack of packages) {
        if (!selectedPackages.has(pack.key)) continue;
        const filePath = path.join(outDir, pack.fileName);
        await fs.writeFile(filePath, pack.bytes);
        written.push(filePath);
    }
    return written;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const sources = await collectSources(options.dataDir, options.limit);
    const model = buildExportModel(sources, {
        contextWindow: options.contextWindow,
        sourceMode: 'local-node-script',
    });
    const packages = options.splitPackages
        ? createChatExportPackages(model)
        : [await createCompressedChatExportBundleByMode(model, options.mode, async dataBytes => new Uint8Array(await deflateRawAsync(dataBytes)))];
    const selectedPackages = options.splitPackages ? options.packages : new Set(packages.map(pack => pack.key));
    const written = await writePackages(path.resolve(options.outDir), packages, selectedPackages);

    process.stdout.write([
        `SillyTavern chat export complete`,
        `dataDir=${path.resolve(options.dataDir)}`,
        `outDir=${path.resolve(options.outDir)}`,
        `chats=${model.stats.chatCount}`,
        `messages=${model.stats.messageCount}`,
        `userInputs=${model.stats.userInputCount}`,
        `orphanChats=${model.stats.orphanChatCount}`,
        `groupChats=${model.stats.groupChatCount}`,
        `badLines=${model.stats.badLineCount}`,
        `files=${written.map(file => path.basename(file)).join(', ')}`,
        `written=${written.join(', ')}`,
        '',
    ].join('\n'));
}

main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
});
