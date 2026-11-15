import { spawn } from 'child_process';
import axios from 'axios';
import { statSync, unlinkSync, createWriteStream, existsSync, renameSync, writeFileSync, readFileSync } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { createInterface } from 'readline';
import { JSDOM } from 'jsdom';
import { TaskOutput, bytes, elapsed, errorMessage } from './output';

const m3u8Parser = require('m3u8-parser');
const playListMapPtn = /\{.*http.*m3u8.*\}/;

export class Downloader {
    name: string;
    ext: string;
    listUrl?: string;
    maxDuration: number = 0;
    private lastDownloadError = '';

    constructor(name: string, ext: string, private readonly excludeChunkPatterns: RegExp[] = [],
        private readonly keepChunks: boolean = false, private readonly output = new TaskOutput()) {
        this.name = name;
        this.ext = ext;
    }

    async start(pageUrl: string) {
        const outFileName = this.name + '.' + this.ext;
        if (existsSync(outFileName)) {
            this.output.log(`file exists: ${outFileName}`);
            return;
        }

        const { urlsFileName, urls } = await this.pullSegUrls(pageUrl);
        const includedUrls = urls.filter(url => !this.isExcludedChunk(url));
        if (!includedUrls.length) {
            throw new Error('No segments remain to download after applying chunk exclusions.');
        }
        if (includedUrls.length < urls.length) {
            this.output.log(`Excluded ${urls.length - includedUrls.length}/${urls.length} segments matching --exclude-chunk.`);
        }
        const files = await this.downloadUrls(urls);
        if (files.length < includedUrls.length) {
            throw new Error(`Download incomplete: ${files.length}/${includedUrls.length}; segments and URL cache retained.`);
        }

        await this.output.task('Merge segments', async () => {
            this.output.update(`${files.length} segments`, outFileName);
            await concatSegments(files, outFileName, this.output);
            return { value: undefined, summary: `Merged ${outFileName} · ${bytes(statSync(outFileName).size)}` };
        });

        if (this.keepChunks) {
            this.output.log(`Keeping all ${files.length} segments and URL cache.`);
            return;
        }
        await this.output.task('Clean temporary files', async () => {
            files.forEach((file, i) => {
                this.output.update(`${i + 1}/${files.length}`, file);
                unlinkSync(file);
            });
            unlinkSync(urlsFileName);
            return { value: undefined, summary: `Cleaned ${files.length} segments and URL cache` };
        });
    }

    async downloadUrls(urls: string[]) {
        this.output.begin('Download segments');
        const files: string[] = [];
        const total = urls.filter(url => !this.isExcludedChunk(url)).length;
        let downloaded = 0;
        let reused = 0;
        let failed = 0;
        let consecutiveFailures = 0;
        let retries = 0;
        try {
            for (const [i, url] of urls.entries()) {
                if (this.isExcludedChunk(url)) continue;
                // Preserve original indexes so URL caches and retained files keep matching.
                const segNum = i + 1;
                const fileName = `${this.name}.seg${segNum.toString().padStart(4, '0')}.ts`;
                const progress = `${downloaded + reused + failed + 1}/${total}`;
                this.output.update(progress, `#${segNum} · ${fileName}`);
                if (existsSync(fileName)) {
                    files.push(fileName);
                    reused++;
                    consecutiveFailures = 0;
                    this.output.event(`#${segNum} reused from cache`);
                    continue;
                }
                this.output.event(`#${segNum} requesting ${short(url)}`);
                let duration = await this.download(url, fileName);
                if (!duration) {
                    retries++;
                    this.output.event(`#${segNum} retry 2/2 · ${this.lastDownloadError}`);
                    duration = await this.download(url, fileName);
                }
                if (duration) {
                    files.push(fileName);
                    downloaded++;
                    consecutiveFailures = 0;
                    this.output.event(`#${segNum} downloaded · ${elapsed(duration)}`);
                } else {
                    failed++;
                    consecutiveFailures++;
                    // Persist every exhausted segment, even when it leaves the live event buffer.
                    const failure = `#${segNum} failed after 2 attempts · ${short(url)} · ${this.lastDownloadError}`;
                    this.output.event(failure, true);
                }
                this.output.update(`${downloaded + reused + failed}/${total}`);
                if (consecutiveFailures >= 10) {
                    throw new Error('Download aborted: 10 consecutive segments failed after 2 attempts each; segments and URL cache retained.');
                }
            }
            const summary = `${downloaded} downloaded, ${reused} reused, ${failed} failed, ${retries} retries`;
            if (failed) this.output.fail(summary, ['Completed segments and URL cache are retained.']);
            else this.output.finish(`Downloaded segments · ${summary}`);
            return files;
        } catch (error) {
            this.output.fail(errorMessage(error));
            throw error;
        }
    }

