const API_BASE = 'https://api.chariow.com/v1';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
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
    if (u.protocol !== 'https:' || !['chariow.ly', 'www.chariow.ly'].includes(u.hostname)) {
      return null;
    }
    return u;
  } catch {
    return null;
  }
}

async function fetchPage(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ChariowProductImporter/1.0)',
      'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
    }
  });
  const html = await response.text();
  return { response, html, finalUrl: response.url || url };
}

function decodeHtml(value = '') {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

function getMeta(html, attribute, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+${attribute}=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+${attribute}=["']${escaped}["']`, 'i')
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return '';
}

function getTitle(html) {
  const ogTitle = getMeta(html, 'property', 'og:title');
  if (ogTitle) return ogTitle;
  const twitterTitle = getMeta(html, 'name', 'twitter:title');
  if (twitterTitle) return twitterTitle;
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? decodeHtml(match[1].replace(/\s+/g, ' ')) : '';
}

function getDescription(html) {
  const description =
    getMeta(html, 'property', 'og:description') ||
    getMeta(html, 'name', 'description') ||
    getMeta(html, 'name', 'twitter:description');
  return description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getImage(html) {
  return (
    getMeta(html, 'property', 'og:image') ||
    getMeta(html, 'name', 'twitter:image') ||
    getMeta(html, 'property', 'og:image:url') ||
    ''
  );
}

function getPrice(html) {
  const price = getMeta(html, 'property', 'product:price:amount');
  const currency = getMeta(html, 'property', 'product:price:currency');
  if (price) {
    return currency ? `${price} ${currency}` : price;
  }

  // JSON-LD Product / Offer
  const jsonLdMatches = [
    ...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  ];
  for (const match of jsonLdMatches) {
    try {
      const data = JSON.parse(match[1]);
      const objects = Array.isArray(data) ? data : [data];
      for (const item of objects) {
        const offers = item?.offers;
        if (!offers) continue;
        const offer = Array.isArray(offers) ? offers[0] : offers;
        if (offer?.price != null) {
          return offer.currency ? `${offer.price} ${offer.currency}` : String(offer.price);
        }
      }
    } catch {}
  }
  return '';
}

function getCategory(html) {
  return (
    getMeta(html, 'property', 'product:category') ||
    getMeta(html, 'name', 'category') ||
    'RESSOURCE'
  );
}

function extractJsonLdProduct(html) {
  const scripts = [
    ...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  ];
  for (const match of scripts) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item?.['@type'] === 'Product' || item?.['@type']?.includes?.('Product')) {
          return item;
        }
      }
    } catch {}
  }
  return null;
}

function extractProductFromPage(html, finalUrl) {
  const jsonLd = extractJsonLdProduct(html);
  const title = getTitle(html) || jsonLd?.name || '';
  const description = getDescription(html) || jsonLd?.description || '';

  let image = getImage(html);
  if (!image && jsonLd?.image) {
    image = Array.isArray(jsonLd.image) ? jsonLd.image[0] : jsonLd.image;
  }

  let price = getPrice(html);
  if (!price && jsonLd?.offers) {
    const offer = Array.isArray(jsonLd.offers) ? jsonLd.offers[0] : jsonLd.offers;
    if (offer?.price != null) {
      price = offer.currency ? `${offer.price} ${offer.currency}` : String(offer.price);
    }
  }

  const category = getCategory(html) || jsonLd?.category || 'RESSOURCE';

  if (!title && !description && !image) {
    return null;
  }

  return {
    title: String(title).trim(),
    description: String(description).trim(),
    category: String(category).trim(),
    price: String(price).trim(),
    image: String(image).trim(),
    url: finalUrl
  };
}

// =====================================================
// PRIX : ancien prix barré + prix promotionnel
// =====================================================

