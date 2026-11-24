import { setTimeout as delay } from 'node:timers/promises';
import { cell, object, tool } from './support.mjs';

// What the approval tests share: the packet the delivery adapter prepares, a cell whose one tool sends through it, a
// call to that tool with a call key, and the approval waiting for the person.

export const packet = (value) => ({
  account: 'test',
  destination: 'out',
  operation: 'deliver',
  content: { message: value },
  files: [{ name: 'data.txt', mediaType: 'text/plain', base64: Buffer.from(value).toString('base64') }],
});
export const graph = [
  cell('root', ['send']),
  tool('send', { adapter: 'delivery' }, { inputSchema: object({ message: { type: 'string' } }) }),
];
export const use = (client, key, message = 'review me') =>
  client.callTool({
    name: 'send',
    arguments: { message },
    _meta: { 'celler/call-id': key },
  });

export async function pending(app) {
  const timeout = AbortSignal.timeout(4000);
  for (;;) {
    const item = app.human.inbox('alice').find((row) => row.state === 'pending');
    if (item) return item.id;
    await delay(5, undefined, { signal: timeout });
  }
}
