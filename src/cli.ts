import { parseArgs } from 'util';

export function parseCliArgs(args: string[]) {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            'exclude-chunk': { type: 'string', multiple: true },
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

    return { positionals, excludeChunkPatterns, help: values.help };
}
