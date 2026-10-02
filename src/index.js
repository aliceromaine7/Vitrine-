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

    if (
      u.protocol !== 'https:' ||
      !['chariow.ly', 'www.chariow.ly'].includes(u.hostname)
    ) {
      return null;
    }

    return u;
  } catch {
    return null;
  }
}

function slugCandidates(rawUrl) {
  try {
    const u = new URL(rawUrl);

    const parts = u.pathname
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);

    const out = [];

    for (const part of parts) {
      const p = part.trim();

      if (
        /^[a-z0-9][a-z0-9_-]{2,}$/i.test(p) &&
        ![
          'checkout',
          'products',
          'product',
          'store',
          'shop',
          'courses'
        ].includes(p.toLowerCase())
      ) {
        out.push(p);
      }
    }

    return [...new Set(out)];
  } catch {
    return [];
  }
}

async function fetchText(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; ChariowProductImporter/1.0)',
      'Accept':
        'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8'
    }
  });

  const text = await response.text();

  return {
    response,
    text,
    finalUrl: response.url || url
  };
}

/*
 * Essaie plusieurs structures possibles de réponse
 * de l'API Chariow.
 */
function extractProduct(body) {
  if (!body) return null;

  // { data: { ...produit } }
  if (
    body.data &&
    !Array.isArray(body.data) &&
    typeof body.data === 'object'
  ) {
    // Certains formats peuvent encapsuler encore le produit
    if (body.data.product) {
      return body.data.product;
    }

    return body.data;
  }

  // { data: [ ... ] }
  if (Array.isArray(body.data) && body.data.length > 0) {
    return body.data[0];
  }

  // { product: { ... } }
  if (body.product && typeof body.product === 'object') {
    return body.product;
  }

  // Produit directement à la racine
  if (body.name || body.slug || body.id) {
    return body;
  }

  return null;
}

async function getProductByIdOrSlug(identifier, key) {
  const url =
    `${API_BASE}/products/` +
    encodeURIComponent(identifier);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json'
    }
  });

  const text = await response.text();

  let body = {};

  try {
    body = JSON.parse(text);
  } catch {}

  const product = extractProduct(body);

  return {
    ok: response.ok,
    status: response.status,
    product,
    body
  };
}

async function searchProducts(term, key) {
  const url = new URL(`${API_BASE}/products`);

  url.searchParams.set('search', term);
  url.searchParams.set('per_page', '50');

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json'
    }
  });

  const text = await response.text();

  let body = {};

  try {
    body = JSON.parse(text);
  } catch {}

  let list = [];

  if (Array.isArray(body?.data)) {
    list = body.data;
  } else if (Array.isArray(body?.data?.data)) {
    list = body.data.data;
  } else if (Array.isArray(body?.products)) {
    list = body.products;
  }

  return {
    ok: response.ok,
    status: response.status,
    products: list,
    body
  };
}

function mapProduct(product) {
  const current =
    product?.pricing?.current_price ??
    product?.pricing?.currentPrice ??
    product?.price ??
    product?.pricing?.price ??
    null;

  let image =
    product?.pictures?.cover ??
    product?.pictures?.thumbnail ??
    product?.pictures?.main ??
    product?.image ??
    '';

  // Certains retours API peuvent contenir une image sous forme d'objet.
  if (typeof image === 'object' && image !== null) {
    image =
      image.url ??
      image.src ??
      image.original ??
      image.large ??
      image.thumbnail ??
      '';
  }

  let price = '';

  if (typeof current === 'object' && current !== null) {
    price =
      current.formatted ??
      (
        current.value != null
          ? `${current.value} ${current.currency || ''}`.trim()
          : ''
      );
  } else if (current != null) {
    price = String(current);
  }

  let description = product?.description ?? '';

  if (typeof description !== 'string') {
    description = '';
  }

  description = description
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    title:
      product?.name ??
      product?.title ??
      '',

    description,

    category:
      product?.category?.label ??
      product?.category?.name ??
      product?.category ??
      'RESSOURCE',

    price,

    image,

    slug:
      product?.slug ??
      '',

    id:
      product?.id ??
      ''
  };
}

async function handleImport(request, env) {
  const key = env.CHARIOW_API_KEY;

  if (!key) {
    return json(
      {
        ok: false,
        error:
          'CHARIOW_API_KEY est absent du Worker Cloudflare.'
      },
      500
    );
  }

  const raw =
    new URL(request.url).searchParams.get('url') || '';

  const affiliate = cleanAffiliateUrl(raw);

  if (!affiliate) {
    return json(
      {
        ok: false,
        error:
          'Colle un lien affilié Chariow commençant par https://chariow.ly/'
      },
      400
    );
  }

  try {
    // 1. Résolution du lien affilié
    const resolved = await fetchText(
      affiliate.toString()
    );

    const candidates = slugCandidates(
      resolved.finalUrl
    );

    // 2. On essaie directement chaque identifiant trouvé.
    for (const candidate of candidates) {
      const result =
        await getProductByIdOrSlug(candidate, key);

      if (result.product) {
        return json({
          ok: true,
          product: mapProduct(result.product),
          finalUrl: resolved.finalUrl,
          identifier: candidate
        });
      }
    }

    // 3. Fallback avec la recherche catalogue.
    for (const candidate of candidates) {
      const result =
        await searchProducts(candidate, key);

      if (result.products.length) {
        const product =
          result.products[0];

        return json({
          ok: true,
          product: mapProduct(product),
          finalUrl: resolved.finalUrl,
          identifier: candidate
        });
      }
    }

    // 4. Si ça échoue encore, on retourne les informations
    // nécessaires pour diagnostiquer précisément le problème.
    const diagnostic = {};

    if (candidates.length) {
      const test =
        await getProductByIdOrSlug(
          candidates[0],
          key
        );

      diagnostic.apiStatus = test.status;
      diagnostic.apiResponse = test.body;
    }

    return json(
      {
        ok: false,
        error:
          'Le produit n’a pas pu être identifié dans l’API Chariow.',
        finalUrl: resolved.finalUrl,
        candidates,
        diagnostic
      },
      422
    );

  } catch (error) {
    return json(
      {
        ok: false,
        error:
          `Import Chariow impossible : ${
            error?.message || 'erreur inconnue'
          }`
      },
      500
    );
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return json({}, 204);
    }

    if (
      url.pathname === '/api/chariow-import'
    ) {
      return handleImport(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
