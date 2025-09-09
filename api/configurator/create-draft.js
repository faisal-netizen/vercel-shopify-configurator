// /api/configurator/create-draft.js
// Vercel serverless function (Edge is fine too, but use Node runtime for simplicity)

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    // ----- ENV -----
    const SHOP = process.env.SHOP; // e.g. your-shop.myshopify.com
    const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN; // Admin API access token (from custom app)
    if (!SHOP || !ADMIN_TOKEN) return res.status(500).json({ error: 'missing_env' });

    // (Optional but recommended) Verify App Proxy HMAC
    // See section 6 to enable; keeping disabled by default for fast setup.
    // const ok = verifyProxyHmac(req, process.env.SHOPIFY_APP_SECRET);
    // if (!ok) return res.status(401).json({ error: 'bad_hmac' });

    // ----- Parse body -----
    const { productHandle, productTitle, selection } = req.body || {};
    if (!productHandle || !selection) return res.status(400).json({ error: 'missing_payload' });

    // ----- GraphQL helpers -----
    async function shopifyGQL(query, variables = {}) {
      const r = await fetch(`https://${SHOP}/admin/api/2024-07/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': ADMIN_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables })
      });
      const j = await r.json();
      if (!r.ok || j.errors) throw new Error(JSON.stringify(j.errors || j));
      return j.data;
    }

    const PRODUCT_PRICEBOOK_QUERY = `
      query($handle: String!) {
        productByHandle(handle: $handle) {
          title
          metafield(namespace:"pricing", key:"pricebook") { value }
        }
      }`;

    const DRAFT_ORDER_CREATE = `
      mutation($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { invoiceUrl }
          userErrors { field message }
        }
      }`;

    // ----- Load pricebook from product metafield -----
    const prod = await shopifyGQL(PRODUCT_PRICEBOOK_QUERY, { handle: productHandle });
    const pbRaw = prod?.productByHandle?.metafield?.value;
    if (!pbRaw) return res.status(404).json({ error: `no_pricebook_for_${productHandle}` });
    const pb = JSON.parse(pbRaw);

    // ----- Validate base selection -----
    if (!selection.orientation || !selection.size) {
      return res.status(422).json({ error: 'missing_orientation_or_size' });
    }

    // ----- Compute price (fully dynamic over adds) -----
    const unitPrice = computePrice(pb, selection);
    if (!(unitPrice > 0)) return res.status(422).json({ error: 'invalid_price_computation' });

    // ----- Build SKU -----
    const sku = buildSku(pb, selection);

    // ----- Draft order input -----
    const title = `${productTitle || prod?.productByHandle?.title || 'Configured Item'} — ${selection.orientation} ${selection.size}`;
    const input = {
      lineItems: [{
        title,
        quantity: 1,
        originalUnitPrice: unitPrice.toFixed(2),
        sku,
        requiresShipping: true,
        customAttributes: [
          { key: 'Orientation', value: selection.orientation },
          { key: 'Size', value: selection.size },
          ...Object.keys(pb.adds || {}).map(k => ({ key: k, value: String(selection[k]) }))
        ]
      }],
      tags: ['custom-pricing', productHandle],
      note: `Configured via storefront for ${productHandle}`
      // You can add: email, shippingAddress, customerId, etc.
    };

    // ----- Create draft order -----
    const result = await shopifyGQL(DRAFT_ORDER_CREATE, { input });
    const node = result.draftOrderCreate;
    if (node.userErrors?.length) return res.status(400).json({ error: 'user_error', details: node.userErrors });

    return res.status(200).json({ invoice_url: node.draftOrder.invoiceUrl });

  } catch (e) {
    console.error('[create-draft] error:', e);
    return res.status(500).json({ error: 'draft_order_failed' });
  }
}

/* ===== Helpers ===== */

function computePrice(pb, sel) {
  const base = pb.base?.[sel.orientation]?.[sel.size] ?? 0;
  let total = base;
  Object.entries(pb.adds || {}).forEach(([key, value]) => {
    if (typeof value === 'number') {
      if (sel[key]) total += value; // checkbox add
    } else if (value && typeof value === 'object') {
      total += (value[sel[key]] || 0); // select add
    }
  });
  return Number(total.toFixed(2));
}

function sanitizeToken(v){
  return String(v ?? 'NA').replace(/\s+/g,'').toUpperCase().replace(/[^A-Z0-9\-]/g,'');
}

function buildSku(pb, sel) {
  // 1) sku_map override (optional)
  if (pb.sku_map) {
    const key = selectionKey(sel, pb);
    if (pb.sku_map[key]) return pb.sku_map[key];
  }
  // 2) formatted deterministic SKU
  const fmt = pb.sku?.format || '{prefix}-{orientation}-{size}';
  const prefix = pb.sku?.prefix || 'SKU';
  const codes = pb.sku?.codes || {};
  const tokens = {
    prefix,
    orientation: (codes.orientation?.[sel.orientation] ?? sel.orientation),
    size: sel.size
  };

  // include all 'adds' keys
  Object.keys(pb.adds || {}).forEach(key => {
    const v = sel[key];
    const map = codes[key] || {};
    if (typeof (pb.adds[key]) === 'number') {
      tokens[key] = map[String(!!v)] ?? (v ? 'TRUE' : 'FALSE');
    } else {
      tokens[key] = map[v] ?? v;
    }
  });

  let sku = fmt;
  Object.entries(tokens).forEach(([k, v]) => {
    sku = sku.replace(new RegExp(`\\{${k}\\}`, 'g'), sanitizeToken(v));
  });
  return sku.replace(/\{[a-z0-9_]+\}/gi, 'NA');
}

function selectionKey(sel, pb) {
  const parts = [sel.orientation, sel.size];
  Object.keys(pb.adds || {}).forEach(k => {
    parts.push(`${k}:${sel[k]}`);
  });
  return parts.join('|');
}

/* Optional HMAC (enable + add SHOPIFY_APP_SECRET env to use)
import crypto from 'node:crypto';
function verifyProxyHmac(req, appSecret) {
  if (!appSecret) return true; // skip if not set
  // Vercel gives us full URL in req.headers.host + req.url
  const url = new URL(req.url, `https://${req.headers.host}`);
  const hmac = url.searchParams.get('hmac') || url.searchParams.get('signature');
  if (!hmac) return false;
  // Build message by sorting all params except hmac/signature
  const entries = [];
  url.searchParams.forEach((v, k) => {
    if (k === 'hmac' || k === 'signature') return;
    entries.push([k, v]);
  });
  entries.sort((a,b) => a[0].localeCompare(b[0]));
  const msg = entries.map(([k,v]) => `${k}=${v}`).join('&');
  const digest = crypto.createHmac('sha256', appSecret).update(msg).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac));
}
*/
