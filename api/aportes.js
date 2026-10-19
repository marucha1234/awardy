// Awardy: aportes de la comunidad (sugerencias de festivales) guardados en Vercel Blob.
// Público: POST crea un aporte (queda pendiente). GET devuelve solo los aprobados.
// Admin (header x-admin-key): GET ?all=1 devuelve todo; PATCH {id,status} aprueba o rechaza.
const ADMIN_KEY = (process.env.ADMIN_KEY || 'awards').toLowerCase();
const STATUSES = ['pendiente', 'aprobado', 'rechazado'];
const clean = (x, n) => String(x || '').replace(/[<>"'`\\]/g, '').trim().slice(0, n);

async function blob() { return await import('@vercel/blob'); }
let ACCESS = process.env.BLOB_ACCESS || null; // 'private' o 'public', se detecta solo
async function putJSON(path, obj, opts) {
  const { put } = await blob();
  const tries = ACCESS ? [ACCESS] : ['private', 'public'];
  let err;
  for (const a of tries) {
    try { const r = await put(path, JSON.stringify(obj), { access: a, contentType: 'application/json', ...opts }); ACCESS = a; return r; } catch (e) { err = e; }
  }
  throw err;
}
async function readJSON(b) {
  const { get } = await blob();
  const tries = ACCESS ? [ACCESS] : ['private', 'public'];
  for (const a of tries) {
    try { const r = await get(b.url, { access: a }); if (r && r.statusCode === 200) { ACCESS = a; return await new Response(r.stream).json(); } } catch (e) {}
  }
  return null;
}

async function listAll(prefix) {
  const { list } = await blob();
  let cursor, out = [];
  do { const r = await list({ prefix, cursor, limit: 1000 }); out = out.concat(r.blobs); cursor = r.hasMore ? r.cursor : null; } while (cursor);
  return out;
}

async function readAll() {
  const [items, states] = await Promise.all([listAll('aportes/'), listAll('estado/')]);
  // estado/<id>/<ts>-<status>.json : el más reciente manda
  const st = {};
  for (const b of states) {
    const m = b.pathname.match(/^estado\/([a-z0-9]+)\/(\d+)-(pendiente|aprobado|rechazado)\.json$/);
    if (m && (!st[m[1]] || +m[2] > st[m[1]].ts)) st[m[1]] = { ts: +m[2], status: m[3] };
  }
  const data = await Promise.all(items.map(async b => {
    try { return await readJSON(b); } catch (e) { return null; }
  }));
  return data.filter(x => x && x.id).map(x => ({ ...x, status: (st[x.id] || {}).status || 'pendiente' }));
}

function isAdmin(req) { return String(req.headers['x-admin-key'] || '').trim().toLowerCase() === ADMIN_KEY; }

async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: 'storage_not_configured' });
    if (req.method === 'GET') {
      if (req.query && req.query.login) return res.status(isAdmin(req) ? 200 : 401).json({ ok: isAdmin(req) });
      const all = await readAll();
      if (req.query && req.query.all) {
        if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
        return res.status(200).json({ items: all });
      }
      return res.status(200).json({ items: all.filter(x => x.status === 'aprobado').map(({ nota, ...x }) => x) });
    }
    if (req.method === 'POST') {
      const b = await body(req);
      if (b.website) return res.status(200).json({ ok: true }); // honeypot anti-spam
      const it = { n: clean(b.n, 120), c: clean(b.c, 12), t: clean(b.t, 60), m: Math.max(0, Math.min(11, parseInt(b.m, 10) || 0)), u: clean(b.u, 300), nota: clean(b.nota, 400) };
      if (!it.n || !it.c || !it.t) return res.status(400).json({ error: 'missing_fields' });
      if (it.u && !/^https?:\/\//i.test(it.u)) return res.status(400).json({ error: 'bad_url' });
      const existing = await listAll('aportes/');
      if (existing.length >= 2000) return res.status(429).json({ error: 'full' });
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      await putJSON('aportes/' + id + '.json', { ...it, id, ts: Date.now() }, { addRandomSuffix: true });
      return res.status(200).json({ ok: true, id });
    }
    if (req.method === 'PATCH') {
      if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
      const b = await body(req);
      const id = String(b.id || '').replace(/[^a-z0-9]/g, ''), status = String(b.status || '');
      if (!id || !STATUSES.includes(status)) return res.status(400).json({ error: 'bad_request' });
      await putJSON('estado/' + id + '/' + Date.now() + '-' + status + '.json', {}, { addRandomSuffix: false });
      return res.status(200).json({ ok: true });
    }
    res.setHeader('Allow', 'GET, POST, PATCH');
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
};
