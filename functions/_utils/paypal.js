const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

export function configuration(env) {
  return {
    supabaseUrl: env.SUPABASE_URL?.replace(/\/+$/, ""),
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
    environment: env.PAYPAL_ENV || "sandbox",
    shippingCents: Number(env.PAYPAL_SHIPPING_CENTS || "0"),
  };
}

export function databaseReady(config) {
  return Boolean(config.supabaseUrl && config.serviceKey);
}

export function paypalReady(config) {
  return Boolean(databaseReady(config) && config.clientId && config.clientSecret &&
    ["sandbox", "live"].includes(config.environment) && Number.isSafeInteger(config.shippingCents) &&
    config.shippingCents >= 0);
}

export async function databaseRequest(config, resource, options = {}) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/${resource}`, {
    method: options.method || "GET",
    headers: {
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      "Content-Type": "application/json",
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!response.ok) throw new Error("The store database could not complete this checkout.");
  if (response.status === 204) return null;
  return response.json();
}

export async function paypalRequest(config, resource, options = {}) {
  const apiBase = config.environment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
  const tokenResponse = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!tokenResponse.ok) throw new Error("PayPal authentication failed. Check the private app credentials.");
  const token = await tokenResponse.json();
  if (typeof token.access_token !== "string") throw new Error("PayPal did not return an access token.");
  const response = await fetch(`${apiBase}${resource}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      ...(options.requestId ? { "PayPal-Request-Id": options.requestId } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!response.ok) throw new Error("PayPal could not complete checkout. Please try again.");
  return response.json();
}

export function sameOrigin(request) {
  try {
    return new URL(request.headers.get("Origin")).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function money(cents) {
  return (cents / 100).toFixed(2);
}

export function validPolicyDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function errorResponse(error) {
  console.error("Checkout function failed:", error);
  return jsonResponse({ error: error.message || "Checkout is temporarily unavailable." }, 502);
}
