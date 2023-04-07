#!/usr/bin/env node

import { Downloader } from "./downloader";

const pageUrl = process.argv[2];
const [name, ext] = (process.argv[3] || '').split('.');
(async function () {
  console.log("pageUrl=", pageUrl, "name=", name, "ext=", ext);
  if (!pageUrl || !name || !ext) {
    console.log("Usage: downvod <listUrl> <name>.<ext>");
    return 1;
  }

  const downloader = new Downloader(name, ext);
  await downloader.start(pageUrl);
})();
