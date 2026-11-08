#!/usr/bin/env node

import { Downloader } from "./downloader";
import { parseCliArgs } from "./cli";

async function main() {
  const { positionals, excludeChunkPatterns, help } = parseCliArgs(process.argv.slice(2));
  const [pageUrl, fileName] = positionals;
  const [name, ext] = (fileName || '').split('.');
  if (help || positionals.length !== 2 || !pageUrl || !name || !ext) {
    console.log("Usage: downvod <listUrl> <name>.<ext> [--exclude-chunk <regexp>]");
    console.log("  --exclude-chunk <regexp>  Exclude matching segment URLs (repeatable)");
    process.exitCode = help ? 0 : 1;
    return;
  }

  console.log("pageUrl=", pageUrl, "name=", name, "ext=", ext);
  const downloader = new Downloader(name, ext, excludeChunkPatterns);
  await downloader.start(pageUrl);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