function stripTags(value) {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function toNum(value) {
  const m = String(value || '').match(/\d[\d\s\u00a0.,]*/);
  if (!m) return NaN;
  let x = m[0].replace(/[\s\u00a0]/g, '');
  const lc = x.lastIndexOf(',');
  const ld = x.lastIndexOf('.');

  if (lc > -1 && ld > -1) {
    x = lc > ld ? x.replace(/\./g, '').replace(',', '.') : x.replace(/,/g, '');
  } else if (lc > -1) {
    x = /,\d{1,2}$/.test(x) ? x.replace(',', '.') : x.replace(/,/g, '');
  } else if (ld > -1 && /\.\d{3}$/.test(x)) {
    x = x.replace(/\./g, '');
  }

  return parseFloat(x);
}

// On ignore la section « Autres produits » pour ne pas prendre le prix d'un autre produit
function cutRelated(html) {
  const i = html.search(/Autres produits|Produits similaires|You may also like|Other products/i);
  return i > 0 ? html.slice(0, i) : html;
}

function findOldPrice(html, current) {
  const region = cutRelated(html);
  const cur = toNum(current);
  const currency = String(current || '').replace(/^[\d\s\u00a0.,]+/, '').trim();

  const accept = (text) => {
    const n = toNum(text);
    return text.length > 0 && text.length <= 40 && !Number.isNaN(n) && (Number.isNaN(cur) || n > cur);
  };

  const tagPatterns = [
    /<(?:del|s|strike)\b[^>]*>([\s\S]*?)<\/(?:del|s|strike)>/gi,
    /<[a-z0-9]+\b[^>]*class=["'][^"']*(?:line-through|old-price|original-price|compare-price|price-old)[^"']*["'][^>]*>([\s\S]*?)<\/[a-z0-9]+>/gi
  ];

  for (const re of tagPatterns) {
    for (const m of region.matchAll(re)) {
      const text = decodeHtml(stripTags(m[1]));
      if (/\d/.test(text) && accept(text)) return text;
    }
  }

  const keyRe =
    /"(?:original_price|compare_at_price|compare_price|old_price|regular_price|price_before_discount|strikethrough_price|list_price)"\s*:\s*(?:"([^"]+)"|([\d.]+))/gi;

  for (const m of region.matchAll(keyRe)) {
    let text = (m[1] || m[2] || '').trim();
    if (/^[\d\s.,]+$/.test(text) && currency) text = `${text} ${currency}`;
    if (/\d/.test(text) && accept(text)) return text;
  }

  return '';
}

// Note, nombre d'apprenants, places restantes, offre limitée (texte de la page)
function findStats(html) {
  const clean = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');
  const text = decodeHtml(stripTags(cutRelated(clean))).replace(/\u00a0/g, ' ');

  const rating = text.match(/(\d{1,3})\s?%\s*\((\d+)\s*Avis?\)/i);
  const learners = text.match(/(\d[\d\s.,]*\+?)\s*Apprenants?/i);
  const remaining = text.match(/Restants?\s*:?\s*(\d+)/i);

  return {
    rating: rating ? `${rating[1]}%` : '',
    reviews: rating ? rating[2] : '',
    learners: learners ? learners[1].replace(/\s+/g, '') : '',
    remaining: remaining ? remaining[1] : '',
    limited: /Offre\s+à\s+durée\s+limitée/i.test(text)
  };
}

function priceDebug(html, current) {
  const region = cutRelated(html);
  const found = new Set();

  for (const m of region.matchAll(/\d[\d\s\u00a0.,]*\s?(?:FCFA|F CFA|XOF|XAF|€|EUR|\$US|\$|USD)/gi)) {
    found.add(m[0].replace(/\s+/g, ' ').trim());
    if (found.size >= 12) break;
  }

  return {
    current,
    oldPrice: findOldPrice(html, current),
    candidates: [...found],
    hasStrikeTag: /<(?:del|s|strike)\b/i.test(region),
    hasLineThroughClass: /line-through/i.test(region)
  };
}

async function getProductFromApi(identifier, key) {
  try {
    const response = await fetch(`${API_BASE}/products/${encodeURIComponent(identifier)}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body?.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
      return body.data;
    }
  } catch {}
  return null;
}

function mapApiProduct(product) {
  const current =
    product?.pricing?.current_price ?? product?.price ?? product?.pricing?.price ?? null;

  let image = product?.pictures?.cover ?? product?.pictures?.thumbnail ?? product?.image ?? '';
  if (typeof image === 'object' && image !== null) {
    image = image.url ?? image.src ?? image.original ?? '';
  }

  let price = '';
  if (typeof current === 'object' && current !== null) {
    price =
      current.formatted ??
      (current.value != null ? `${current.value} ${current.currency || ''}`.trim() : '');
  } else if (current != null) {
    price = String(current);
  }

  let description = typeof product?.description === 'string' ? product.description : '';
  description = description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  return {
    title: product?.name || product?.title || '',
    description,
    category: product?.category?.label || product?.category?.name || 'RESSOURCE',
    price,
    image,
    slug: product?.slug || '',
    id: product?.id || ''
  };
}

async function handleImport(request, env) {
  const raw = new URL(request.url).searchParams.get('url') || '';
  const wantDebug = new URL(request.url).searchParams.get('debug') === '1';
  const affiliate = cleanAffiliateUrl(raw);

  if (!affiliate) {
    return json(
      { ok: false, error: 'Colle un lien affilié Chariow commençant par https://chariow.ly/' },
      400
    );
  }

  try {
    // 1. OUVERTURE DU LIEN AFFILIÉ
    const page = await fetchPage(affiliate.toString());

    if (!page.response.ok) {
      return json(
        {
          ok: false,
          error: `Chariow a répondu avec le statut ${page.response.status}.`,
          finalUrl: page.finalUrl
        },
        422
      );
    }

    // 2. EXTRACTION DIRECTE DE LA PAGE PRODUIT
    const pageProduct = extractProductFromPage(page.html, page.finalUrl);

    if (pageProduct) {
      return json({
        ok: true,
        debug: wantDebug ? priceDebug(page.html, pageProduct.price) : undefined,
        product: {
          title: pageProduct.title,
          description: pageProduct.description,
          category: pageProduct.category,
          price: pageProduct.price,
          oldPrice: findOldPrice(page.html, pageProduct.price),
          ...findStats(page.html),
          image: pageProduct.image,
          // IMPORTANT : on conserve TON lien affilié
          link: affiliate.toString(),
          finalUrl: pageProduct.url
        }
      });
    }

    // 3. SECOURS API CHARIOW
    const key = env.CHARIOW_API_KEY;

    if (key) {
      const match = page.finalUrl.match(/\/(prd_[a-zA-Z0-9_-]+)/);
      const identifier = match?.[1] || '';

      if (identifier) {
        const apiProduct = await getProductFromApi(identifier, key);
        if (apiProduct) {
          return json({
            ok: true,
            product: {
              ...mapApiProduct(apiProduct),
              // Toujours garder le lien affilié
              link: affiliate.toString()
            }
          });
        }
      }
    }

    // 4. DIAGNOSTIC
    return json(
      {
        ok: false,
        error:
          'La page Chariow a été ouverte, mais aucune information produit exploitable n’a été trouvée.',
        finalUrl: page.finalUrl,
        diagnostic: {
          htmlLength: page.html.length,
          hasTitle: Boolean(getTitle(page.html)),
          hasDescription: Boolean(getDescription(page.html)),
          hasImage: Boolean(getImage(page.html)),
          hasPrice: Boolean(getPrice(page.html)),
          hasJsonLd: Boolean(extractJsonLdProduct(page.html))
        }
      },
      422
    );
  } catch (error) {
    return json(
      { ok: false, error: `Import Chariow impossible : ${error?.message || 'erreur inconnue'}` },
      500
    );
  }
}

// =====================================================
// CONTENU DU SITE PARTAGÉ (produits, bannière, couleurs)
// Stocké dans Cloudflare KV (binding "SITE")
// =====================================================

async function samePassword(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b))
  ]);
  const p = new Uint8Array(x);
  const q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}

async function handleSite(request, env) {
  if (!env.SITE) {
    return json({ ok: false, error: 'Stockage KV non configuré.' }, 500);
  }

  if (request.method === 'GET') {
    const value = await env.SITE.get('site');
    return new Response(value || '{}', {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      }
    });
  }

  if (request.method === 'POST') {
    const denied = await guard(request, env);
    if (denied) return denied;

    const text = await request.text();

    if (text.length > 20000000) {
      return json({ ok: false, error: 'Données trop volumineuses.' }, 413);
    }

    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    } catch {
      return json({ ok: false, error: 'Données invalides.' }, 400);
    }

    await env.SITE.put('site', text);
    return json({ ok: true });
  }

  return json({ ok: false, error: 'Méthode non autorisée.' }, 405);
}

// =====================================================
// NEWSLETTER : inscription publique + liste protégée
// =====================================================

// Vérifie le mot de passe admin et limite les essais ratés (8 par IP / 15 min).
// Retourne null si tout est bon, sinon la réponse d'erreur à renvoyer.
async function guard(request, env) {
  if (!env.SITE || !env.ADMIN_PASSWORD) {
    return json({ ok: false, error: 'Configuration manquante.' }, 500);
  }

  const key = 'rl:' + (request.headers.get('cf-connecting-ip') || 'unknown');
  const attempts = parseInt((await env.SITE.get(key)) || '0', 10);

  if (attempts >= 8) {
    return json({ ok: false, error: 'Trop d’essais. Réessaie dans 15 minutes.' }, 429);
  }

  const password = request.headers.get('x-admin-password') || '';

  if (!(await samePassword(password, env.ADMIN_PASSWORD))) {
    await env.SITE.put(key, String(attempts + 1), { expirationTtl: 900 });
    return json({ ok: false, error: 'Mot de passe incorrect.' }, 401);
  }

  if (attempts) await env.SITE.delete(key);
  return null;
}

function slugify(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function attr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

async function handleSubscribe(request, env) {
  if (!env.SITE) return json({ ok: false, error: 'Stockage KV non configuré.' }, 500);
  if (request.method !== 'POST') return json({ ok: false, error: 'Méthode non autorisée.' }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Données invalides.' }, 400);
  }

  // Champ piège pour les robots
  if (body?.hp) return json({ ok: true });

  const email = String(body?.email || '').trim().toLowerCase();

  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return json({ ok: false, error: 'Adresse e-mail invalide.' }, 400);
  }

  await env.SITE.put('sub:' + email, JSON.stringify({ date: new Date().toISOString() }));
  return json({ ok: true });
}

async function handleSubscribers(request, env) {
  if (!env.SITE) return json({ ok: false, error: 'Stockage KV non configuré.' }, 500);
  const denied = await guard(request, env);
  if (denied) return denied;

  const emails = [];
  let cursor;

  do {
    const page = await env.SITE.list({ prefix: 'sub:', cursor });
    for (const key of page.keys) emails.push(key.name.slice(4));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return json({ ok: true, emails });
}

// =====================================================
// IMAGES GÉNÉRÉES PAR IA (Cloudflare Workers AI)
// =====================================================

async function handleGenerateImage(request, env) {
  if (!env.AI || !env.SITE) return json({ ok: false, error: 'IA non configurée.' }, 500);
  if (request.method !== 'POST') return json({ ok: false, error: 'Méthode non autorisée.' }, 405);
  const denied = await guard(request, env);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Données invalides.' }, 400);
  }

  const clean = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const title = clean(body?.title, 120);
  if (!title) return json({ ok: false, error: 'Titre manquant.' }, 400);

  const topic = clean(body?.category, 40);
  const desc = clean(body?.description, 300);

  const styles = {
    '3d': 'Premium 3D render, glossy materials, soft glowing gold and teal lighting, dark elegant background, depth of field, high detail',
    minimal: 'Minimalist flat vector illustration, bold geometric shapes, limited elegant color palette, clean composition, soft gradients, generous negative space',
    photo: 'Professional studio product photography, realistic, soft cinematic lighting, shallow depth of field, clean dark backdrop, ultra detailed',
    neon: 'Futuristic neon glow, sleek gradient lighting, dark background, vibrant magenta and cyan accents, high contrast'
  };
  const style = styles[body?.style] || styles['3d'];

  // Étape 1 : une IA de texte imagine une scène visuelle précise (en anglais)
  let scene = `${title}. ${desc}`;
  try {
    const llm = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content:
            'You write prompts for an image generator. Given an online course (title, category, description, possibly in French), ' +
            'describe in ONE sentence of at most 35 English words a single concrete visual scene or object metaphor that represents the topic. ' +
            'No text, no letters, no logos, no human faces. Output only the sentence.'
        },
        { role: 'user', content: `Title: ${title}\nCategory: ${topic}\nDescription: ${desc}` }
      ],
      max_tokens: 90
    });
    const text = String(llm?.response || '').replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim().slice(0, 300);
    if (text.length > 15) scene = text;
  } catch {}

  const prompt = `${scene} ${style}, centered main subject, no text, no letters, no watermark.`;

  try {
    const out = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt, steps: 8 });
    if (!out?.image) throw new Error('empty');

    const bytes = Uint8Array.from(atob(out.image), (c) => c.charCodeAt(0));
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

    await env.SITE.put('img:' + id, bytes);
    return json({ ok: true, url: '/api/img/' + id });
  } catch {
    return json({ ok: false, error: 'la génération a échoué, réessaie' }, 502);
  }
}

async function handleImage(env, id) {
  if (!env.SITE || !/^[a-f0-9]{16}$/.test(id)) return new Response('Not found', { status: 404 });

  const data = await env.SITE.get('img:' + id, 'arrayBuffer');
  if (!data) return new Response('Not found', { status: 404 });

  return new Response(data, {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=31536000, immutable'
    }
  });
}

// =====================================================
// STATISTIQUES (visites + clics « Acheter »)
// =====================================================

async function handleTrack(request, env) {
  if (!env.SITE || request.method !== 'POST') return json({ ok: false }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false }, 400);
  }

  if (body?.type === 'visit') {
    const key = 'vis:' + new Date().toISOString().slice(0, 10);
    const n = parseInt((await env.SITE.get(key)) || '0', 10);
    await env.SITE.put(key, String(n + 1), { expirationTtl: 7776000 });
    return json({ ok: true });
  }

  if (body?.type === 'click') {
    const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const slug = slugify(title);
    if (!slug) return json({ ok: false }, 400);

    const key = 'clk:' + slug;
    let current = { t: title, n: 0 };
    try {
      current = JSON.parse((await env.SITE.get(key)) || 'null') || current;
    } catch {}

    current.t = title;
    current.n = (current.n || 0) + 1;
    await env.SITE.put(key, JSON.stringify(current));
    return json({ ok: true });
  }

  return json({ ok: false }, 400);
}

async function handleStats(request, env) {
  const denied = await guard(request, env);
  if (denied) return denied;

  const list = await env.SITE.list({ prefix: 'clk:', limit: 35 });
  const values = await Promise.all(list.keys.map((k) => env.SITE.get(k.name)));
  const clicks = [];

  for (const v of values) {
    try {
      const o = JSON.parse(v);
      if (o?.t) clicks.push({ t: o.t, n: o.n || 0 });
    } catch {}
  }
  clicks.sort((a, b) => b.n - a.n);

  const days = [];
  for (let i = 6; i >= 0; i--) {
    days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  }
  const counts = await Promise.all(days.map((d) => env.SITE.get('vis:' + d)));
  const visits = days.map((d, i) => ({ d, n: parseInt(counts[i] || '0', 10) }));

  return json({ ok: true, clicks, visits });
}

async function handleSubscriberDelete(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Méthode non autorisée.' }, 405);

  const denied = await guard(request, env);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Données invalides.' }, 400);
  }

  const email = String(body?.email || '').trim().toLowerCase();
  if (!email || email.length > 254) return json({ ok: false, error: 'Adresse invalide.' }, 400);

  await env.SITE.delete('sub:' + email);
  return json({ ok: true });
}

// =====================================================
// PAGE PRODUIT PARTAGEABLE  /p/nom-du-produit
// (aperçu correct sur WhatsApp, TikTok, Facebook…)
// =====================================================

async function handleProduct(request, env, url) {
  const home = await env.ASSETS.fetch(new Request(new URL('/', url)));

  try {
    const slug = decodeURIComponent(url.pathname.slice(3));
    const raw = env.SITE ? await env.SITE.get('site') : null;
    const products = raw ? JSON.parse(raw).products || [] : [];
    const product = products.find((p) => slugify(p.title) === slug);

    if (!product) return home;

    const title = `${product.title} | Digital Select`;
    let desc = String(product.description || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (product.price) desc = `${product.price} — ${desc}`.trim();

    const img = String(product.image || '');
    const image = img.startsWith('/') ? url.origin + img : img.startsWith('http') ? img : '';

    const tags = [
      ['og:type', 'website'],
      ['og:title', title],
      ['og:description', desc],
      ['og:url', url.href]
    ];
    if (image) tags.push(['og:image', image]);

    const html =
      tags.map(([k, v]) => `<meta property="${k}" content="${attr(v)}">`).join('') +
      `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">` +
      `<meta name="description" content="${attr(desc)}">`;

    return new HTMLRewriter()
      .on('head', { element(e) { e.append(html, { html: true }); } })
      .on('title', { element(e) { e.setInnerContent(title); } })
      .transform(home);
  } catch {
    return home;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/api/site') {
      return handleSite(request, env);
    }

    if (url.pathname.startsWith('/p/')) {
      return handleProduct(request, env, url);
    }

    if (url.pathname === '/api/track') {
      return handleTrack(request, env);
    }

    if (url.pathname === '/api/stats') {
      return handleStats(request, env);
    }

    if (url.pathname === '/api/subscribers/delete') {
      return handleSubscriberDelete(request, env);
    }

    if (url.pathname === '/api/generate-image') {
      return handleGenerateImage(request, env);
    }

    if (url.pathname.startsWith('/api/img/')) {
      return handleImage(env, url.pathname.slice('/api/img/'.length));
    }

    if (url.pathname === '/api/subscribe') {
      return handleSubscribe(request, env);
    }

    if (url.pathname === '/api/subscribers') {
      return handleSubscribers(request, env);
    }

    if (url.pathname === '/api/chariow-import') {
      return handleImport(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
