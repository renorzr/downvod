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

// All network requests in these tests target the local fixture server.
axios.defaults.proxy = false;

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
    const downloader = new Downloader(name, 'mp4', [/\/ads\//, /adv\.com\//]);
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
    const downloader = new Downloader(name, 'mp4', [/\/ads\//]);
    const cached = await downloader.pullSegUrls('https://no-network.invalid/index.m3u8');
    const files = await downloader.downloadUrls(cached.urls);
    assert.deepEqual(files, [`${name}.seg0001.ts`, `${name}.seg0003.ts`]);
    assert.equal(readFileSync(files[1], 'utf8'), 'last segment');
    assert.deepEqual(requests, ['/first.ts']);
    assert.deepEqual(JSON.parse(readFileSync(`${name}_urls.json`, 'utf8')), urls);

    const unfiltered = new Downloader(name, 'mp4');
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
    await new Downloader(name, 'mp4', [/adv\.com\//]).start('https://no-network.invalid/index.m3u8');
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
    const downloader = new Downloader(name, 'mp4', [/adv\.com\//]);
    t.mock.method(downloader, 'downloadUrls', () => assert.fail('must not download'));
    t.mock.method(childProcess, 'spawn', () => assert.fail('must not invoke FFmpeg'));
    await assert.rejects(downloader.start('https://no-network.invalid/index.m3u8'), /No segments remain/);
    assert.equal(existsSync(`${name}.mp4`), false);
    assert.equal(existsSync(`${name}_urls.json`), true);
});
