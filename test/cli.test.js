const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { test } = require('node:test');
const { parseCliArgs } = require('../dist/cli');
const { version } = require('../package.json');

test('accepts equals syntax and preserves shell-quoted regexp escapes', () => {
    const args = parseCliArgs(['https://video.test/index.m3u8', 'movie.mp4', String.raw`--exclude-chunk=adv\.com\/`]);
    assert.deepEqual(args.positionals, ['https://video.test/index.m3u8', 'movie.mp4']);
    assert.equal(args.excludeChunkPatterns[0].test('https://adv.com/ad.ts'), true);
    assert.equal(args.excludeChunkPatterns[0].test('https://advXcom/ad.ts'), false);
});

test('accepts repeated options before, between and after positionals', () => {
    const args = parseCliArgs(['--exclude-chunk', '/ads/', '1-3', '--exclude-chunk=type=ad', 'https://video.test/%d/index.m3u8', 'Series-%02d.mp4']);
    assert.deepEqual(args.positionals, ['1-3', 'https://video.test/%d/index.m3u8', 'Series-%02d.mp4']);
    assert.equal(args.excludeChunkPatterns.length, 2);
    assert.equal(args.excludeChunkPatterns[1].test('https://video.test/chunk.ts?type=ad'), true);
    assert.deepEqual(parseCliArgs(['url', 'file.mp4']).excludeChunkPatterns, []);
});

test('rejects malformed, empty and missing patterns and unknown options', () => {
    assert.throws(() => parseCliArgs(['--exclude-chunk=[']), /Invalid --exclude-chunk regular expression/);
    assert.throws(() => parseCliArgs(['--exclude-chunk=']), /non-empty regular expression/);
    assert.throws(() => parseCliArgs(['--exclude-chunk']), /argument/i);
    assert.throws(() => parseCliArgs(['--unknown']), /unknown option/i);
});

test('keep-chunks is opt-in and combines with exclusion patterns in either argument order', () => {
    assert.equal(parseCliArgs(['url', 'movie.mp4']).keepChunks, false);
    for (const args of [
        ['--keep-chunks', 'url', 'movie.mp4', '--exclude-chunk=/ads/'],
        ['--exclude-chunk', '/ads/', 'url', 'movie.mp4', '--keep-chunks']
    ]) {
        const parsed = parseCliArgs(args);
        assert.equal(parsed.keepChunks, true);
        assert.deepEqual(parsed.positionals, ['url', 'movie.mp4']);
        assert.equal(parsed.excludeChunkPatterns[0].test('https://video.test/ads/ad.ts'), true);
    }
});

for (const [entry, positionals] of [
    ['index', ['https://video.invalid/index.m3u8', 'movie.mp4']],
    ['batch', ['1-3', 'https://video.invalid/%d/index.m3u8', 'Series-%02d.mp4']]
]) {
    test(`${entry} rejects invalid patterns before networking or creating output directories`, t => {
        const dir = mkdtempSync(join(tmpdir(), 'downvod-cli-'));
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        const result = spawnSync(process.execPath, [resolve('dist', `${entry}.js`), ...positionals, '--exclude-chunk=['], { cwd: dir, encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /Invalid --exclude-chunk regular expression/);
        assert.deepEqual(readdirSync(dir), []);
    });

    test(`${entry} documents the option in --help`, () => {
        const result = spawnSync(process.execPath, [resolve('dist', `${entry}.js`), '--help'], { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /--exclude-chunk/);
        assert.match(result.stdout, /--keep-chunks/);
        assert.match(result.stdout, /--version/);
    });

    test(`${entry} supports --version and -v without creating files or downloading`, t => {
        const dir = mkdtempSync(join(tmpdir(), 'downvod-version-'));
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        for (const flag of ['--version', '-v']) {
            const result = spawnSync(process.execPath, [resolve('dist', `${entry}.js`), flag], { cwd: dir, encoding: 'utf8', timeout: 10000 });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout.trim(), version);
            assert.equal(result.stderr, '');
            assert.deepEqual(readdirSync(dir), []);
        }
    });

    test(`${entry} prints the installed version at startup`, t => {
        const dir = mkdtempSync(join(tmpdir(), 'downvod-startup-'));
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        // An existing output lets us check the normal CLI path without a network request.
        if (entry === 'index') {
            writeFileSync(join(dir, 'movie.mp4'), 'existing video');
        } else {
            mkdirSync(join(dir, 'Series-%02d'));
            for (let i = 1; i <= 3; i++) {
                writeFileSync(join(dir, 'Series-%02d', `Series-0${i}.mp4`), 'existing video');
            }
        }
        const result = spawnSync(process.execPath, [resolve('dist', `${entry}.js`), ...positionals, '--keep-chunks'], { cwd: dir, encoding: 'utf8', timeout: 10000 });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.split('\n')[0], `${entry === 'index' ? 'downvod' : 'batchdownvod'} ${version}`);
        assert.match(result.stdout, /file exists:/);
    });
}

