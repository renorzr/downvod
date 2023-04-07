import { spawn } from 'child_process';
import axios from "axios";
import { unlinkSync, createWriteStream, existsSync, renameSync, writeFileSync, readFileSync } from 'fs';
import { JSDOM } from "jsdom";

const m3u8Parser = require("m3u8-parser");
const playListMapPtn = /\{.*http.*m3u8.*\}/
const DATE_TIME_FORMAT = Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false });

export class Downloader {
  name: string;
  ext: string;
  listUrl?: string;
  maxDuration: number = 0;

  constructor(name: string, ext: string) {
    this.name = name;
    this.ext = ext;
  }

  async start(pageUrl: string) {
    const outFileName = this.name + '.' + this.ext;
    if (existsSync(outFileName)) {
      console.log("file exists:", outFileName);
      return;
    }

    const { urlsFileName, urls } = await this.pullSegUrls(pageUrl);

    console.log("Segment URLs:");
    urls.slice(0, 3).forEach(url => console.log(url));
    if (urls.length > 3) {
      console.log(`... and ${urls.length - 3} more urls.`);
    }
    const files = await this.downloadUrls(urls);

    if (files.length < urls.length) {
      console.log(`Download incompleted: ${files.length}/${urls.length} , abort.`)
      return;
    }

    console.log('concat all', files.length, 'segments');
    await concatSegments(files, outFileName);

    console.log('clean all', files.length, 'segments');
    files.forEach(file => unlinkSync(file));
    unlinkSync(urlsFileName);
  }

  async downloadUrls(urls: string[]) {
    const files = [];
    for (const i in urls) {
      const url = urls[i];
      const segNum = parseInt(i) + 1;
      const fileName = `${this.name}.seg${segNum.toString().padStart(4, '0')}.ts`;
      if (existsSync(fileName)) {
        process.stdout.write(`skip ${segNum}/${urls.length} since ${fileName} exists\r`);
        files.push(fileName);
        continue;
      }
      process.stdout.write(`${DATE_TIME_FORMAT.format(new Date())} downloading ${segNum}/${urls.length}: ${short(url)} ==> ${fileName} ...`);
      // 2 download attempts
      const duration = await this.download(url, fileName) || await this.download(url, fileName);
      if (duration) {
        files.push(fileName);
        console.log(` Done in ${(duration / 1000).toFixed(1)} secs`);
      } else {
        console.log(' Failed');
      }
    }
    return files;
  }

  async pullSegUrls(pageUrl: string) {
    const urlsFileName = this.name + '_urls.json';
    if (existsSync(urlsFileName)) {
      const data = readFileSync(urlsFileName, { encoding: 'utf-8' });
      return { urlsFileName, urls: JSON.parse(data) as string[] };
    }
    this.listUrl = await getListUrl(pageUrl);
    const urls = await this.pullSegmentUrls();
    writeFileSync(urlsFileName, JSON.stringify(urls), { encoding: 'utf-8' });
    return { urlsFileName, urls };
  }

  async download(url: string, fileName: string) {
    const downloadingFileName = fileName + '.downloading';
    if (existsSync(downloadingFileName)) {
      unlinkSync(downloadingFileName);
    }
    try {
      const start = Date.now();
      if (await downloadFile(url, downloadingFileName, this.maxDuration * 2)) {
        const duration = Date.now() - start;
        this.maxDuration = Math.max(duration, this.maxDuration);
        renameSync(downloadingFileName, fileName);
        return duration
      }
    } catch (e) {
      return false;
    }
  }

  getListUrl() {
    if (!this.listUrl) {
      throw new Error("no list url");
    }
    return this.listUrl;
  }

  async pullSegmentUrls(): Promise<string[]> {
    const rootManifest = await downloadAndParseM3U8(this.getListUrl());
    const isFinalList = rootManifest.segments.length != 0;
    const url = isFinalList ? this.getListUrl() : new URL(rootManifest.playlists[0].uri, this.getListUrl()).href;
    const segments = isFinalList ? rootManifest.segments : (await downloadAndParseM3U8(url)).segments;
    return segments.map(s => new URL(s.uri, url).href);
  }
}

async function getListUrl(pageUrl: string) {
  if (pageUrl.endsWith('m3u8')) {
    return pageUrl;
  }

  const response = await axios.get(pageUrl, { headers: { Accept: "*/*", "Accept-Encoding": "*" } });
  const dom = new JSDOM(response.data);
  let playListMap;
  for (const s of dom.window.document.querySelectorAll("script")) {
    const m = playListMapPtn.exec(s.innerHTML);
    if (m) {
      playListMap = m[0]
      break;
    }
  };
  console.log('playListMap=', playListMap);

  return playListMap && JSON.parse(playListMap).url;
}


async function downloadAndParseM3U8(url: string): Promise<{ playlists: Array<{ uri: string }>, segments: Array<{ uri: string }> }> {
  const rootRes = await axios.get(url, { headers: { Accept: "*/*", "Accept-Encoding": "*" } });
  const parser = new m3u8Parser.Parser();
  parser.push(rootRes.data);
  parser.end();
  return parser.manifest;
}

async function downloadFile(fileUrl: string, outputLocationPath: string, timeout: number = 5000) {
  const writer = createWriteStream(outputLocationPath);
  const response = await axios({
    method: 'get',
    url: fileUrl,
    responseType: 'stream',
    timeout,
    headers: { Accept: "*/*", "Accept-Encoding": "*" }
  });
  const stream = response.data;
  stream.pipe(writer);

  return new Promise((resolve, reject) => {
    stream.on('error', (err: any) => {
      process.stdout.write('error download: ' + err.code);
      writer.close();
      resolve(false);
    });
    writer.on('error', (err) => {
      process.stdout.write('error write: ' + err.message);
      writer.close();
      resolve(false);
    });
    writer.on('close', () => {
      resolve(true);
    });
  });
}

async function concatSegments(files: string[], outFileName: string) {
  const proc = spawn('ffmpeg', ['-i', 'concat:' + files.join('|'), '-codec', 'copy', outFileName]);
  proc.stdout.pipe(process.stdout);
  proc.stderr.pipe(process.stderr);

  await new Promise(((resolve, reject) => {
    proc.on('close', code => {
      console.log('ffmpeg exited with code', code);
      if (code === 0) {
        resolve(code);
      } else {
        reject(code);
      }
    });
  }))
}

function short(url: string) {
  return new URL(url).origin + '/.../' + url.split('/').pop();
}