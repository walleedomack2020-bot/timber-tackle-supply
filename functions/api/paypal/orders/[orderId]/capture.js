import {
  configuration,
  databaseRequest,
  errorResponse,
  jsonResponse,
  paypalReady,
  paypalRequest,
  sameOrigin,
} from "../../../../_utils/paypal.js";

export async function onRequestPost({ request, env, params }) {
  if (!sameOrigin(request)) return jsonResponse({ error: "Payment must be confirmed from this storefront." }, 403);
  const config = configuration(env);
  if (!paypalReady(config)) return jsonResponse({ error: "PayPal checkout is not configured on this store." }, 503);
  const orderId = params.orderId;
  if (typeof orderId !== "string" || !/^[A-Za-z0-9-]{10,80}$/.test(orderId)) {
    return jsonResponse({ error: "That PayPal order could not be found." }, 404);
  }

  try {
    const query = new URLSearchParams({
      paypal_order_id: `eq.${orderId}`,
      select: "paypal_order_id,reference,status,total_cents",
      limit: "1",
    });
    const [savedOrder] = await databaseRequest(config, `store_orders?${query}`);
    if (!savedOrder) return jsonResponse({ error: "That PayPal order could not be found." }, 404);
    if (savedOrder.status === "COMPLETED") return jsonResponse({ status: "COMPLETED" });

    let order = await paypalRequest(config, `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    if (order.purchase_units?.[0]?.custom_id !== savedOrder.reference) {
      return jsonResponse({ error: "That PayPal order does not match this checkout." }, 403);
    }
    if (order.status === "APPROVED") {
      order = await paypalRequest(config, `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        method: "POST",
        requestId: `${savedOrder.reference}-capture`,
        body: {},
      });
    }
    if (order.status !== "COMPLETED") return jsonResponse({ error: "PayPal has not approved this payment." }, 409);

    const purchase = order.purchase_units?.[0];
    const capture = purchase?.payments?.captures?.find((payment) => payment.status === "COMPLETED");
    const captureAmount = Math.round(Number(capture?.amount?.value) * 100);
    if (purchase?.custom_id !== savedOrder.reference || capture?.amount?.currency_code !== "USD" ||
      captureAmount !== savedOrder.total_cents || typeof capture?.id !== "string") {
      throw new Error("The completed PayPal payment did not match the stored order.");
    }

    await databaseRequest(config, `store_orders?paypal_order_id=eq.${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: { status: "COMPLETED", capture_id: capture.id, completed_at: new Date().toISOString() },
    });
    return jsonResponse({ status: "COMPLETED" });
  } catch (error) {
    return errorResponse(error);
  }
}
