import { Terminal } from '@xterm/xterm';
import { expect, it } from 'vitest';

it('returns a cursor-position report requested by a console application', async () => {
  const terminal = new Terminal({ cols: 80, rows: 24 });
  const responses: string[] = [];
  const subscription = terminal.onData((data) => responses.push(data));
  await new Promise<void>((resolve) => terminal.write('\x1b[6n', resolve));
  expect(responses).toEqual(['\x1b[1;1R']);
  subscription.dispose();
  terminal.dispose();
});
