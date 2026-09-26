import assert from "node:assert/strict";
import test from "node:test";
import { onRequestGet as getPaypalConfig } from "../functions/api/paypal/config.js";
import { onRequestPost as createOrder } from "../functions/api/paypal/orders.js";
import { onRequestPost as captureOrder } from "../functions/api/paypal/orders/[orderId]/capture.js";

const env = {
  SUPABASE_URL: "https://supabase.example.test",
  SUPABASE_SERVICE_ROLE_KEY: "private-test-service-key",
  PAYPAL_CLIENT_ID: "sandbox-test-client",
  PAYPAL_CLIENT_SECRET: "sandbox-test-secret",
  PAYPAL_ENV: "sandbox",
  PAYPAL_SHIPPING_CENTS: "100",
};
const shopOrigin = "https://shop.example.test";
const legalSettings = {
  business_name: "Test Seller",
  support_email: "seller@example.test",
  postal_address: "1 Test Street",
  shipping_policy: "Ships in five days.",
  returns_policy: "Contact us for returns.",
  tax_disclosure: "Tax applied where required at checkout.",
  policy_date: "2026-09-26",
  compliance_confirmed: true,
  is_published: true,
};
const product = { id: "2f0b56ce-1220-4ef2-95f6-54bc4e130000", name: "Test Sign", price_cents: 1234 };
const productId = product.id;

function setupFetch(t, { legal = legalSettings } = {}) {
  const calls = [];
  let savedOrder;
  let paypalCreateBody;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || "GET";
    calls.push({ url, method, init });

    if (url.pathname.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "sandbox-access-token" });
    if (url.pathname.endsWith("/rest/v1/store_legal_settings")) return Response.json([legal]);
    if (url.pathname.endsWith("/rest/v1/products")) return Response.json([product]);
    if (url.pathname.endsWith("/rest/v1/store_orders") && method === "POST") {
      savedOrder = JSON.parse(init.body);
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/rest/v1/store_orders") && method === "GET") return Response.json(savedOrder ? [savedOrder] : []);
    if (url.pathname.endsWith("/rest/v1/store_orders") && method === "PATCH") {
      Object.assign(savedOrder, JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v2/checkout/orders" && method === "POST") {
      paypalCreateBody = JSON.parse(init.body);
      return Response.json({ id: "SANDBOX-ORDER-1234567890" });
    }
    if (url.pathname.endsWith("/capture") && method === "POST") {
      return Response.json({
        status: "COMPLETED",
        purchase_units: [{
          custom_id: savedOrder.reference,
          payments: {
            captures: [{
              id: "CAPTURE-123456",
              status: "COMPLETED",
              amount: { currency_code: "USD", value: "25.68" },
            }],
          },
        }],
      });
    }
    if (url.pathname.endsWith("/SANDBOX-ORDER-1234567890")) {
      return Response.json({ status: "APPROVED", purchase_units: [{ custom_id: savedOrder.reference }] });
    }
    throw new Error(`Unexpected mocked request ${method} ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return {
    calls,
    get savedOrder() { return savedOrder; },
    get paypalCreateBody() { return paypalCreateBody; },
  };
}

const originalFetch = globalThis.fetch;

function checkoutRequest(items, { origin = shopOrigin, body } = {}) {
  return new Request(`${shopOrigin}/api/paypal/orders`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: body ?? JSON.stringify({ items }),
  });
}

test("PayPal readiness validates seller details without exposing secrets", async (t) => {
  setupFetch(t);
  const response = await getPaypalConfig({ env });
  const result = await response.json();
  assert.equal(result.enabled, true);
  assert.equal(result.clientId, env.PAYPAL_CLIENT_ID);
  assert.equal(JSON.stringify(result).includes(env.PAYPAL_CLIENT_SECRET), false);

  const withoutPaypalCredentials = { ...env, PAYPAL_CLIENT_SECRET: "" };
  const incomplete = await (await getPaypalConfig({ env: withoutPaypalCredentials })).json();
  assert.equal(incomplete.enabled, false);
  assert.ok(incomplete.missingDetails.includes("PAYPAL_APP_CREDENTIALS"));
});

test("checkout uses catalog prices and persists the PayPal order", async (t) => {
  const mock = setupFetch(t);
  const response = await createOrder({
    request: checkoutRequest([{ product_id: productId, quantity: 2, price_cents: 1 }]),
    env,
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "SANDBOX-ORDER-1234567890" });
  assert.equal(mock.paypalCreateBody.purchase_units[0].items[0].unit_amount.value, "12.34");
  assert.equal(mock.paypalCreateBody.purchase_units[0].amount.value, "25.68");
  assert.equal(mock.savedOrder.total_cents, 2568);
  assert.equal(mock.savedOrder.status, "CREATED");
});

test("capture verifies the approved order and records its completed payment", async (t) => {
  const mock = setupFetch(t);
  await createOrder({
    request: checkoutRequest([{ product_id: productId, quantity: 2 }]),
    env,
  });
  const request = new Request(`${shopOrigin}/api/paypal/orders/SANDBOX-ORDER-1234567890/capture`, {
    method: "POST",
    headers: { Origin: shopOrigin },
  });
  const response = await captureOrder({
    request,
    env,
    params: { orderId: "SANDBOX-ORDER-1234567890" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "COMPLETED" });
  assert.equal(mock.savedOrder.status, "COMPLETED");
  assert.equal(mock.savedOrder.capture_id, "CAPTURE-123456");
});

test("invalid policy dates keep payment creation disabled", async (t) => {
  const mock = setupFetch(t, { legal: { ...legalSettings, policy_date: "2026-02-30" } });
  const response = await createOrder({
    request: checkoutRequest([{ product_id: productId, quantity: 1 }]),
    env,
  });
  assert.equal(response.status, 503);
  assert.equal(mock.calls.some(({ url }) => url.pathname === "/v2/checkout/orders"), false);
});

test("invalid carts and cross-origin checkout are rejected before PayPal", async (t) => {
  const mock = setupFetch(t);
  const emptyCartResponse = await createOrder({ request: checkoutRequest([]), env });
  assert.equal(emptyCartResponse.status, 400);

  const nullBodyResponse = await createOrder({ request: checkoutRequest(undefined, { body: "null" }), env });
  assert.equal(nullBodyResponse.status, 400);

  const foreignOriginResponse = await createOrder({
    request: checkoutRequest([], { origin: "https://attacker.example" }),
    env,
  });
  assert.equal(foreignOriginResponse.status, 403);
  assert.equal(mock.calls.some(({ url }) => url.pathname === "/v2/checkout/orders"), false);
});
