import {
  configuration,
  databaseRequest,
  errorResponse,
  jsonResponse,
  money,
  paypalReady,
  paypalRequest,
  sameOrigin,
  validPolicyDate,
} from "../../_utils/paypal.js";

async function checkoutLegalReady(config) {
  const [settings] = await databaseRequest(
    config,
    "store_legal_settings?select=business_name,support_email,postal_address,shipping_policy,returns_policy,tax_disclosure,policy_date,compliance_confirmed,is_published&id=eq.1",
  );
  return Boolean(settings?.business_name && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.support_email || "") &&
    settings.postal_address && settings.shipping_policy && settings.returns_policy && settings.tax_disclosure &&
    validPolicyDate(settings.policy_date) && settings.compliance_confirmed && settings.is_published);
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return jsonResponse({ error: "Checkout must be started from this storefront." }, 403);
  const config = configuration(env);
  if (!paypalReady(config)) return jsonResponse({ error: "PayPal checkout is not configured on this free-hosted store." }, 503);

  try {
    const contentLength = Number(request.headers.get("Content-Length") || "0");
    if (contentLength > 32768) return jsonResponse({ error: "The checkout request is too large." }, 413);
    const rawBody = await request.text();
    if (rawBody.length > 32768) return jsonResponse({ error: "The checkout request is too large." }, 413);
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: "Invalid checkout request." }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse({ error: "Invalid checkout request." }, 400);
    }
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 25) {
      return jsonResponse({ error: "Your bag must contain between 1 and 25 line items." }, 400);
    }
    if (!(await checkoutLegalReady(config))) {
      return jsonResponse({ error: "Checkout is unavailable until the seller has published and confirmed complete store policies." }, 503);
    }

    let itemTotalCents = 0;
    const lines = [];
    for (const item of body.items) {
      if (!item || typeof item.product_id !== "string" || item.product_id.length > 100 ||
        !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
        return jsonResponse({ error: "One of the items in your bag is invalid. Please refresh and try again." }, 400);
      }
      if (item.product_id === "boundary-sign" && !["yellow", "white", "orange"].includes(item.color)) {
        return jsonResponse({ error: "Choose a valid sign color before checkout." }, 400);
      }
      if (item.product_id !== "boundary-sign" &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.product_id)) {
        return jsonResponse({ error: "One of the products in your bag is invalid. Please refresh and try again." }, 400);
      }

      let product;
      if (item.product_id === "boundary-sign") {
        product = { id: "boundary-sign", name: "No Trespassing · 12 × 18 in", price_cents: 1800 };
      } else {
        const query = new URLSearchParams({
          id: `eq.${item.product_id}`,
          is_published: "eq.true",
          select: "id,name,price_cents",
          limit: "1",
        });
        [product] = await databaseRequest(config, `products?${query}`);
      }
      if (!product || !Number.isSafeInteger(product.price_cents) || product.price_cents < 1) {
        return jsonResponse({ error: "A product in your bag is no longer available." }, 400);
      }
      itemTotalCents += product.price_cents * item.quantity;
      if (!Number.isSafeInteger(itemTotalCents) || itemTotalCents > 999999999) {
        return jsonResponse({ error: "Your bag total is outside the supported checkout limit." }, 400);
      }
      const name = item.product_id === "boundary-sign" ? `${product.name} · ${item.color}` : product.name;
      lines.push({
        product_id: product.id,
        name,
        quantity: item.quantity,
        price_cents: product.price_cents,
        color: item.product_id === "boundary-sign" ? item.color : null,
      });
    }

    const totalCents = itemTotalCents + config.shippingCents;
    if (!Number.isSafeInteger(totalCents) || totalCents < 1 || totalCents > 999999999) {
      return jsonResponse({ error: "The store's shipping setting or order total is invalid." }, 400);
    }
    const reference = crypto.randomUUID();
    const order = await paypalRequest(config, "/v2/checkout/orders", {
      method: "POST",
      requestId: reference,
      body: {
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: reference,
          custom_id: reference,
          items: lines.map((line) => ({
            name: line.name,
            quantity: String(line.quantity),
            category: "PHYSICAL_GOODS",
            unit_amount: { currency_code: "USD", value: money(line.price_cents) },
          })),
          amount: {
            currency_code: "USD",
            value: money(totalCents),
            breakdown: {
              item_total: { currency_code: "USD", value: money(itemTotalCents) },
              ...(config.shippingCents ? { shipping: { currency_code: "USD", value: money(config.shippingCents) } } : {}),
            },
          },
        }],
        application_context: {
          brand_name: "Timber & Tackle Supply",
          shipping_preference: "GET_FROM_FILE",
          user_action: "PAY_NOW",
        },
      },
    });
    if (typeof order.id !== "string") throw new Error("PayPal did not create an order.");
    await databaseRequest(config, "store_orders", {
      method: "POST",
      prefer: "return=minimal",
      body: {
        paypal_order_id: order.id,
        reference,
        status: "CREATED",
        total_cents: totalCents,
        shipping_cents: config.shippingCents,
        items: lines,
      },
    });
    return jsonResponse({ id: order.id }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
