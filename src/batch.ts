#!/usr/bin/env node

import { execSync } from "child_process";
import { Downloader } from "./downloader";
import { mkdirSync } from 'fs';
import { chdir } from 'process';

const [, , range, pageUrlTemplate, nameExtTemplate] = process.argv;

// name should match the pattern: <name>.<ext>
const m = nameExtTemplate?.match(/(.+)\.(.+)/);
if (!m || !range || !pageUrlTemplate) {
    console.log("Usage: batchdownvod <range> <pageUrlTemplate> <nameTemplate.ext>");
    console.log("Example:");
    console.log("batchdownvod 1-10 https://www.example.com/%d.mp4 %d.mp4");
    console.log("batchdownvod 22 https://www.example.com/sample-series-%d.mp4 'Sample Series (Episode %02d).mp4'");
    process.exit(1);
}

const dirName = nameExtTemplate.split(/[\.\s]/)[0];
mkdirSync(dirName, { recursive: true });
chdir(dirName);

const [from, to] = (range.indexOf('-') == -1 ? ['1', range] : range.split("-")).map(x => parseInt(x));
const [, nameTemplate, extTemplate] = m;

(async function () {
    for (let i = from; i <= to; i++) {
        const pageUrl = pageUrlTemplate.replace("%d", i.toString());
        const name = format(nameTemplate, i);
        const ext = format(extTemplate, i);
        console.log("pageUrl=", pageUrl, "name=", name, "ext=", ext);
        const downloader = new Downloader(name, ext);
        await downloader.start(pageUrl);
    }
})();

function format(str: string, ...args: any[]) {
    return execSync(`printf "${str}" ${args.join(" ")}`).toString().trim();
}