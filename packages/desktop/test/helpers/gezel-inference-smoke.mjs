import assert from 'node:assert/strict';
import process from 'node:process';
import { readdir } from 'node:fs/promises';
import { connectOrHost } from '@bendyline/gezel-app-sdk/host';
import * as inference from '@bendyline/gezel-inference';
import { StreamingSessionBase } from '@bendyline/gezel/local-loop';

const home = process.argv[2];
let disconnected = 0;
class Session extends StreamingSessionBase {
  async sendAndWait() {
    this.emitDelta('Hello from the shared runtime');
    return 'Hello from the shared runtime';
  }
  async disconnect() {
    disconnected++;
  }
}
const provider = {
  name: 'llama-cpp',
  supportsPriorMessages: true,
  initialize: async () => {},
  shutdown: async () => {},
  listModels: async () => [{ id: 'fixture', name: 'Fixture' }],
  createSession: async () => new Session(),
};
const serviceModule = {
  ...inference,
  startService: (opts) =>
    inference.startService({ ...opts, providers: new Map([['llama-cpp', provider]]) }),
};
const gezel = await connectOrHost({
  appId: 'docblocks-smoke',
  appName: 'DocBlocks smoke',
  host: { mode: 'in-process', inferenceOnly: true, home, serviceModule },
  prefer: 'host',
});
try {
  const { daemon } = gezel;
  const request = (route, body) =>
    daemon.fetch(`${daemon.baseUrl}${route}`, {
      headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
  const models = await (await request('/v1/models')).json();
  assert(models.data.some((model) => model.id === 'llama-cpp:fixture'));
  const stream = await request('/v1/chat/completions', {
    model: 'llama-cpp:fixture',
    stream: true,
    messages: [{ role: 'user', content: 'Hello' }],
  });
  assert.equal(stream.status, 200);
  assert.match(await stream.text(), /Hello from the shared runtime/);
  assert.equal(disconnected, 1);
  assert.equal((await request('/v1/knowledge/state')).status, 200);
  assert.equal((await request('/api/projects')).status, 404);
  assert(!(await readdir(home)).includes('projects'));
  process.stdout.write('Inference SDK smoke passed\n');
} finally {
  await gezel.close();
}
