#!/usr/bin/env node

import { Downloader } from "./downloader";
import { parseCliArgs, VERSION } from "./cli";

async function main() {
  const { positionals, excludeChunkPatterns, keepChunks, version, help } = parseCliArgs(process.argv.slice(2));
  if (version) {
    console.log(VERSION);
    return;
  }
  console.log(`downvod ${VERSION}`);
  const [pageUrl, fileName] = positionals;
  const [name, ext] = (fileName || '').split('.');
  if (help || positionals.length !== 2 || !pageUrl || !name || !ext) {
    console.log("Usage: downvod <listUrl> <name>.<ext> [--exclude-chunk <regexp>] [--keep-chunks]");
    console.log("  --exclude-chunk <regexp>  Exclude matching segment URLs (repeatable)");
    console.log("  --keep-chunks              Keep segments and URL cache after merging");
    console.log("  -v, --version              Print the version and exit");
    process.exitCode = help ? 0 : 1;
    return;
  }

  console.log("pageUrl=", pageUrl, "name=", name, "ext=", ext);
  const downloader = new Downloader(name, ext, excludeChunkPatterns, keepChunks);
  await downloader.start(pageUrl);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
