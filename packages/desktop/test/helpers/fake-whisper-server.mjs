// A stand-in for `gezel-whisper-server` that speaks just enough of its HTTP
// surface for the engine tests and the desktop e2e. Behaviour is chosen with
// FAKE_WHISPER_MODE; the transcript with FAKE_WHISPER_TEXT.
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import process from 'node:process';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const port = Number(option('--port'));
const model = option('--model');
const mode = process.env.FAKE_WHISPER_MODE ?? 'ok';
const readyDelayMs = Number(process.env.FAKE_WHISPER_READY_DELAY_MS ?? 0);
const startedAt = Date.now();
let requests = 0;

if (mode === 'crash-on-start') {
  process.stderr.write('ggml: failed to load model\n');
  process.exit(3);
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const ready = mode !== 'never-ready' && Date.now() - startedAt >= readyDelayMs;
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: ready ? 'ok' : 'loading model' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/inference') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests += 1;
      const body = Buffer.concat(chunks).toString('latin1');
      if (mode === 'exit-on-request') process.exit(1);
      const wav = body.includes('RIFF') && body.includes('WAVE');
      const prompt = /name="prompt"\r\n\r\n([^\r]*)/u.exec(body)?.[1] ?? '';
      const text =
        mode === 'blank'
          ? ' [BLANK_AUDIO] '
          : mode === 'echo-prompt'
            ? `prompt was: ${prompt}`
            : (process.env.FAKE_WHISPER_TEXT ?? 'Hello from dictation.');
      res.writeHead(wav ? 200 : 400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          wav
            ? { text: ` ${text} `, language: 'en', model, prompt, requests }
            : { error: 'expected a WAV file' },
        ),
      );
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`listening ${port}\n`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
