// Awardy: "Ask Awardy". Responde solo con los datos del sitio (awardy-context.txt) usando la API de Anthropic.
// Requiere la variable de entorno ANTHROPIC_API_KEY en Vercel. Opcional: AWARDY_MODEL.
const MODEL = process.env.AWARDY_MODEL || 'claude-haiku-5-5';
let CTX = null, CTX_AT = 0;
const HITS = new Map(); // límite simple por IP (por instancia)

async function context(req) {
  if (CTX && Date.now() - CTX_AT < 10 * 60 * 1000) return CTX;
  const host = String(req.headers.host || '');
  const proto = req.headers['x-forwarded-proto'] || (/^(localhost|127\.)/.test(host) ? 'http' : 'https');
  const r = await fetch(`${proto}://${req.headers.host}/awardy-context.txt`, { cache: 'no-store' });
  if (!r.ok) throw new Error('context');
  CTX = await r.text(); CTX_AT = Date.now(); return CTX;
}
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 30;
  const arr = (HITS.get(ip) || []).filter(t => now - t < win);
  arr.push(now); HITS.set(ip, arr);
  return arr.length > max;
}
async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const key = process.env.ANTHROPIC_API_KEY;
  if (req.method === 'GET') return res.status(key ? 200 : 503).json({ ok: !!key });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!key) return res.status(503).json({ error: 'not_configured' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  if (limited(ip)) return res.status(429).json({ error: 'rate_limited' });

  const b = await body(req);
  const lang = b.lang === 'en' ? 'en' : 'es';
  const msgs = (Array.isArray(b.messages) ? b.messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-8).map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: 'bad_request' });

  let ctx;
  try { ctx = await context(req); } catch (e) { return res.status(500).json({ error: 'context_unavailable' }); }
  const today = new Date().toISOString().slice(0, 10);
  const system = ctx.replace('{{TODAY}}', today)
    .replace('{{LANG}}', lang === 'en' ? 'English' : 'Spanish (Rioplatense, voseo, e.g. "podés", "mirá")');

  let up;
  try {
    up = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1024, stream: true,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: msgs
      })
    });
  } catch (e) { return res.status(502).json({ error: 'upstream' }); }
  if (!up.ok || !up.body) {
    const code = up.status === 429 ? 'rate_limited' : 'upstream';
    return res.status(up.status === 429 ? 429 : 502).json({ error: code });
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  const reader = up.body.getReader(), dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const ev = JSON.parse(line.slice(5));
          if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') res.write(ev.delta.text);
        } catch (e) {}
      }
    }
  } catch (e) {}
  res.end();
};
