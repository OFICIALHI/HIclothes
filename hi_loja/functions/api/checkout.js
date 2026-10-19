
const CATALOG = {
  hoodie: { name: "Core Hoodie", amount: 3990 },
  tee: { name: "Everyday Tee", amount: 1990 },
  cap: { name: "City Cap", amount: 1790 }
};

export async function onRequestPost({ request, env }) {
  const secret = env.STRIPE_SECRET_KEY;

  if (!secret || !secret.startsWith("sk_")) {
    return Response.json(
      { error: "Configuração do Stripe em falta." },
      { status: 500 }
    );
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Pedido inválido." },
      { status: 400 }
    );
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return Response.json(
      { error: "O carrinho está vazio." },
      { status: 400 }
    );
  }

  const quantities = new Map();

  for (const item of body.items) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !Object.hasOwn(CATALOG, item.id) ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 20
    ) {
      return Response.json(
        { error: "Produto ou quantidade inválida." },
        { status: 400 }
      );
    }

    const totalQuantity =
      (quantities.get(item.id) || 0) + item.quantity;

    if (totalQuantity > 20) {
      return Response.json(
        { error: "Quantidade máxima excedida." },
        { status: 400 }
      );
    }

    quantities.set(item.id, totalQuantity);
  }

  const origin = new URL(request.url).origin;
  const orderRef = crypto.randomUUID();
  const params = new URLSearchParams();

  params.set("mode", "payment");
  params.set(
    "success_url",
    `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`
  );
  params.set("cancel_url", `${origin}/?checkout=cancelled`);
  params.set("billing_address_collection", "required");
  params.set("shipping_address_collection[allowed_countries][0]", "ES");
  params.set("shipping_address_collection[allowed_countries][1]", "PT");
  params.set("phone_number_collection[enabled]", "true");
  params.set("allow_promotion_codes", "true");

  // Referência e carrinho para o webhook registar a encomenda.
  params.set("metadata[order_ref]", orderRef);
  params.set(
    "metadata[cart]",
    JSON.stringify(Object.fromEntries(quantities))
  );

  let i = 0;

  for (const [id, quantity] of quantities) {
    const product = CATALOG[id];

    params.set(`line_items[${i}][quantity]`, String(quantity));
    params.set(`line_items[${i}][price_data][currency]`, "eur");
    params.set(
      `line_items[${i}][price_data][unit_amount]`,
      String(product.amount)
    );
    params.set(
      `line_items[${i}][price_data][product_data][name]`,
      product.name
    );

    i++;
  }

  // Opcional: adicionar portes através de um Stripe Shipping Rate.
  if (env.STRIPE_SHIPPING_RATE_ID) {
    params.set(
      "shipping_options[0][shipping_rate]",
      env.STRIPE_SHIPPING_RATE_ID
    );
  }

  const response = await fetch(
    "https://api.stripe.com/v1/checkout/sessions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params
    }
  );

  const session = await response.json();

  if (!response.ok) {
    return Response.json(
      {
        error:
          "A Stripe não conseguiu criar o checkout. Verifica a configuração da conta e dos portes."
      },
      { status: 400 }
    );
  }

  return Response.json({ url: session.url });
}
