
async function signSession(secret, issuedAt) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const data = new TextEncoder().encode(`HI-admin-v1:${issuedAt}`);
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, data)
  );

  return Array.from(signature)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function isAuthenticated(request, env) {
  const secret = env.HI_ADMIN_PASSWORD;
  if (!secret || secret.length < 20) return false;

  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)HI_ADMIN_SESSION=([^;]+)/);
  if (!match) return false;

  const parts = match[1].split(".");
  if (parts.length !== 2) return false;

  const [issuedAt, suppliedSignature] = parts;
  if (!/^\d{10}$/.test(issuedAt)) return false;

  const issuedAtNumber = Number(issuedAt);
  const now = Math.floor(Date.now() / 1000);

  if (
    issuedAtNumber > now + 60 ||
    now - issuedAtNumber > 8 * 60 * 60
  ) {
    return false;
  }

  const expectedSignature = await signSession(secret, issuedAt);

  if (suppliedSignature.length !== expectedSignature.length) {
    return false;
  }

  let difference = 0;
  for (let i = 0; i < expectedSignature.length; i++) {
    difference |=
      suppliedSignature.charCodeAt(i) ^
      expectedSignature.charCodeAt(i);
  }

  return difference === 0;
}

export async function onRequestGet({ request, env }) {
  if (!(await isAuthenticated(request, env))) {
    return Response.json(
      { error: "Autenticação necessária." },
      {
        status: 401,
        headers: {
          "Cache-Control": "no-store",
          "Vary": "Cookie"
        }
      }
    );
  }

  if (!env.DB) {
    return Response.json(
      { error: "Base de dados indisponível." },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const result = await env.DB.prepare(`
      SELECT
        id,
        order_ref,
        currency,
        total_amount,
        payment_status,
        fulfillment_status,
        shipping_country,
        created_at
      FROM orders
      ORDER BY id DESC
      LIMIT 100
    `).all();

    const orders = result.results || [];

    const itemsResult = await env.DB.prepare(`
      SELECT
        order_id,
        product_id,
        product_name,
        quantity,
        unit_amount
      FROM order_items
      WHERE order_id IN (
        SELECT id FROM orders ORDER BY id DESC LIMIT 100
      )
      ORDER BY order_id DESC, id ASC
    `).all();

    const itemsByOrder = new Map();

    for (const item of itemsResult.results || []) {
      if (!itemsByOrder.has(item.order_id)) {
        itemsByOrder.set(item.order_id, []);
      }

      itemsByOrder.get(item.order_id).push({
        product_id: item.product_id,
        product_name: item.product_name,
        quantity: item.quantity,
        unit_amount: item.unit_amount
      });
    }

    return Response.json(
      {
        orders: orders.map((order) => ({
          order_ref: order.order_ref,
          currency: order.currency,
          total_amount: order.total_amount,
          payment_status: order.payment_status,
          fulfillment_status: order.fulfillment_status,
          shipping_country: order.shipping_country,
          created_at: order.created_at,
          items: itemsByOrder.get(order.id) || []
        }))
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "Vary": "Cookie"
        }
      }
    );
  } catch {
    return Response.json(
      { error: "Não foi possível consultar as encomendas." },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
