
async function verifyStripeSignature(payload, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;

  const parts = signatureHeader.split(",");
  let timestamp = "";
  const signatures = [];

  for (const part of parts) {
    const [key, value] = part.split("=", 2);

    if (key === "t") timestamp = value;
    if (key === "v1") signatures.push(value);
  }

  if (!timestamp || signatures.length === 0) return false;

  const timestampNumber = Number(timestamp);

  if (
    !Number.isFinite(timestampNumber) ||
    Math.abs(Date.now() / 1000 - timestampNumber) > 300
  ) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signedPayload = `${timestamp}.${payload}`;
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload))
  );

  const expected = Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return signatures.some((signature) => {
    if (signature.length !== expected.length) return false;

    let difference = 0;

    for (let i = 0; i < expected.length; i++) {
      difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }

    return difference === 0;
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB || !env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) {
    return new Response("Configuração em falta.", { status: 500 });
  }

  const payload = await request.text();
  const signature = request.headers.get("Stripe-Signature");

  let validSignature;

  try {
    validSignature = await verifyStripeSignature(
      payload,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch {
    return new Response("Não foi possível verificar a assinatura.", {
      status: 400
    });
  }

  if (!validSignature) {
    return new Response("Assinatura inválida.", { status: 400 });
  }

  let event;

  try {
    event = JSON.parse(payload);
  } catch {
    return new Response("Evento inválido.", { status: 400 });
  }

  const supportedEvents = [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed"
  ];

  if (!supportedEvents.includes(event.type)) {
    return Response.json({ received: true });
  }

  const session = event.data?.object;

  if (!session || session.object !== "checkout.session") {
    return new Response("Sessão inválida.", { status: 400 });
  }

  if (session.mode !== "payment" || !session.id) {
    return Response.json({ received: true });
  }

  const orderRef = session.metadata?.order_ref;
  let cart;

  try {
    cart = JSON.parse(session.metadata?.cart || "");
  } catch {
    return new Response("Dados da encomenda inválidos.", { status: 400 });
  }

  const catalog = {
    hoodie: { name: "Core Hoodie", amount: 3990 },
    tee: { name: "Everyday Tee", amount: 1990 },
    cap: { name: "City Cap", amount: 1790 }
  };

  if (
    typeof orderRef !== "string" ||
    !orderRef ||
    !cart ||
    typeof cart !== "object" ||
    Array.isArray(cart)
  ) {
    return new Response("Referência da encomenda inválida.", {
      status: 400
    });
  }

  const items = [];

  for (const [productId, quantity] of Object.entries(cart)) {
    if (
      !Object.hasOwn(catalog, productId) ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 20
    ) {
      return new Response("Artigo inválido.", { status: 400 });
    }

    items.push({
      productId,
      name: catalog[productId].name,
      quantity,
      amount: catalog[productId].amount
    });
  }

  if (items.length === 0) {
    return new Response("A encomenda não tem artigos.", { status: 400 });
  }

  const totalItemsAmount = items.reduce(
    (sum, item) => sum + item.amount * item.quantity,
    0
  );

  if (
    !Number.isInteger(session.amount_total) ||
    session.amount_total < totalItemsAmount
  ) {
    return new Response("Total da sessão inválido.", { status: 400 });
  }

  const paymentStatus =
    event.type === "checkout.session.async_payment_failed"
      ? "failed"
      : session.payment_status === "paid" ||
          event.type === "checkout.session.async_payment_succeeded"
        ? "paid"
        : "pending";

  const customerEmail =
    session.customer_details?.email || session.customer_email || null;

  const shippingCountry =
    session.shipping_details?.address?.country ||
    session.collected_information?.shipping_details?.address?.country ||
    null;

  try {
    const existing = await env.DB.prepare(
      "SELECT id, order_ref FROM orders WHERE stripe_session_id = ?"
    )
      .bind(session.id)
      .first();

    if (existing && existing.order_ref !== orderRef) {
      return new Response("Referência da sessão inconsistente.", {
        status: 400
      });
    }

    const order = await env.DB.prepare(`
      INSERT INTO orders (
        order_ref,
        stripe_session_id,
        stripe_payment_intent_id,
        customer_email,
        currency,
        total_amount,
        payment_status,
        shipping_country
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(stripe_session_id) DO UPDATE SET
        stripe_payment_intent_id = excluded.stripe_payment_intent_id,
        customer_email = COALESCE(excluded.customer_email, orders.customer_email),
        total_amount = excluded.total_amount,
        payment_status = CASE
          WHEN excluded.payment_status = 'paid' THEN 'paid'
          WHEN orders.payment_status = 'paid' THEN 'paid'
          ELSE excluded.payment_status
        END,
        shipping_country = COALESCE(excluded.shipping_country, orders.shipping_country),
        updated_at = datetime('now')
      RETURNING id
    `)
      .bind(
        orderRef,
        session.id,
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : null,
        customerEmail,
        session.currency || "eur",
        session.amount_total,
        paymentStatus,
        shippingCountry
      )
      .first();

    if (!order?.id) {
      throw new Error("Não foi possível obter a encomenda.");
    }

    const statements = [
      env.DB.prepare("DELETE FROM order_items WHERE order_id = ?").bind(
        order.id
      ),
      ...items.map((item) =>
        env.DB.prepare(`
          INSERT INTO order_items (
            order_id,
            product_id,
            product_name,
            quantity,
            unit_amount
          )
          VALUES (?, ?, ?, ?, ?)
        `).bind(
          order.id,
          item.productId,
          item.name,
          item.quantity,
          item.amount
        )
      )
    ];

    await env.DB.batch(statements);
  } catch {
    return new Response("Erro ao registar a encomenda.", { status: 500 });
  }

  return Response.json({ received: true });
}
