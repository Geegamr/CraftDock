// Chrome DevTools Protocol client for driving the running CraftDock window.
// Usage: node scripts/cdp-eval.mjs "<js expression evaluated in the page>"
//   env: CDP_PORT (default 9222), CDP_VERBOSE=1 to dump console + network detail
// Requires the app started with --remote-debugging-port=9222 and CRAFTDOCK_PERF=1.
const PORT = process.env.CDP_PORT || 9222;
const expr = process.argv.slice(2).join(' ');
if (!expr) { console.error('usage: node scripts/cdp-eval.mjs "<expression>"'); process.exit(2); }

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find(t => t.type === 'page' && /index\.html/.test(t.url)) || targets.find(t => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const events = { console: [], exceptions: [], requests: new Map(), failed: [] };
const send = (method, params) => new Promise((resolve, reject) => {
  const msgId = ++id;
  pending.set(msgId, { resolve, reject });
  ws.send(JSON.stringify({ id: msgId, method, params }));
});
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  const p = msg.params || {};
  switch (msg.method) {
    case 'Runtime.consoleAPICalled':
      if (p.type === 'error' || p.type === 'warning') {
        events.console.push({ type: p.type, text: (p.args || []).map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 300) });
      }
      break;
    case 'Runtime.exceptionThrown':
      events.exceptions.push(String(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').slice(0, 400));
      break;
    case 'Network.requestWillBeSent':
      events.requests.set(p.requestId, { url: p.request.url, method: p.request.method, t0: Date.now(), type: p.type });
      break;
    case 'Network.responseReceived': {
      const r = events.requests.get(p.requestId);
      if (r) { r.status = p.response.status; r.mime = p.response.mimeType; }
      break;
    }
    case 'Network.loadingFinished': {
      const r = events.requests.get(p.requestId);
      if (r) { r.ms = Date.now() - r.t0; r.done = true; }
      break;
    }
    case 'Network.loadingFailed': {
      const r = events.requests.get(p.requestId);
      if (r) { r.failed = p.errorText; r.ms = Date.now() - r.t0; }
      break;
    }
  }
});
await new Promise(r => ws.addEventListener('open', r, { once: true }));
await send('Runtime.enable');
await send('Network.enable');

const res = await send('Runtime.evaluate', {
  expression: `(async () => { ${expr} })()`,
  awaitPromise: true,
  returnByValue: true,
  userGesture: true,
});
ws.close();

const requests = [...events.requests.values()]
  .filter(r => !/\.(png|jpg|jpeg|webp|gif|svg|woff2?|ttf|ico)(\?|$)/i.test(r.url))
  .map(r => ({ url: r.url.slice(0, 110), method: r.method, status: r.status, ms: r.ms, failed: r.failed }))
  .sort((a, b) => (b.ms || 0) - (a.ms || 0));

if (res.exceptionDetails) {
  console.error('EXCEPTION:', JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails, null, 2));
}
console.log(JSON.stringify(res.result.value, null, 2));
const report = {
  consoleErrors: events.console.slice(-20),
  pageExceptions: events.exceptions.slice(-10),
  network: {
    total: requests.length,
    failed: requests.filter(r => r.failed || (r.status && r.status >= 400)).slice(0, 10),
    slowest: requests.slice(0, process.env.CDP_VERBOSE ? 25 : 6),
  },
};
console.error('--- runtime report ---');
console.error(JSON.stringify(report, null, 2));
