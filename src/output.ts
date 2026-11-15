import { stripVTControlCharacters } from 'util';

const EVENT_LINES = 4;
const TASK_LINES = 2 + EVENT_LINES;

export interface OutputStream {
    write(text: string): unknown;
    isTTY?: boolean;
    columns?: number;
    rows?: number;
}

function clean(text: string): string {
    return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

// Count wide characters conservatively so filenames, CJK and emoji never wrap.
function charWidth(char: string): number {
    if (/[\p{Mark}\p{Format}]/u.test(char)) return 0;
    const n = char.codePointAt(0)!;
    return /\p{Extended_Pictographic}/u.test(char) ||
        (n >= 0x1100 && (n <= 0x115f || n === 0x2329 || n === 0x232a ||
        (n >= 0x2e80 && n <= 0xa4cf) || (n >= 0xac00 && n <= 0xd7a3) ||
        (n >= 0xf900 && n <= 0xfaff) || (n >= 0xfe10 && n <= 0xfe6f) ||
        (n >= 0xff01 && n <= 0xff60) || (n >= 0xffe0 && n <= 0xffe6) || n >= 0x1f000)) ? 2 : 1;
}

function fit(text: string, columns: number): string {
    const chars = Array.from(clean(text));
    let width = 0;
    let result = '';
    for (const char of chars) {
        const next = charWidth(char);
        if (width + next > columns - 1) return result + '…';
        result += char;
        width += next;
    }
    return result;
}

export function elapsed(ms: number): string {
    return ms < 60000 ? `${(ms / 1000).toFixed(1)}s` :
        `${Math.floor(ms / 60000)}m${Math.floor(ms / 1000) % 60}s`;
}

export function bytes(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Owns the terminal's only live region. All task output must go through here. */
export class TaskOutput {
    private title = '';
    private status = '';
    private detail = '';
    private events: string[] = [];
    private importantEvents: string[] = [];
    private started = 0;
    private timer?: ReturnType<typeof setInterval>;
    private drawnWidths: number[] = [];
    private cursorHidden = false;
    private frame = 0;
    private readonly controller = new AbortController();
    readonly signal = this.controller.signal;

    constructor(private readonly stream: OutputStream = process.stdout,
        private readonly interactive = Boolean(stream.isTTY && !process.env.CI && process.env.TERM !== 'dumb')) {}

    private get dynamic(): boolean {
        return this.interactive && (this.stream.columns ?? 80) >= 20 && (this.stream.rows ?? 24) > TASK_LINES;
    }

    begin(title: string) {
        if (this.title) throw new Error('A console task is already running.');
        this.title = title;
        this.status = '';
        this.detail = '';
        this.events = [];
        this.importantEvents = [];
        this.started = Date.now();
        if (!this.dynamic) this.log(`> ${title}`);
        this.render();
        if (this.interactive) {
            this.timer = setInterval(() => this.render(), 100);
            this.timer.unref();
        }
    }

    update(status: string, detail?: string) {
        this.status = status;
        if (detail !== undefined) this.detail = detail;
    }

    activity(detail: string) {
        this.detail = detail;
    }

    event(message: string, important = false) {
        this.events.push(`${new Date().toTimeString().slice(0, 8)}  ${clean(message)}`);
        this.events = this.events.slice(-EVENT_LINES);
        if (important) {
            if (this.interactive && this.title) this.importantEvents.push(message);
            else this.log(`! ${message}`);
        }
    }

    log(message: string) {
        this.clear();
        this.stream.write(clean(message) + '\n');
        this.render();
    }

    finish(summary: string) {
        this.end(`✓ ${summary} · ${elapsed(Date.now() - this.started)}`);
    }

    fail(message: string, details: string[] = []) {
        if (!this.title) return;
        this.end(`✗ ${this.title} · ${message}`, details);
    }

    async task<T>(title: string, action: () => Promise<{ value: T; summary: string }>): Promise<T> {
        this.begin(title);
        try {
            const { value, summary } = await action();
            this.finish(summary);
            return value;
        } catch (error) {
            this.fail(errorMessage(error));
            throw error;
        }
    }

    private end(summary: string, details: string[] = []) {
        const importantEvents = this.importantEvents;
        this.dispose();
        for (const event of importantEvents) this.stream.write('! ' + clean(event) + '\n');
        this.stream.write(clean(summary) + '\n');
        for (const line of details) this.stream.write('  ' + clean(line) + '\n');
    }

    private clear() {
        if (!this.drawnWidths.length) return;
        // Account for reflow if the terminal was made narrower since the last frame.
        const columns = Math.max(1, this.stream.columns ?? 80);
        const rows = this.drawnWidths.reduce((sum, width) => sum + Math.max(1, Math.ceil(width / columns)), 0);
        const up = Math.min(rows, Math.max(0, (this.stream.rows ?? 24) - 1));
        this.stream.write(`${up ? `\x1b[${up}A` : ''}\r\x1b[0J`);
        this.drawnWidths = [];
    }

    private render() {
        if (!this.title) return;
        this.clear();
        if (!this.dynamic) {
            this.showCursor();
            return;
        }
        if (!this.cursorHidden) {
            this.stream.write('\x1b[?25l');
            this.cursorHidden = true;
        }
        const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][this.frame++ % 10];
        const lines = [
            `${spinner} ${this.title}${this.status ? ' · ' + this.status : ''} · ${elapsed(Date.now() - this.started)}`,
            `  ${this.detail}`,
            ...Array.from({ length: EVENT_LINES }, (_, i) => `  ${this.events[i] ?? ''}`)
        ].map(line => fit(line, (this.stream.columns ?? 80) - 1));
        this.stream.write(lines.join('\n') + '\n');
        this.drawnWidths = lines.map(line => Array.from(line).reduce((sum, char) => sum + charWidth(char), 0));
    }

    private showCursor() {
        if (this.cursorHidden) this.stream.write('\x1b[?25h');
        this.cursorHidden = false;
    }

    dispose() {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        this.clear();
        this.showCursor();
        this.title = '';
        this.importantEvents = [];
    }

    installProcessHandlers(): () => void {
        const interrupt = (signal: NodeJS.Signals) => {
            const details = [this.status, this.detail].filter(Boolean);
            this.controller.abort();
            this.fail('Interrupted; completed segments and URL cache are retained.', details);
            this.dispose();
            process.exit(signal === 'SIGINT' ? 130 : 143);
        };
        const onInt = () => interrupt('SIGINT');
        const onTerm = () => interrupt('SIGTERM');
        const onExit = () => this.dispose();
        process.once('SIGINT', onInt);
        process.once('SIGTERM', onTerm);
        process.once('exit', onExit);
        return () => {
            this.dispose();
            process.removeListener('SIGINT', onInt);
            process.removeListener('SIGTERM', onTerm);
            process.removeListener('exit', onExit);
        };
    }
}
