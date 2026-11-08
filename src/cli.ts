import { parseArgs } from 'util';

export const VERSION: string = require('../package.json').version;

export function parseCliArgs(args: string[]) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            'exclude-chunk': { type: 'string', multiple: true },
            'keep-chunks': { type: 'boolean', default: false },
            version: { type: 'boolean', short: 'v', default: false },
            help: { type: 'boolean', short: 'h' }
        }
    });

    const excludeChunkPatterns = (values['exclude-chunk'] || []).map(pattern => {
        if (!pattern) {
            throw new Error('--exclude-chunk requires a non-empty regular expression.');
        }
        try {
            return new RegExp(pattern);
        } catch {
            throw new Error(`Invalid --exclude-chunk regular expression: ${pattern}`);
        }
    });

    return { positionals, excludeChunkPatterns, keepChunks: values['keep-chunks'], version: values.version, help: values.help };
}
