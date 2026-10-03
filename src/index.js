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
        product: {
          title: pageProduct.title,
          description: pageProduct.description,
          category: pageProduct.category,
          price: pageProduct.price,
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
    const password = request.headers.get('x-admin-password') || '';

    if (!env.ADMIN_PASSWORD || !(await samePassword(password, env.ADMIN_PASSWORD))) {
      return json({ ok: false, error: 'Mot de passe incorrect.' }, 401);
    }

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/api/site') {
      return handleSite(request, env);
    }

    if (url.pathname === '/api/chariow-import') {
      return handleImport(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
