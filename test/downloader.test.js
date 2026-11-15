const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createServer } = require('node:http');
const { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const axios = require('axios');
const childProcess = require('node:child_process');
const { Downloader } = require('../dist/downloader');
const { TaskOutput } = require('../dist/output');

// All network requests in these tests target the local fixture server.
axios.defaults.proxy = false;

// Keep unit-test logs in memory: Node's test transport can misread non-ASCII
// stdout as serialized frames (https://github.com/nodejs/node/issues/64061).
// CLI and output tests cover real output separately.
function createDownloader(name, ext, patterns = [], keepChunks = false,
    output = new TaskOutput({ write() {} })) {
    return new Downloader(name, ext, patterns, keepChunks, output);
}

function temporaryName(t) {
    const dir = mkdtempSync(join(tmpdir(), 'downvod-exclude-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return join(dir, 'movie');
}

async function fixtureServer(t) {
    const requests = [];
    const server = createServer((req, res) => {
        requests.push(req.url);
        if (req.url === '/master.m3u8') {
            res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia/index.m3u8\n');
        } else if (req.url === '/media/index.m3u8') {
            res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfirst.ts\n#EXTINF:1,\nads/ad.ts\n#EXTINF:1,\nlast.ts\n#EXTINF:1,\nhttps://adv.com/extra.ts\n#EXTINF:1,\navod/legacy.ts\n#EXT-X-ENDLIST\n');
        } else {
            // Ensure the existing duration-based download result is non-zero.
            setTimeout(() => res.end(req.url), 10);
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

test('filters resolved URLs from a master playlist while preserving order and cache indexes', async t => {
    const name = temporaryName(t);
    const { baseUrl, requests } = await fixtureServer(t);
    const downloader = createDownloader(name, 'mp4', [/\/ads\//, /adv\.com\//]);
    const { urls, urlsFileName } = await downloader.pullSegUrls(`${baseUrl}/master.m3u8`);
    assert.deepEqual(urls, [
        `${baseUrl}/media/first.ts`, `${baseUrl}/media/ads/ad.ts`,
        `${baseUrl}/media/last.ts`, 'https://adv.com/extra.ts'
    ]);
    assert.deepEqual(JSON.parse(readFileSync(urlsFileName, 'utf8')), urls);
    const files = await downloader.downloadUrls(urls);
    assert.deepEqual(files, [`${name}.seg0001.ts`, `${name}.seg0003.ts`]);
    assert.equal(readFileSync(files[0], 'utf8'), '/media/first.ts');
    assert.equal(readFileSync(files[1], 'utf8'), '/media/last.ts');
    assert.deepEqual(requests, ['/master.m3u8', '/media/index.m3u8', '/media/first.ts', '/media/last.ts']);
});

test('applies new rules to legacy URL caches without reusing excluded files under new indexes', async t => {
    const name = temporaryName(t);
    const { baseUrl, requests } = await fixtureServer(t);
    const urls = [`${baseUrl}/first.ts`, `${baseUrl}/ads/ad.ts`, `${baseUrl}/last.ts`];
    writeFileSync(`${name}_urls.json`, JSON.stringify(urls));
    writeFileSync(`${name}.seg0002.ts`, 'old advertisement');
    writeFileSync(`${name}.seg0003.ts`, 'last segment');
    const downloader = createDownloader(name, 'mp4', [/\/ads\//]);
    const cached = await downloader.pullSegUrls('https://no-network.invalid/index.m3u8');
    const files = await downloader.downloadUrls(cached.urls);
    assert.deepEqual(files, [`${name}.seg0001.ts`, `${name}.seg0003.ts`]);
    assert.equal(readFileSync(files[1], 'utf8'), 'last segment');
    assert.deepEqual(requests, ['/first.ts']);
    assert.deepEqual(JSON.parse(readFileSync(`${name}_urls.json`, 'utf8')), urls);

    const unfiltered = createDownloader(name, 'mp4');
    assert.deepEqual(await unfiltered.downloadUrls(cached.urls), [
        `${name}.seg0001.ts`, `${name}.seg0002.ts`, `${name}.seg0003.ts`
    ]);
    assert.deepEqual(requests, ['/first.ts']);
});

test('merges retained segments successfully and leaves excluded cached files out of FFmpeg', async t => {
    const name = temporaryName(t);
    writeFileSync(`${name}_urls.json`, JSON.stringify(['https://video.test/first.ts', 'https://adv.com/ad.ts', 'https://video.test/last.ts']));
    for (let i = 1; i <= 3; i++) writeFileSync(`${name}.seg000${i}.ts`, String(i));
    let concatCalls = 0;
    t.mock.method(childProcess, 'spawn', (command, args) => {
        concatCalls++;
        assert.equal(command, 'ffmpeg');
        assert.equal(args[1], `concat:${name}.seg0001.ts|${name}.seg0003.ts`);
        writeFileSync(args.at(-1), Buffer.alloc(1024 * 1024));
        const proc = new EventEmitter();
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        queueMicrotask(() => proc.emit('close', 0));
        return proc;
    });
    await createDownloader(name, 'mp4', [/adv\.com\//]).start('https://no-network.invalid/index.m3u8');
    assert.equal(concatCalls, 1);
    assert.equal(existsSync(`${name}.mp4`), true);
    assert.equal(existsSync(`${name}_urls.json`), false);
    assert.equal(existsSync(`${name}.seg0001.ts`), false);
    assert.equal(existsSync(`${name}.seg0003.ts`), false);
    assert.equal(readFileSync(`${name}.seg0002.ts`, 'utf8'), '2');
});

test('fails before downloading or merging when every segment is excluded', async t => {
    const name = temporaryName(t);
    writeFileSync(`${name}_urls.json`, JSON.stringify(['https://adv.com/ad.ts']));
    const downloader = createDownloader(name, 'mp4', [/adv\.com\//]);
    t.mock.method(downloader, 'downloadUrls', () => assert.fail('must not download'));
    t.mock.method(childProcess, 'spawn', () => assert.fail('must not invoke FFmpeg'));
    await assert.rejects(downloader.start('https://no-network.invalid/index.m3u8'), /No segments remain/);
    assert.equal(existsSync(`${name}.mp4`), false);
    assert.equal(existsSync(`${name}_urls.json`), true);
});

test('keep-chunks preserves original segments and URL cache for a later merge with different exclusions', async t => {
    const name = temporaryName(t);
    const urls = ['https://video.test/first.ts', 'https://adv.com/ad.ts', 'https://video.test/last.ts'];
    writeFileSync(`${name}_urls.json`, JSON.stringify(urls));
    for (let i = 1; i <= 3; i++) writeFileSync(`${name}.seg000${i}.ts`, String(i));
    const concatInputs = [];
    t.mock.method(childProcess, 'spawn', (command, args) => {
        assert.equal(command, 'ffmpeg');
        concatInputs.push(args[1]);
        writeFileSync(args.at(-1), Buffer.alloc(1024 * 1024));
        const proc = new EventEmitter();
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        queueMicrotask(() => proc.emit('close', 0));
        return proc;
    });

    await createDownloader(name, 'mp4', [/adv\.com\//], true).start('https://no-network.invalid/index.m3u8');
    assert.deepEqual(JSON.parse(readFileSync(`${name}_urls.json`, 'utf8')), urls);
    for (let i = 1; i <= 3; i++) assert.equal(readFileSync(`${name}.seg000${i}.ts`, 'utf8'), String(i));
    assert.equal(existsSync(`${name}.mp4`), true);

    rmSync(`${name}.mp4`);
    // A second merge can include all original chunks and use the default cleanup.
    await createDownloader(name, 'mp4').start('https://no-network.invalid/index.m3u8');
    assert.deepEqual(concatInputs, [
        `concat:${name}.seg0001.ts|${name}.seg0003.ts`,
        `concat:${name}.seg0001.ts|${name}.seg0002.ts|${name}.seg0003.ts`
    ]);
    assert.equal(existsSync(`${name}_urls.json`), false);
    for (let i = 1; i <= 3; i++) assert.equal(existsSync(`${name}.seg000${i}.ts`), false);
});

for (const keepChunks of [false, true]) {
    test(`failed merge preserves chunks and URL cache (keep-chunks=${keepChunks})`, async t => {
        const name = temporaryName(t);
        const urls = ['https://video.test/first.ts'];
        writeFileSync(`${name}_urls.json`, JSON.stringify(urls));
        writeFileSync(`${name}.seg0001.ts`, 'original segment');
        t.mock.method(childProcess, 'spawn', (command, args) => {
            writeFileSync(args.at(-1), Buffer.alloc(1024 * 1024));
            const proc = new EventEmitter();
            proc.stdout = new PassThrough();
            proc.stderr = new PassThrough();
            queueMicrotask(() => proc.emit('close', 1));
            return proc;
        });
        await assert.rejects(createDownloader(name, 'mp4', [], keepChunks).start('https://no-network.invalid/index.m3u8'), error => error === 1);
        assert.equal(readFileSync(`${name}.seg0001.ts`, 'utf8'), 'original segment');
        assert.deepEqual(JSON.parse(readFileSync(`${name}_urls.json`, 'utf8')), urls);
    });
}

test('interrupted segment streams retry, preserve the cache and never reach FFmpeg', async t => {
    const name = temporaryName(t);
    let requests = 0;
    const server = createServer((req, res) => {
        requests++;
        res.writeHead(200, { 'Content-Length': 10000 });
        res.write('partial segment');
        setTimeout(() => res.destroy(), 20);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    writeFileSync(`${name}_urls.json`, JSON.stringify([`http://127.0.0.1:${server.address().port}/broken.ts`]));
    let text = '';
    const output = new TaskOutput({ write: chunk => text += chunk });
    t.mock.method(childProcess, 'spawn', () => assert.fail('must not merge incomplete segments'));
    await assert.rejects(createDownloader(name, 'mp4', [], false, output).start('unused'), /Download incomplete/);
    assert.equal(requests, 2);
    assert.equal(existsSync(`${name}.seg0001.ts`), false);
    assert.equal(existsSync(`${name}_urls.json`), true);
    assert.match(text, /#1 failed after 2 attempts/);
    assert.match(text, /1 failed, 1 retries/);
    assert.doesNotMatch(text, /\x1b|\r/);
});

test('ten consecutive exhausted segments abort the task before later downloads or merging', async t => {
    const name = temporaryName(t);
    const urls = Array.from({ length: 12 }, (_, i) => `https://video.test/${i + 1}.ts`);
    writeFileSync(`${name}_urls.json`, JSON.stringify(urls));
    writeFileSync(`${name}.seg0001.ts`, 'completed segment');
    let text = '';
    const downloader = createDownloader(name, 'mp4', [], false, new TaskOutput({ write: chunk => text += chunk }));
    const attempts = [];
    t.mock.method(downloader, 'download', async url => {
        attempts.push(url);
        return false;
    });
    t.mock.method(childProcess, 'spawn', () => assert.fail('must not merge after aborting'));

    await assert.rejects(downloader.start('unused'), /Download aborted: 10 consecutive segments failed/);
    assert.deepEqual(attempts, urls.slice(1, 11).flatMap(url => [url, url]));
    assert.equal(readFileSync(`${name}.seg0001.ts`, 'utf8'), 'completed segment');
    assert.deepEqual(JSON.parse(readFileSync(`${name}_urls.json`, 'utf8')), urls);
    assert.equal(existsSync(`${name}.mp4`), false);
    assert.match(text, /10 consecutive segments failed/);
    assert.match(text, /segments and URL cache retained/);
});

for (const recovery of ['download', 'retry', 'cache']) {
    test(`a successful ${recovery} resets the consecutive segment failure count`, async t => {
        const name = temporaryName(t);
        const urls = Array.from({ length: 20 }, (_, i) => `https://video.test/${i + 1}.ts`);
        const downloader = createDownloader(name, 'mp4');
        if (recovery === 'cache') writeFileSync(`${name}.seg0010.ts`, 'cached segment');
        const attempts = [];
        let recoveryAttempts = 0;
        t.mock.method(downloader, 'download', async url => {
            attempts.push(url);
            if (url === urls[9]) {
                recoveryAttempts++;
                return recovery === 'retry' && recoveryAttempts === 1 ? false : 1;
            }
            return url === urls[19] ? 1 : false;
        });

        const files = await downloader.downloadUrls(urls);
        assert.deepEqual(files, [`${name}.seg0010.ts`, `${name}.seg0020.ts`]);
        assert.equal(attempts.length, 37 + (recovery === 'cache' ? 0 : recovery === 'retry' ? 2 : 1));
        assert.equal(attempts.at(-1), urls[19]);
    });
}

test('excluded segments neither count as failures nor reset a failure streak', async t => {
    const name = temporaryName(t);
    const urls = Array.from({ length: 12 }, (_, i) => `https://video.test/${i + 1}.ts`);
    const downloader = createDownloader(name, 'mp4', [/\/6\.ts$/]);
    const attempts = [];
    t.mock.method(downloader, 'download', async url => {
        attempts.push(url);
        return false;
    });

    await assert.rejects(downloader.downloadUrls(urls), /10 consecutive segments failed/);
    assert.deepEqual(attempts, urls.slice(0, 11).filter(url => url !== urls[5]).flatMap(url => [url, url]));
});

test('FFmpeg progress stays transient and failure diagnostics remain in the output', async t => {
    const name = temporaryName(t);
    writeFileSync(`${name}_urls.json`, JSON.stringify(['https://video.test/first.ts']));
    writeFileSync(`${name}.seg0001.ts`, 'segment');
    let text = '';
    const output = new TaskOutput({ write: chunk => text += chunk });
    t.mock.method(childProcess, 'spawn', (command, args) => {
        assert.ok(args.includes('-progress'));
        assert.ok(args.includes('pipe:1'));
        const proc = new EventEmitter();
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        queueMicrotask(() => {
            proc.stdout.end('out_ti');
            proc.stderr.end('Invalid data found when processing input\n');
            setImmediate(() => proc.emit('close', 1));
        });
        return proc;
    });
    await assert.rejects(createDownloader(name, 'mp4', [], false, output).start('unused'), error => error === 1);
    assert.match(text, /FFmpeg exited with code 1\n  Invalid data found when processing input/);
    assert.doesNotMatch(text, /out_ti/);
    assert.equal(existsSync(`${name}.seg0001.ts`), true);
});

test('FFmpeg spawn errors produce a finished failure state and retain temporary files', async t => {
    const name = temporaryName(t);
    writeFileSync(`${name}_urls.json`, JSON.stringify(['https://video.test/first.ts']));
    writeFileSync(`${name}.seg0001.ts`, 'segment');
    let text = '';
    const output = new TaskOutput({ write: chunk => text += chunk });
    t.mock.method(childProcess, 'spawn', () => {
        const proc = new EventEmitter();
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        queueMicrotask(() => proc.emit('error', new Error('spawn ffmpeg ENOENT')));
        return proc;
    });
    await assert.rejects(createDownloader(name, 'mp4', [], false, output).start('unused'), /spawn ffmpeg ENOENT/);
    assert.match(text, /✗ Merge segments · spawn ffmpeg ENOENT/);
    assert.equal(existsSync(`${name}_urls.json`), true);
    assert.equal(existsSync(`${name}.seg0001.ts`), true);
});
