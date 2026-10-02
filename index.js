const API_BASE = 'https://api.chariow.com/v1';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-allow-headers': 'Content-Type,Accept'
    }
  });
}

function cleanAffiliateUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !['chariow.ly', 'www.chariow.ly'].includes(u.hostname)) return null;
    return u;
  } catch { return null; }
}

function slugCandidates(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const out = [];
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i].trim();
      if (/^[a-z0-9][a-z0-9_-]{2,}$/i.test(p) && !['checkout','products','product','store','shop','courses'].includes(p.toLowerCase())) out.push(p);
    }
    return [...new Set(out)];
  } catch { return []; }
}

function extractFromHtml(html, baseUrl) {
  const values = [];
  const patterns = [
    /<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) {
      try { values.push(new URL(m[1], baseUrl).toString()); } catch {}
    }
  }
  return values;
}

async function fetchText(url) {
  const r = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ChariowProductImporter/1.0)',
      'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
    }
  });
  const text = await r.text();
  return { r, text, finalUrl: r.url || url };
}

async function getProductBySlug(slug, key) {
  const r = await fetch(`${API_BASE}/products/${encodeURIComponent(slug)}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
  });
  const body = await r.json().catch(() => ({}));
  if (r.ok && body?.data && !Array.isArray(body.data)) return body.data;
  return null;
}

async function searchProducts(term, key) {
  const u = new URL(`${API_BASE}/products`);
  u.searchParams.set('search', term);
  u.searchParams.set('per_page', '20');
  const r = await fetch(u, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
  });
  const body = await r.json().catch(() => ({}));
  const list = body?.data?.data || (Array.isArray(body?.data) ? body.data : []);
  return Array.isArray(list) ? list : [];
}

function mapProduct(p) {
  const current = p?.pricing?.current_price || p?.price || p?.pricing?.price;
  const image = p?.pictures?.cover || p?.pictures?.thumbnail || p?.image || '';
  return {
    title: p?.name || '',
    description: typeof p?.description === 'string' ? p.description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '',
    category: p?.category?.label || p?.category?.name || 'RESSOURCE',
    price: current?.formatted || (current?.value != null ? `${current.value} ${current.currency || ''}`.trim() : ''),
    image,
    slug: p?.slug || '',
    id: p?.id || ''
  };
}

async function handleImport(request, env) {
  const key = env.CHARIOW_API_KEY;
  if (!key) return json({ ok: false, error: 'CHARIOW_API_KEY est absent du Worker Cloudflare.' }, 500);

  const raw = new URL(request.url).searchParams.get('url') || '';
  const affiliate = cleanAffiliateUrl(raw);
  if (!affiliate) return json({ ok: false, error: 'Colle un lien affilié Chariow commençant par https://chariow.ly/' }, 400);

  try {
    // 1) Resolve the affiliate URL server-side. The browser never contacts Chariow.
    const resolved = await fetchText(affiliate.toString());
    const finalUrls = [resolved.finalUrl, ...extractFromHtml(resolved.text, resolved.finalUrl)];
    let candidates = [];
    for (const u of finalUrls) candidates.push(...slugCandidates(u));
    candidates = [...new Set(candidates)];

    // 2) Try the product endpoint with every slug candidate.
    for (const slug of candidates) {
      const product = await getProductBySlug(slug, key);
      if (product) return json({ ok: true, product: mapProduct(product), finalUrl: resolved.finalUrl });
    }

    // 3) Fallback: search Chariow's product catalogue by the last URL segment.
    const last = candidates[0];
    if (last) {
      const matches = await searchProducts(last, key);
      if (matches[0]) return json({ ok: true, product: mapProduct(matches[0]), finalUrl: resolved.finalUrl });
    }

    return json({
      ok: false,
      error: resolved.r.ok
        ? 'Le lien a été ouvert côté serveur, mais le produit n’a pas pu être identifié dans l’API Chariow. Vérifie la clé API et que le produit est publié.'
        : `Chariow a répondu avec le statut ${resolved.r.status}.`,
      finalUrl: resolved.finalUrl,
      candidates
    }, 422);
  } catch (e) {
    return json({ ok: false, error: `Import Chariow impossible côté serveur : ${e?.message || 'erreur inconnue'}` }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return json({}, 204);
    if (url.pathname === '/api/chariow-import') return handleImport(request, env);
    return env.ASSETS.fetch(request);
  }
};
