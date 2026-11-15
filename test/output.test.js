const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { TaskOutput } = require('../dist/output');

// A small terminal model: cursor-up and erase-down overwrite existing rows.
class Terminal {
    columns = 72;
    rows = 24;
    isTTY = true;
    lines = [''];
    row = 0;
    column = 0;
    hidden = false;
    chunks = [];
    write(text) {
        this.chunks.push(text);
        const tokens = text.match(/\x1b\[[0-9;?]*[A-Za-z]|[^\x1b]/gu) || [];
        for (const token of tokens) {
            if (token === '\x1b[?25l') this.hidden = true;
            else if (token === '\x1b[?25h') this.hidden = false;
            else if (/^\x1b\[\d+A$/.test(token)) this.row = Math.max(0, this.row - Number(token.slice(2, -1)));
            else if (token === '\x1b[0J') {
                this.lines = this.lines.slice(0, this.row + 1);
                this.lines[this.row] = this.lines[this.row].slice(0, this.column);
            } else if (token === '\n') {
                this.row++;
                this.column = 0;
                this.lines[this.row] ??= '';
            } else if (token === '\r') this.column = 0;
            else {
                const line = this.lines[this.row];
                this.lines[this.row] = line.slice(0, this.column) + token + line.slice(this.column + token.length);
                this.column += token.length;
            }
        }
    }
    get text() { return this.lines.join('\n'); }
}

test('live task stays four rows, rotates events and commits only its summary', async t => {
    const terminal = new Terminal();
    const output = new TaskOutput(terminal, true);
    t.after(() => output.dispose());
    output.log('History');
    output.begin('Download segments');
    output.update('2/100', 'Receiving second segment');
    output.event('first event');
    output.event('second event');
    output.event('third event');
    await delay(130);
    assert.equal(terminal.row, 5, terminal.text);
    assert.match(terminal.text, /2\/100/);
    assert.match(terminal.text, /Receiving second segment/);
    assert.doesNotMatch(terminal.text, /first event/);
    assert.match(terminal.text, /second event[\s\S]*third event/);
    output.update('80/100', 'Receiving later segment');
    await delay(130);
    assert.equal(terminal.row, 5, terminal.text);
    assert.doesNotMatch(terminal.text, /Receiving second segment/);
    output.event('segment retry', true);
    assert.equal(terminal.row, 5, 'important events wait until the task completes');
    output.finish('100 downloaded');
    assert.equal(terminal.row, 3, terminal.text);
    assert.match(terminal.text, /^History\n! segment retry\n✓ 100 downloaded/);
    assert.doesNotMatch(terminal.text, /Receiving|second event|third event/);
    assert.equal(terminal.hidden, false);
    const writes = terminal.chunks.length;
    await delay(130);
    assert.equal(terminal.chunks.length, writes, 'no render timer after completion');
    output.begin('Merge');
    output.fail('FFmpeg exited with code 1', ['Invalid input', 'Cache retained']);
    assert.match(terminal.text, /✓ 100 downloaded[\s\S]*✗ Merge · FFmpeg exited with code 1\n  Invalid input\n  Cache retained/);
    assert.equal(terminal.hidden, false);
});

test('plain output is bounded and contains no progress frames or cursor controls', async () => {
    let text = '';
    const output = new TaskOutput({ write: value => text += value, isTTY: false });
    await output.task('Download', async () => {
        for (let i = 0; i < 1000; i++) {
            output.update(`${i}/1000`, 'bytes');
            output.event(`segment ${i}`);
        }
        output.event('retry after timeout', true);
        return { value: 42, summary: '1000 downloaded' };
    });
    assert.equal(text.split('\n').length - 1, 3);
    assert.match(text, /^> Download\n! retry after timeout\n✓ 1000 downloaded/);
    assert.doesNotMatch(text, /\x1b|\r|segment 999|bytes/);
});

test('long CJK text and control characters cannot wrap or inject terminal output', async t => {
    const terminal = new Terminal();
    terminal.columns = 30;
    const output = new TaskOutput(terminal, true);
    t.after(() => output.dispose());
    output.begin('Parse');
    output.activity('中文'.repeat(30) + '\x1b[2J\nInjected');
    output.event('safe\r\nmessage\x1b[31m');
    await delay(130);
    assert.equal(terminal.row, 4);
    assert.doesNotMatch(terminal.chunks.join(''), /\x1b\[2J|\x1b\[31m/);
    const detail = terminal.lines[1];
    const cells = Array.from(detail).reduce((n, char) => n + (/[中文]/.test(char) ? 2 : 1), 0);
    assert.ok(cells < terminal.columns, detail);
    assert.match(detail, /…$/);
    terminal.columns = 10;
    await delay(130);
    assert.equal(terminal.hidden, false, 'tiny terminal disables live rendering');
    output.finish('Parsed');
    assert.match(terminal.text, /✓ Parsed/);
});

test('rejected task restores cursor and lets the next task start', async () => {
    const terminal = new Terminal();
    const output = new TaskOutput(terminal, true);
    await assert.rejects(output.task('Parse', async () => { throw new Error('bad playlist'); }), /bad playlist/);
    assert.equal(terminal.hidden, false);
    assert.match(terminal.text, /✗ Parse · bad playlist/);
    await output.task('Retry', async () => ({ value: undefined, summary: 'Parsed' }));
    assert.match(terminal.text, /✓ Parsed/);
    assert.equal(terminal.hidden, false);
});
