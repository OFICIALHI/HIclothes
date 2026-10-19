
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

export async function onRequestPost({ request, env }) {
  const passwordSecret = env.HI_ADMIN_PASSWORD;

  if (!passwordSecret || passwordSecret.length < 20) {
    return Response.json(
      { error: "A autenticação não está configurada." },
      { status: 500 }
    );
  }

  const origin = new URL(request.url).origin;

  if (request.headers.get("Origin") !== origin) {
    return Response.json(
      { error: "Pedido não autorizado." },
      { status: 403 }
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

  if (
    typeof body.password !== "string" ||
    body.password.length > 1024 ||
    body.password !== passwordSecret
  ) {
    return Response.json(
      { error: "Palavra-passe incorreta." },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" }
      }
    );
  }

  const issuedAt = Math.floor(Date.now() / 1000).toString();
  const signature = await signSession(passwordSecret, issuedAt);
  const cookieValue = `${issuedAt}.${signature}`;

  return Response.json(
    { ok: true },
    {
      headers: {
        "Set-Cookie": `HI_ADMIN_SESSION=${cookieValue}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`,
        "Cache-Control": "no-store"
      }
    }
  );
}