    private isExcludedChunk(url: string) {
        return this.excludeChunkPatterns.some(pattern => {
            pattern.lastIndex = 0;
            return pattern.test(url);
        });
    }

    async pullSegUrls(pageUrl: string) {
        const urlsFileName = this.name + '_urls.json';
        if (existsSync(urlsFileName)) {
            return this.output.task('Read URL cache', async () => {
                const urls = JSON.parse(readFileSync(urlsFileName, 'utf-8')) as string[];
                return { value: { urlsFileName, urls }, summary: `Loaded URL cache · ${urls.length} segments` };
            });
        }
        if (pageUrl.endsWith('m3u8')) {
            this.listUrl = pageUrl;
        } else {
            this.listUrl = await this.output.task('Download and parse page', async () => {
                const listUrl = await getListUrl(pageUrl, this.output);
                return { value: listUrl, summary: 'Parsed page · found playlist' };
            });
        }
        return this.output.task('Download and parse playlist', async () => {
            const urls = await this.pullSegmentUrls();
            writeFileSync(urlsFileName, JSON.stringify(urls), { encoding: 'utf-8' });
            return { value: { urlsFileName, urls }, summary: `Parsed playlist · ${urls.length} segments` };
        });
    }

    async download(url: string, fileName: string) {
        const downloadingFileName = fileName + '.downloading';
        if (existsSync(downloadingFileName)) unlinkSync(downloadingFileName);
        try {
            const start = Date.now();
            this.output.activity(`Requesting segment · ${short(url)}`);
            await downloadFile(url, downloadingFileName, this.maxDuration * 2, this.output, fileName);
            const duration = Math.max(1, Date.now() - start);
            this.maxDuration = Math.max(duration, this.maxDuration);
            renameSync(downloadingFileName, fileName);
            return duration;
        } catch (error) {
            // Axios rejects HTTP errors before pipeline can own and close the response stream.
            if (axios.isAxiosError(error) && error.response?.data instanceof Readable) {
                error.response.data.destroy();
            }
            this.lastDownloadError = errorMessage(error);
            this.output.event(`Download error: ${errorMessage(error)}`);
            return false;
        }
    }

    getListUrl() {
        if (!this.listUrl) throw new Error('no list url');
        return this.listUrl;
    }

    async pullSegmentUrls(): Promise<string[]> {
        const rootManifest = await downloadAndParseM3U8(this.getListUrl(), this.output);
        const isFinalList = rootManifest.segments.length !== 0;
        const url = isFinalList ? this.getListUrl() : new URL(rootManifest.playlists[0].uri, this.getListUrl()).href;
        const segments = isFinalList ? rootManifest.segments : (await downloadAndParseM3U8(url, this.output)).segments;
        return segments.map(s => new URL(s.uri, url).href).filter(s => s.indexOf('/avod/') === -1);
    }
}

