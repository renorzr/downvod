#!/usr/bin/env node

import { execSync } from "child_process";
import { Downloader } from "./downloader";
import { mkdirSync } from 'fs';
import { chdir } from 'process';
import { parseCliArgs, VERSION } from "./cli";

async function main() {
    const { positionals, excludeChunkPatterns, keepChunks, version, help } = parseCliArgs(process.argv.slice(2));
    if (version) {
        console.log(VERSION);
        return;
    }
    console.log(`batchdownvod ${VERSION}`);
    const [range, pageUrlTemplate, nameExtTemplate] = positionals;

    // name should match the pattern: <name>.<ext>
    const m = nameExtTemplate?.match(/(.+)\.(.+)/);
    if (help || positionals.length !== 3 || !m || !range || !pageUrlTemplate) {
        console.log("Usage: batchdownvod <range> <pageUrlTemplate> <nameTemplate.ext> [--exclude-chunk <regexp>] [--keep-chunks]");
        console.log("  --exclude-chunk <regexp>  Exclude matching segment URLs (repeatable)");
        console.log("  --keep-chunks              Keep segments and URL cache after merging");
        console.log("  -v, --version              Print the version and exit");
        console.log("Example:");
        console.log("batchdownvod 1-10 https://www.example.com/%d/index.m3u8 'Series-%02d.mp4'");
        process.exitCode = help ? 0 : 1;
        return;
    }

    const dirName = nameExtTemplate.split(/[\.\s]/)[0];
    mkdirSync(dirName, { recursive: true });
    chdir(dirName);

    const [from, to] = (range.indexOf('-') == -1 ? ['1', range] : range.split("-")).map(x => parseInt(x));
    const [, nameTemplate, extTemplate] = m;

    for (let i = from; i <= to; i++) {
        const pageUrl = pageUrlTemplate.replace("%d", i.toString());
        const name = format(nameTemplate, i);
        const ext = format(extTemplate, i);
        console.log("pageUrl=", pageUrl, "name=", name, "ext=", ext);
        const downloader = new Downloader(name, ext, excludeChunkPatterns, keepChunks);
        await downloader.start(pageUrl);
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});

function format(str: string, ...args: any[]) {
    return execSync(`printf "${str}" ${args.join(" ")}`).toString().trim();
}
