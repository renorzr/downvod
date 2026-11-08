# downvod

使用 TypeScript 编写的 HLS 视频下载命令行工具。解析 `.m3u8` 播放列表或受支持的视频页面，逐个下载分片，再通过 FFmpeg 合并为视频文件。

提供两个命令：

- `downvod`：下载一个视频。
- `batchdownvod`：按编号模板顺序下载多集视频。

## 环境要求

- Node.js 22 或更新版本，及 npm。
- FFmpeg，且 `ffmpeg` 命令已加入 `PATH`。
- Bash（使用 `install.sh` 时需要）。

检查环境：

```bash
node --version
npm --version
ffmpeg -version
```

Ubuntu / Debian 可通过 `sudo apt-get update && sudo apt-get install -y ffmpeg` 安装 FFmpeg；macOS 使用 `brew install ffmpeg`。Node.js 请单独安装满足版本要求的版本。

## 安装

推荐通过 npm 全局安装：

```bash
npm install --global @renorzr/downvod
```

安装后直接使用 `downvod` 和 `batchdownvod`，无需克隆仓库或安装 TypeScript。FFmpeg 仍需单独安装并加入 `PATH`。

也可安装到项目中，通过 `npx` 调用：

```bash
npm install @renorzr/downvod
npx downvod 'https://example.com/video/index.m3u8' 'movie.mp4'
npx batchdownvod '1-3' 'https://example.com/series/%d/index.m3u8' 'Series-%02d.mp4'
```

### 从源码安装

```bash
git clone https://github.com/renorzr/downvod.git
cd downvod
./install.sh
```

脚本检查环境，按 `package-lock.json` 安装依赖，编译 TypeScript，然后将构建产物打包安装到 npm 的全局目录。安装成功后可直接使用 `downvod` 和 `batchdownvod`；已安装的命令不依赖源码目录，可以移动或删除源码。

如果默认全局目录不可写，指定当前用户的安装目录：

```bash
./install.sh --prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
```

将上面的 `export` 写入 `~/.bashrc` 或 `~/.zshrc` 可使配置在新终端中生效。`--prefix` 也支持相对路径（相对于执行脚本时的目录）。查看脚本帮助：`./install.sh --help`。

也可以仅在源码目录编译运行：

```bash
npm ci --include=dev
npm run build
node dist/index.js 'https://example.com/video/index.m3u8' 'movie.mp4'
node dist/batch.js '1-3' 'https://example.com/series/%d/index.m3u8' 'Series-%02d.mp4'
```

`npm ci` 的 `prepare` 生命周期会自动编译；`npm run build` 用于修改源码后重新编译，不执行全局安装。

## 下载单个视频

```bash
downvod '<播放列表或视频页面 URL>' '<文件名>.<扩展名>' [--exclude-chunk '<正则表达式>'] [--keep-chunks]
```

直接传入播放列表：

```bash
downvod 'https://example.com/video/index.m3u8' 'movie.mp4'
```

也可传入受支持的页面：

```bash
downvod 'https://example.com/watch/123' 'movie.mp4'
```

页面需在内联 `<script>` 中包含工具可解析的 JSON 对象，其中 `url` 指向 m3u8。工具不会执行页面 JavaScript，也无法解析所有视频网站。

结果保存在当前工作目录。如果目标文件已存在，该视频会直接跳过。当前单个下载命令按 `.` 拆分文件名，请使用 `movie.mp4` 这类只有一个点的简单文件名，并在要保存文件的目录中执行命令。

## 批量下载

```bash
batchdownvod '<范围>' '<URL 模板>' '<文件名模板>.<扩展名>' [--exclude-chunk '<正则表达式>'] [--keep-chunks]
```

- 范围 `1-10` 表示第 1 到第 10 集（包含两端）；`22` 表示第 1 到第 22 集。
- URL 模板中的第一个 `%d` 替换为当前编号，不支持 `%02d` 补零。
- 文件名模板支持 `printf` 数字格式，如 `%d`、`%02d`、`%03d`。

```bash
batchdownvod '1-10' \
  'https://example.com/series/%d/index.m3u8' \
  'Series-%02d.mp4'

batchdownvod '22' \
  'https://example.com/series/episode-%d' \
  'Series (Episode %02d).mp4'
```

工具会按文件名模板的第一个空白或点之前的内容创建子目录，并在其中保存文件。例如，第一个命令输出到 `Series-%02d/Series-01.mp4` 至 `Series-%02d/Series-10.mp4`；第二个命令输出到 `Series/Series (Episode 01).mp4` 等文件。目录中的 `%02d` 不会被替换。

当前批量命令通过 shell 的 `printf` 处理文件名模板，请只使用自己编写并信任的简单模板，避免引号、反引号、`$()` 等 shell 特殊内容。

## 排除指定分片

使用 `--exclude-chunk` 按 JavaScript 正则表达式匹配分片 URL，匹配的分片不下载，也不参与合并。单个下载和批量下载都支持：

```bash
downvod 'https://example.com/index.m3u8' 'movie.mp4' \
  '--exclude-chunk=adv\.com\/'

batchdownvod '1-10' 'https://example.com/series/%d/index.m3u8' 'Series-%02d.mp4' \
  --exclude-chunk 'adv\.com/' \
  --exclude-chunk '/ads/'
```