async function getListUrl(pageUrl: string, output: TaskOutput): Promise<string> {
    output.update('Requesting page', short(pageUrl));
    output.event(`Requesting ${short(pageUrl)}`);
    const response = await axios.get(pageUrl, {
        headers: { Accept: '*/*', 'Accept-Encoding': '*' }, signal: output.signal,
        onDownloadProgress: progress => output.update('Receiving page', bytes(progress.loaded))
    });
    output.update('Parsing page');
    output.event('Page received; looking for playlist');
    const dom = new JSDOM(response.data);
    try {
        for (const script of dom.window.document.querySelectorAll('script')) {
            const match = playListMapPtn.exec(script.innerHTML);
            if (match) {
                const url = JSON.parse(match[0]).url;
                if (typeof url === 'string' && url) return url;
            }
        }
        throw new Error('No playlist URL found in page.');
    } finally {
        dom.window.close();
    }
}

async function downloadAndParseM3U8(url: string, output: TaskOutput): Promise<{
    playlists: Array<{ uri: string }>; segments: Array<{ uri: string }>;
}> {
    output.update('Requesting playlist', short(url));
    output.event(`Requesting ${short(url)}`);
    const response = await axios.get(url, {
        headers: { Accept: '*/*', 'Accept-Encoding': '*' }, signal: output.signal,
        onDownloadProgress: progress => output.update('Receiving playlist', bytes(progress.loaded))
    });
    output.update('Parsing playlist', short(url));
    output.event('Playlist received; parsing');
    const parser = new m3u8Parser.Parser();
    parser.push(response.data);
    parser.end();
    return parser.manifest;
}

async function downloadFile(fileUrl: string, outputLocationPath: string, timeout: number,
    output: TaskOutput, fileName: string) {
    const response = await axios({
        method: 'get', url: fileUrl, responseType: 'stream', timeout, signal: output.signal,
        headers: { Accept: '*/*', 'Accept-Encoding': '*' }
    });
    output.event('Response received; downloading segment');
    const total = Number(response.headers['content-length']);
    let received = 0;
    response.data.on('data', (chunk: Buffer) => {
        received += chunk.length;
        output.activity(`Receiving · ${fileName} · ${bytes(received)}${total > 0 ? ' / ' + bytes(total) : ''}`);
    });
    await pipeline(response.data, createWriteStream(outputLocationPath), { signal: output.signal });
}

async function concatSegments(files: string[], outFileName: string, output: TaskOutput) {
    const proc = spawn('ffmpeg', ['-i', 'concat:' + files.join('|'), '-codec', 'copy',
        '-progress', 'pipe:1', '-nostats', '-hide_banner', outFileName], { signal: output.signal });
    const diagnostics: string[] = [];
    const progress = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    const errors = createInterface({ input: proc.stderr, crlfDelay: Infinity });
    let processed = '';
    let size = '';
    progress.on('line', line => {
        const split = line.indexOf('=');
        const key = line.slice(0, split);
        const value = line.slice(split + 1);
        if (key === 'out_time') processed = value;
        if (key === 'total_size' && /^\d+$/.test(value)) size = bytes(Number(value));
        output.update(`Processed ${processed || '00:00:00'}`, `${outFileName}${size ? ' · ' + size : ''}`);
    });
    errors.on('line', line => {
        if (!line.trim()) return;
        diagnostics.push(line);
        if (diagnostics.length > 8) diagnostics.shift();
        output.event(line);
    });
    try {
        await new Promise<void>((resolve, reject) => {
            proc.once('error', reject);
            proc.once('close', code => {
                if (code !== 0) reject(code ?? new Error('FFmpeg terminated by signal'));
                else resolve();
            });
        });
        if (!existsSync(outFileName)) throw new Error('output file not found');
        if (statSync(outFileName).size < 1024 * 1024) throw new Error('output file too small');
    } catch (error) {
        output.fail(typeof error === 'number' ? `FFmpeg exited with code ${error}` : errorMessage(error),
            [...diagnostics, 'Segments and URL cache are retained.']);
        throw error;
    } finally {
        progress.close();
        errors.close();
    }
}

function short(url: string) {
    return new URL(url).origin + '/…/' + shortPart(new URL(url).pathname.split('/').pop() || '');
}

function shortPart(part: string) {
    return part.length > 24 ? part.slice(0, 10) + '…' + part.slice(-10) : part;
}
