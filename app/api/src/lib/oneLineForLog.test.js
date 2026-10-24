import { describe, it, expect } from 'vitest';
import { oneLineForLog } from './oneLineForLog.js';

describe('oneLineForLog', () => {
  it('folds every kind of line break into one space, so no second log line can start', () => {
    expect(oneLineForLog('denied\nINFO forged entry')).toBe('denied INFO forged entry');
    expect(oneLineForLog('a\r\nb\rc\n\n\nd')).toBe('a b c d');
  });

  it('leaves no line break behind at the edges of the text either', () => {
    expect(oneLineForLog('\r\nfirst\nlast\n')).toBe(' first last ');
  });

  it('takes replacement patterns in the text literally', () => {
    expect(oneLineForLog('cost $& more\n$1 $$')).toBe('cost $& more $1 $$');
  });

  it('keeps the rest of the message as written', () => {
    expect(oneLineForLog('System "Café HR" (id 7) is not yours')).toBe('System "Café HR" (id 7) is not yours');
  });

  it('logs nothing for a missing value and the text of anything else', () => {
    expect(oneLineForLog(undefined)).toBe('');
    expect(oneLineForLog(null)).toBe('');
    expect(oneLineForLog(42)).toBe('42');
  });
});
