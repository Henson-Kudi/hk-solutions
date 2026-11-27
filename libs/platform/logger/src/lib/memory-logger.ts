import { createLogger, type Logger, type LoggerOptions } from './logger';

/** One written log line, parsed back from JSON. */
export type LogEntry = Record<string, unknown> & {
  level: string;
  message: string;
};

export interface MemoryLogger {
  logger: Logger;
  /** Every line written so far, oldest first. */
  entries: LogEntry[];
  /** The raw text of every line, for asserting that something never appears. */
  text(): string;
  clear(): void;
}

/**
 * A real logger that writes to memory. For tests: the lines go through the
 * same formatting and redaction as in production, so a test can assert on what
 * would actually be written.
 */
export const createMemoryLogger = (
  options: Partial<Omit<LoggerOptions, 'destination'>> = {},
): MemoryLogger => {
  const entries: LogEntry[] = [];
  const lines: string[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'trace',
    ...options,
    destination: {
      write(line: string) {
        lines.push(line);
        entries.push(JSON.parse(line) as LogEntry);
      },
    },
  });
  return {
    logger,
    entries,
    text: () => lines.join(''),
    clear: () => {
      entries.length = 0;
      lines.length = 0;
    },
  };
};
