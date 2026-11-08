const assert = require('node:assert/strict');
const { mkdtempSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { parseCliArgs } = require('../dist/cli');

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
    });
}