- 支持 `--exclude-chunk=<正则>` 和 `--exclude-chunk '<正则>'`，可放在位置参数前后。
- 可重复传入；匹配任意一条规则即排除。未传入时保持原有下载行为。
- 匹配对象是相对于播放列表解析后的完整分片 URL，包含查询参数；不用于排除播放列表本身。
- 正则区分大小写，直接填写表达式，不加 `/.../` 分隔符。`/` 可以直接写，也可以写成 `\/`。
- 请用单引号保护正则，避免 shell 吞掉 `\` 或展开其他字符；例如 `'adv\.com/'` 中的点表示字面量 `.`。
- 空表达式或非法正则会报错退出；所有分片均被排除时也会报错，不生成空视频。

规则也适用于已有的 `_urls.json` 缓存。工具保留分片原始编号，避免改变过滤规则后错用已下载文件。已下载但被排除的旧 `.ts` 文件不会参与合并，可能留在目录中，可手动删除。

## 续传与临时文件

下载时，工具在输出目录生成：

- `<文件名>_urls.json`：分片地址缓存。
- `<文件名>.seg0001.ts` 等：已完成的分片。
- `<文件名>.seg0001.ts.downloading` 等：下载中的临时分片。

中断后，在同一目录使用相同参数重跑，会复用地址缓存并跳过已经完成的分片。每个分片最多尝试两次；只要还有分片失败，就不会合并。全部分片成功且 FFmpeg 合并通过检查后，默认会删除地址缓存和已完成的 `.ts` 分片。

加上 `--keep-chunks` 可在合并成功后保留分片及 `_urls.json` 缓存，两个命令都支持，也可与 `--exclude-chunk` 同时使用：

```bash
downvod 'https://example.com/index.m3u8' 'movie.mp4' --keep-chunks

batchdownvod '1-10' 'https://example.com/series/%d/index.m3u8' 'Series-%02d.mp4' \
  --keep-chunks '--exclude-chunk=adv\.com\/'
```

保留的分片可用于后续重新合并；重跑前先移动或删除目标视频，否则仍会因目标文件已存在而跳过。合并失败时，无论是否设置此开关都会保留分片和缓存。

分片地址过期时，可删除对应的 `_urls.json` 后重新获取。切换视频时应使用新文件名，或先清理旧缓存和分片，避免混用内容。FFmpeg 合并失败可能留下目标文件；确认它无效后，先删除目标文件再重试，否则会被“文件已存在”检查跳过。

## 查看版本

两个命令正常运行时会首先显示命令名称和版本。使用 `--version` 或 `-v` 仅输出版本号并退出，无需下载参数，也不会创建目录或发起下载：

```bash
downvod --version
batchdownvod -v
```

版本号读取自安装包的 `package.json`，与 npm 发布版本一致。完整选项可通过 `downvod --help` 或 `batchdownvod --help` 查看。

## 当前限制与排查

- 主要面向未加密的 HLS MPEG-TS 分片；不支持直接下载普通 MP4 文件、DRM、HLS 加密、fMP4 初始化分片或实时录制。
- 直接传入的播放列表 URL 必须以 `m3u8` 结尾；当前不能直接识别带查询参数的 m3u8 URL。
- 主播放列表仅选择第一个子播放列表，不提供清晰度或独立音轨选择。
- 地址中包含 `/avod/` 的分片默认会被过滤；可通过 `--exclude-chunk` 添加其他排除规则。
- FFmpeg 使用流复制合并，不转码；输出扩展名需与源音视频编码兼容。
- 合并结果小于 1 MiB 时会被判定失败，短视频也可能触发这一检查。
- 不提供登录、Cookie、自定义请求头或 Referer 配置；需要这些信息的源可能返回 401 / 403。
- 出现 `command not found` 时检查 npm 全局目录：`npm prefix -g`，并确认其 `bin` 子目录已加入 `PATH`。
- 出现 `spawn ffmpeg ENOENT` 时检查 `ffmpeg -version` 是否能运行。

请仅下载有权访问和保存的视频。

## 开发与更新

```bash
npm ci --include=dev
npm run build
```

源码位于 `src/`，编译产物位于 `dist/`。依赖版本由 `package-lock.json` 固定，修改依赖后应一并提交锁文件。

运行参数解析、分片过滤和续传缓存的回归测试：

```bash
npm test
```

通过 npm 安装的命令可直接更新：

```bash
npm install --global @renorzr/downvod@latest
```

从源码安装的命令，拉取源码后重新运行安装脚本，保持与首次安装相同的 `--prefix`。

```bash
git pull
./install.sh --prefix "$HOME/.local"
```

卸载 npm 全局安装的命令：

```bash
npm uninstall --global @renorzr/downvod
```

从自定义目录卸载：

```bash
npm uninstall --global --prefix "$HOME/.local" @renorzr/downvod
```

## 发布到 npm

维护者在源码目录安装开发依赖并登录 npm 后发布：

```bash
npm ci --include=dev
npm login
npm publish
```

发布时自动编译，包中包含 `dist/`、README 和许可证。后续发布前需要更新 `package.json` 和锁文件中的版本号（例如 `npm version patch`）；同一版本不能重复发布。