test('SIGINT commits the interrupted task and retains completed segments and URL cache', { timeout: 10000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'downvod-interrupt-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let requested;
    const receiving = new Promise(resolve => requested = resolve);
    const server = createServer((req, res) => {
        res.writeHead(200, { 'Content-Length': 10000 });
        res.write('partial');
        requested();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    const urls = [`http://127.0.0.1:${server.address().port}/first.ts`, `http://127.0.0.1:${server.address().port}/slow.ts`];
    writeFileSync(join(dir, 'movie_urls.json'), JSON.stringify(urls));
    writeFileSync(join(dir, 'movie.seg0001.ts'), 'complete');
    const proc = spawn(process.execPath, [resolve('dist/index.js'), 'https://unused.invalid/index.m3u8', 'movie.mp4'], { cwd: dir });
    t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => stdout += chunk);
    proc.stderr.on('data', chunk => stderr += chunk);
    const exit = new Promise((resolve, reject) => {
        proc.once('error', reject);
        proc.once('close', (code, signal) => resolve({ code, signal }));
    });
    await receiving;
    proc.kill('SIGINT');
    assert.deepEqual(await exit, { code: 130, signal: null }, stderr);
    assert.match(stdout, /✗ Download segments · Interrupted/);
    assert.doesNotMatch(stdout + stderr, /\x1b|\r/);
    assert.ok(readdirSync(dir).includes('movie.seg0001.ts'));
    assert.ok(readdirSync(dir).includes('movie_urls.json'));
    assert.ok(!readdirSync(dir).includes('movie.mp4'));
});

for (const entry of ['index', 'batch']) {
    test(`${entry} exits after ten failures even when HTTP error bodies never finish`, { timeout: 10000 }, async t => {
        const dir = mkdtempSync(join(tmpdir(), 'downvod-abort-'));
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        const requests = [];
        const server = createServer((req, res) => {
            requests.push(req.url);
            res.writeHead(403);
            res.write('Access denied');
            // Keep the error body open to catch leaked response streams in the CLI.
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(() => {
            server.closeAllConnections();
            return new Promise(resolve => server.close(resolve));
        });
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        const urls = Array.from({ length: 12 }, (_, i) => `${baseUrl}/${i + 1}.ts`);
        const targetDir = entry === 'index' ? dir : join(dir, 'Series-%02d');
        mkdirSync(targetDir, { recursive: true });
        const name = entry === 'index' ? 'movie' : 'Series-01';
        writeFileSync(join(targetDir, `${name}_urls.json`), JSON.stringify(urls));
        writeFileSync(join(targetDir, `${name}.seg0001.ts`), 'complete');
        const args = entry === 'index'
            ? [`${baseUrl}/index.m3u8`, 'movie.mp4']
            : ['1-3', `${baseUrl}/%d/index.m3u8`, 'Series-%02d.mp4'];
        const proc = spawn(process.execPath, [resolve('dist', `${entry}.js`), ...args], {
            cwd: dir, timeout: 5000, killSignal: 'SIGKILL',
            env: { ...process.env, NO_PROXY: '127.0.0.1' }
        });
        t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', chunk => stdout += chunk);
        proc.stderr.on('data', chunk => stderr += chunk);
        const result = await new Promise((resolve, reject) => {
            proc.once('error', reject);
            proc.once('close', (code, signal) => resolve({ code, signal }));
        });
        assert.match(stderr, /Download aborted: 10 consecutive segments failed/);
        assert.deepEqual(result, { code: 1, signal: null }, 'CLI must exit without waiting for error bodies to finish');
        assert.deepEqual(requests, Array.from({ length: 10 }, (_, i) => [`/${i + 2}.ts`, `/${i + 2}.ts`]).flat());
        assert.doesNotMatch(stdout, /Merge segments|\[2\/3\] Start/);
        assert.ok(readdirSync(targetDir).includes(`${name}.seg0001.ts`));
        assert.ok(readdirSync(targetDir).includes(`${name}_urls.json`));
        assert.ok(!readdirSync(targetDir).includes(`${name}.mp4`));
    });
}
