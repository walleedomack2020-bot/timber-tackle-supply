import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";

const scrypt = promisify(crypto.scrypt);
const root = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.resolve(process.env.STORE_DATA_DIR || path.join(root, ".local-store"));
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const imageDirectory = path.join(dataDirectory, "images");
const authFile = path.join(dataDirectory, "owner.json");
const productsFile = path.join(dataDirectory, "products.json");
const ordersFile = path.join(dataDirectory, "orders.json");
const legalSettingsFile = path.join(dataDirectory, "legal-settings.json");
const sessionCookie = "timber_owner_session";
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const production = process.env.NODE_ENV === "production";
const ownerSetupKey = process.env.OWNER_SETUP_KEY;
const paypalClientId = process.env.PAYPAL_CLIENT_ID;
const paypalClientSecret = process.env.PAYPAL_CLIENT_SECRET;
const paypalEnvironment = process.env.PAYPAL_ENV || "sandbox";
const paypalShippingCents = Number(process.env.PAYPAL_SHIPPING_CENTS || "0");
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const storeLegalDetails = {
  businessName: process.env.STORE_LEGAL_NAME?.trim() ?? "",
  supportEmail: process.env.STORE_SUPPORT_EMAIL?.trim() ?? "",
  postalAddress: process.env.STORE_POSTAL_ADDRESS?.trim() ?? "",
  shippingPolicy: process.env.STORE_SHIPPING_POLICY?.trim() ?? "",
  returnsPolicy: process.env.STORE_RETURNS_POLICY?.trim() ?? "",
  taxDisclosure: process.env.STORE_TAX_DISCLOSURE?.trim() ?? "",
  policyDate: process.env.STORE_POLICY_EFFECTIVE_DATE?.trim() ?? "",
};
const liveComplianceConfirmed = process.env.STORE_LIVE_COMPLIANCE_CONFIRMED === "true";
let ordersWriteQueue = Promise.resolve();
if (production && (!ownerSetupKey || ownerSetupKey.length < 32)) {
  throw new Error("Set OWNER_SETUP_KEY to a random value of at least 32 characters before running in production.");
}
if (!["sandbox", "live"].includes(paypalEnvironment)) {
  throw new Error("Set PAYPAL_ENV to either sandbox or live.");
}
const imageTypes = {
  "image/jpeg": { extension: "jpg", matches: (image) => image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff },
  "image/png": { extension: "png", matches: (image) => image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/webp": { extension: "webp", matches: (image) => image.toString("ascii", 0, 4) === "RIFF" && image.toString("ascii", 8, 12) === "WEBP" },
  "image/avif": { extension: "avif", matches: (image) => image.toString("ascii", 4, 8) === "ftyp" && ["avif", "avis"].includes(image.toString("ascii", 8, 12)) },
};

function respond(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 12 * 1024 * 1024) throw Object.assign(new Error("Request is too large."), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid request data."), { statusCode: 400 });
  }
}

async function writeJson(file, value) {
  const temporaryFile = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.rename(temporaryFile, file);
}

async function readProducts() {
  try {
    return JSON.parse(await fs.promises.readFile(productsFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readOrders() {
  try {
    return JSON.parse(await fs.promises.readFile(ordersFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function updateOrders(update) {
  const operation = ordersWriteQueue.then(async () => {
    const orders = await readOrders();
    const result = await update(orders);
    await fs.promises.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await writeJson(ordersFile, result.orders);
    return result.value;
  });
  ordersWriteQueue = operation.catch(() => undefined);
  return operation;
}

function paypalIsConfigured() {
  return Boolean(paypalClientId && paypalClientSecret);
}

async function readStoreLegalSettings() {
  let saved = {};
  try {
    saved = JSON.parse(await fs.promises.readFile(legalSettingsFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return {
    ...storeLegalDetails,
    ...(saved.details ?? {}),
    complianceConfirmed: liveComplianceConfirmed || saved.complianceConfirmed === true,
  };
}

function missingStoreDetails(details, complianceConfirmed) {
  const missing = [];
  let policyDateValid = false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(details.policyDate)) {
    const parsedPolicyDate = Date.parse(`${details.policyDate}T00:00:00Z`);
    policyDateValid = Number.isFinite(parsedPolicyDate) &&
      new Date(parsedPolicyDate).toISOString().slice(0, 10) === details.policyDate;
  }
  if (!details.businessName) missing.push("STORE_LEGAL_NAME");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.supportEmail)) missing.push("STORE_SUPPORT_EMAIL");
  if (!details.postalAddress) missing.push("STORE_POSTAL_ADDRESS");
  if (!details.shippingPolicy) missing.push("STORE_SHIPPING_POLICY");
  if (!details.returnsPolicy) missing.push("STORE_RETURNS_POLICY");
  if (!details.taxDisclosure) missing.push("STORE_TAX_DISCLOSURE");
  if (!policyDateValid) missing.push("STORE_POLICY_EFFECTIVE_DATE");
  if (!complianceConfirmed) missing.push("STORE_LIVE_COMPLIANCE_CONFIRMED");
  return missing;
}

function validateStoreLegalSettings(body) {
  const limits = {
    businessName: 120,
    supportEmail: 254,
    postalAddress: 500,
    shippingPolicy: 3000,
    returnsPolicy: 3000,
    taxDisclosure: 2000,
  };
  for (const [key, maximum] of Object.entries(limits)) {
    if (typeof body[key] !== "string" || !body[key].trim() || body[key].trim().length > maximum) {
      return `${key} must contain 1–${maximum} characters.`;
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.supportEmail.trim())) return "Enter a valid customer support email.";
  if (typeof body.policyDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.policyDate)) return "Enter the policy effective date as YYYY-MM-DD.";
  const timestamp = Date.parse(`${body.policyDate}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== body.policyDate) return "Enter a valid policy effective date.";
  if (typeof body.complianceConfirmed !== "boolean") return "Review and confirm the seller compliance statement.";
  return null;
}

function paypalApiBase() {
  return paypalEnvironment === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

async function paypalRequest(resource, options = {}) {
  const tokenResponse = await fetch(`${paypalApiBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${paypalClientId}:${paypalClientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15000),
  });
  if (!tokenResponse.ok) throw Object.assign(new Error("PayPal authentication failed. Check the configured app credentials."), { statusCode: 502 });
  const token = await tokenResponse.json();
  if (typeof token.access_token !== "string") throw Object.assign(new Error("PayPal did not return an access token."), { statusCode: 502 });

  const response = await fetch(`${paypalApiBase()}${resource}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Object.assign(new Error("PayPal could not complete this checkout. Please try again."), { statusCode: 502 });
  return response.json();
}

function sameOriginRequest(request) {
  try {
    const origin = new URL(request.headers.origin);
    return origin.host === request.headers.host && origin.protocol === (production ? "https:" : "http:");
  } catch {
    return false;
  }
}

async function findCheckoutProduct(productId) {
  if (productId === "boundary-sign") {
    return { id: productId, name: "No Trespassing · 12 × 18 in", description: "Safety-color choice", price_cents: 1800 };
  }

  const localProduct = (await readProducts()).find((product) => product.id === productId && product.is_published);
  if (localProduct) return localProduct;

  if (supabaseUrl && supabaseAnonKey) {
    const query = new URLSearchParams({
      id: `eq.${productId}`,
      is_published: "eq.true",
      select: "id,name,description,price_cents",
      limit: "1",
    });
    const response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/products?${query}`, {
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw Object.assign(new Error("The product catalog could not be verified. Please try again."), { statusCode: 502 });
    const [product] = await response.json();
    if (product) return product;
  }
  return null;
}

function paypalAmount(cents) {
  return (cents / 100).toFixed(2);
}

async function createPaypalOrder(body) {
  if (!body || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 25) {
    throw Object.assign(new Error("Your bag must contain between 1 and 25 line items."), { statusCode: 400 });
  }

  let itemTotalCents = 0;
  const lines = [];
  for (const item of body.items) {
    if (!item || typeof item.product_id !== "string" || item.product_id.length > 100 ||
      !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
      throw Object.assign(new Error("One of the items in your bag is invalid. Please refresh and try again."), { statusCode: 400 });
    }
    if (item.product_id === "boundary-sign" && !["yellow", "white", "orange"].includes(item.color)) {
      throw Object.assign(new Error("Choose a valid sign color before checkout."), { statusCode: 400 });
    }

    const product = await findCheckoutProduct(item.product_id);
    if (!product || !Number.isSafeInteger(product.price_cents) || product.price_cents < 1) {
      throw Object.assign(new Error("A product in your bag is no longer available at this store."), { statusCode: 400 });
    }
    itemTotalCents += product.price_cents * item.quantity;
    if (!Number.isSafeInteger(itemTotalCents) || itemTotalCents > 999999999) {
      throw Object.assign(new Error("Your bag total is outside the supported checkout limit."), { statusCode: 400 });
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

  if (!Number.isSafeInteger(paypalShippingCents) || paypalShippingCents < 0) {
    throw Object.assign(new Error("The store's PayPal shipping fee is not configured correctly."), { statusCode: 503 });
  }
  const totalCents = itemTotalCents + paypalShippingCents;
  if (!Number.isSafeInteger(totalCents) || totalCents > 999999999) {
    throw Object.assign(new Error("Your bag total is outside the supported checkout limit."), { statusCode: 400 });
  }
  const legalSettings = await readStoreLegalSettings();
  if (missingStoreDetails(legalSettings, legalSettings.complianceConfirmed).length) {
    throw Object.assign(new Error("Checkout is unavailable until the store publishes its seller, shipping, return, and tax policies."), { statusCode: 503 });
  }

  const reference = crypto.randomUUID();
  const order = await paypalRequest("/v2/checkout/orders", {
    method: "POST",
    headers: { "PayPal-Request-Id": reference },
    body: {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: reference,
        custom_id: reference,
        items: lines.map((line) => ({
          name: line.name,
          quantity: String(line.quantity),
          category: "PHYSICAL_GOODS",
          unit_amount: { currency_code: "USD", value: paypalAmount(line.price_cents) },
        })),
        amount: {
          currency_code: "USD",
          value: paypalAmount(totalCents),
          breakdown: {
            item_total: { currency_code: "USD", value: paypalAmount(itemTotalCents) },
            ...(paypalShippingCents > 0
              ? { shipping: { currency_code: "USD", value: paypalAmount(paypalShippingCents) } }
              : {}),
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
  if (typeof order.id !== "string") throw Object.assign(new Error("PayPal did not create an order. Please try again."), { statusCode: 502 });

  await updateOrders((orders) => ({
    orders: [...orders, {
      paypal_order_id: order.id,
      reference,
      status: "CREATED",
      total_cents: totalCents,
      shipping_cents: paypalShippingCents,
      items: lines,
      created_at: new Date().toISOString(),
    }],
    value: undefined,
  }));
  return order.id;
}

async function capturePaypalOrder(orderId) {
  if (!/^[A-Za-z0-9-]{10,80}$/.test(orderId)) {
    throw Object.assign(new Error("That PayPal order could not be found."), { statusCode: 404 });
  }
  const orders = await readOrders();
  const savedOrder = orders.find((order) => order.paypal_order_id === orderId);
  if (!savedOrder) throw Object.assign(new Error("That PayPal order could not be found."), { statusCode: 404 });
  if (savedOrder.status === "COMPLETED") return { status: "COMPLETED" };

  let order = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  if (order.purchase_units?.[0]?.custom_id !== savedOrder.reference) {
    throw Object.assign(new Error("That PayPal order does not match this checkout."), { statusCode: 403 });
  }
  if (order.status === "APPROVED") {
    order = await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST", body: {} });
  }
  if (order.status !== "COMPLETED") {
    throw Object.assign(new Error("PayPal has not approved this payment."), { statusCode: 409 });
  }

  const purchase = order.purchase_units?.[0];
  const capture = purchase?.payments?.captures?.find((payment) => payment.status === "COMPLETED");
  const captureAmount = Math.round(Number(capture?.amount?.value) * 100);
  if (purchase?.custom_id !== savedOrder.reference || capture?.amount?.currency_code !== "USD" ||
    captureAmount !== savedOrder.total_cents) {
    throw Object.assign(new Error("The completed PayPal payment did not match this order."), { statusCode: 502 });
  }

  await updateOrders((currentOrders) => {
    const index = currentOrders.findIndex((item) => item.paypal_order_id === orderId);
    if (index < 0) throw Object.assign(new Error("That PayPal order could not be found."), { statusCode: 404 });
    currentOrders[index] = {
      ...currentOrders[index],
      status: "COMPLETED",
      capture_id: capture.id,
      completed_at: new Date().toISOString(),
    };
    return { orders: currentOrders, value: undefined };
  });
  return { status: "COMPLETED" };
}

async function ownerFromRequest(request) {
  const cookie = request.headers.cookie ?? "";
  const token = cookie.match(new RegExp(`(?:^|;\\s*)${sessionCookie}=([a-f0-9]+)`))?.[1];
  const expiresAt = token && sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  return true;
}

function setSession(response) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + sessionLifetime);
  response.setHeader("Set-Cookie", `${sessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetime / 1000}${production ? "; Secure" : ""}`);
}

function clearSession(request, response) {
  const cookie = request.headers.cookie ?? "";
  const token = cookie.match(new RegExp(`(?:^|;\\s*)${sessionCookie}=([a-f0-9]+)`))?.[1];
  if (token) sessions.delete(token);
  response.setHeader("Set-Cookie", `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${production ? "; Secure" : ""}`);
}

function matchesSetupKey(candidate) {
  if (!ownerSetupKey) return !production;
  if (typeof candidate !== "string") return false;
  const expected = Buffer.from(ownerSetupKey);
  const supplied = Buffer.from(candidate);
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

function publicProduct(product) {
  const { image_file: imageFile, ...visible } = product;
  return { ...visible, image_url: imageFile ? `/uploads/${imageFile}` : null };
}

async function saveImage(dataUrl) {
  if (typeof dataUrl !== "string") throw Object.assign(new Error("Choose a JPG, PNG, WebP, or AVIF image."), { statusCode: 400 });
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp|avif));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw Object.assign(new Error("Choose a JPG, PNG, WebP, or AVIF image."), { statusCode: 400 });
  const mimeType = match[1];
  const image = Buffer.from(match[2], "base64");
  const details = imageTypes[mimeType];
  if (!image.length || image.length > 8 * 1024 * 1024 || !details.matches(image)) {
    throw Object.assign(new Error("That image is invalid or larger than 8 MB."), { statusCode: 400 });
  }
  await fs.promises.mkdir(imageDirectory, { recursive: true, mode: 0o700 });
  const fileName = `${crypto.randomUUID()}.${details.extension}`;
  await fs.promises.writeFile(path.join(imageDirectory, fileName), image, { flag: "wx", mode: 0o600 });
  return fileName;
}

function validateProduct(body) {
  if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80) return "Product name must be 1–80 characters.";
  if (typeof body.description !== "string" || !body.description.trim() || body.description.trim().length > 500) return "Product details must be 1–500 characters.";
  if (!Number.isSafeInteger(body.price_cents) || body.price_cents <= 0) return "Enter a valid product price.";
  if (typeof body.is_published !== "boolean") return "Choose whether the product should be published.";
  return null;
}

async function serveFile(response, file, contentType, cacheControl = "no-cache") {
  try {
    await fs.promises.access(file, fs.constants.R_OK);
    response.writeHead(200, { "Content-Type": contentType, "Cache-Control": cacheControl, "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" });
    fs.createReadStream(file).pipe(response);
  } catch {
    respond(response, 404, { error: "Not found." });
  }
}

async function handleApi(request, response, url) {
  const authenticated = await ownerFromRequest(request);

  if (request.method === "GET" && url.pathname === "/api/paypal/config") {
    const shippingConfigured = Number.isSafeInteger(paypalShippingCents) && paypalShippingCents >= 0;
    const legalSettings = await readStoreLegalSettings();
    const missingDetails = [
      ...missingStoreDetails(legalSettings, legalSettings.complianceConfirmed),
      ...(!paypalClientId ? ["PAYPAL_CLIENT_ID"] : []),
      ...(!paypalClientSecret ? ["PAYPAL_CLIENT_SECRET"] : []),
    ];
    const enabled = paypalIsConfigured() && shippingConfigured && missingDetails.length === 0;
    respond(response, 200, {
      enabled,
      clientId: enabled ? paypalClientId : null,
      shippingCents: enabled ? paypalShippingCents : null,
      environment: paypalEnvironment,
      missingDetails,
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/store/legal") {
    const legalSettings = await readStoreLegalSettings();
    respond(response, 200, {
      businessName: legalSettings.businessName,
      supportEmail: legalSettings.supportEmail,
      postalAddress: legalSettings.postalAddress,
      shippingPolicy: legalSettings.shippingPolicy,
      returnsPolicy: legalSettings.returnsPolicy,
      taxDisclosure: legalSettings.taxDisclosure,
      policyDate: legalSettings.policyDate,
      disclosuresReady: missingStoreDetails(legalSettings, legalSettings.complianceConfirmed).length === 0,
    });
    return true;
  }

  if (url.pathname === "/api/admin/legal-settings") {
    if (!authenticated) { respond(response, 401, { error: "Sign in as the owner to manage seller settings." }); return true; }
    if (request.method === "GET") {
      const settings = await readStoreLegalSettings();
      respond(response, 200, { ...settings, paypalClientIdConfigured: Boolean(paypalClientId), paypalClientSecretConfigured: Boolean(paypalClientSecret) });
      return true;
    }
    if (request.method === "PUT") {
      if (!sameOriginRequest(request)) { respond(response, 403, { error: "Seller settings must be saved from this store." }); return true; }
      const body = await readJson(request);
      const validationError = validateStoreLegalSettings(body);
      if (validationError) { respond(response, 400, { error: validationError }); return true; }
      const details = Object.fromEntries(
        ["businessName", "supportEmail", "postalAddress", "shippingPolicy", "returnsPolicy", "taxDisclosure", "policyDate"]
          .map((key) => [key, body[key].trim()]),
      );
      await fs.promises.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      await writeJson(legalSettingsFile, { details, complianceConfirmed: body.complianceConfirmed, updated_at: new Date().toISOString() });
      const missingDetails = [
        ...missingStoreDetails({ ...details }, body.complianceConfirmed),
        ...(!paypalClientId ? ["PAYPAL_CLIENT_ID"] : []),
        ...(!paypalClientSecret ? ["PAYPAL_CLIENT_SECRET"] : []),
      ];
      respond(response, 200, { saved: true, checkoutReady: paypalIsConfigured() && missingDetails.length === 0, missingDetails });
      return true;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/paypal/orders") {
    if (!sameOriginRequest(request)) { respond(response, 403, { error: "PayPal checkout must be started from this store." }); return true; }
    if (!paypalIsConfigured()) { respond(response, 503, { error: "PayPal checkout is not configured on this store yet." }); return true; }
    const body = await readJson(request);
    const orderId = await createPaypalOrder(body);
    respond(response, 201, { id: orderId });
    return true;
  }

  const captureMatch = url.pathname.match(/^\/api\/paypal\/orders\/([^/]+)\/capture$/);
  if (request.method === "POST" && captureMatch) {
    if (!sameOriginRequest(request)) { respond(response, 403, { error: "PayPal payments must be confirmed from this store." }); return true; }
    if (!paypalIsConfigured()) { respond(response, 503, { error: "PayPal checkout is not configured on this store yet." }); return true; }
    const result = await capturePaypalOrder(decodeURIComponent(captureMatch[1]));
    respond(response, 200, result);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/session") {
    let setupRequired = false;
    try { await fs.promises.access(authFile); } catch { setupRequired = true; }
    respond(response, 200, { setupRequired, authenticated, setupRequiresKey: production });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/setup") {
    let exists = false;
    try { await fs.promises.access(authFile); exists = true; } catch {}
    if (exists) { respond(response, 409, { error: "Owner setup is already complete. Sign in instead." }); return true; }
    const body = await readJson(request);
    if (!matchesSetupKey(body.setupKey)) { respond(response, 403, { error: "The owner setup key is missing or incorrect." }); return true; }
    if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 128) {
      respond(response, 400, { error: "Set a password between 12 and 128 characters." });
      return true;
    }
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(body.password, salt, 64);
    await fs.promises.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(authFile, JSON.stringify({ salt: salt.toString("hex"), hash: hash.toString("hex") }), { flag: "wx", mode: 0o600 });
    setSession(response);
    respond(response, 201, { authenticated: true });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/login") {
    let saved;
    try { saved = JSON.parse(await fs.promises.readFile(authFile, "utf8")); } catch { respond(response, 409, { error: "Set up your owner password first." }); return true; }
    const body = await readJson(request);
    if (typeof body.password !== "string" || body.password.length > 128) { respond(response, 400, { error: "Enter your owner password." }); return true; }
    const candidate = await scrypt(body.password, Buffer.from(saved.salt, "hex"), 64);
    if (!crypto.timingSafeEqual(candidate, Buffer.from(saved.hash, "hex"))) { respond(response, 401, { error: "That password did not match." }); return true; }
    setSession(response);
    respond(response, 200, { authenticated: true });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/logout") {
    clearSession(request, response);
    respond(response, 200, { authenticated: false });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/products") {
    const products = (await readProducts()).filter((product) => product.is_published).sort((a, b) => b.created_at.localeCompare(a.created_at));
    respond(response, 200, products.map(publicProduct));
    return true;
  }

  if (url.pathname === "/api/admin/products" || url.pathname.startsWith("/api/admin/products/")) {
    if (!authenticated) { respond(response, 401, { error: "Sign in as the owner to manage products." }); return true; }
    let products = await readProducts();
    if (request.method === "GET" && url.pathname === "/api/admin/products") {
      products.sort((a, b) => b.created_at.localeCompare(a.created_at));
      respond(response, 200, products.map(publicProduct));
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/admin/products") {
      const body = await readJson(request);
      const validationError = validateProduct(body);
      if (validationError) { respond(response, 400, { error: validationError }); return true; }
      const imageFile = body.image_data ? await saveImage(body.image_data) : null;
      const product = { id: crypto.randomUUID(), name: body.name.trim(), description: body.description.trim(), price_cents: body.price_cents, image_file: imageFile, is_published: body.is_published, created_at: new Date().toISOString() };
      try { await writeJson(productsFile, [...products, product]); } catch (error) { if (imageFile) await fs.promises.rm(path.join(imageDirectory, imageFile), { force: true }); throw error; }
      respond(response, 201, publicProduct(product));
      return true;
    }

    const productId = url.pathname.slice("/api/admin/products/".length);
    const productIndex = products.findIndex((product) => product.id === productId);
    if (productIndex < 0) { respond(response, 404, { error: "Product not found." }); return true; }
    const existing = products[productIndex];
    if (request.method === "PUT") {
      const body = await readJson(request);
      const validationError = validateProduct(body);
      if (validationError) { respond(response, 400, { error: validationError }); return true; }
      const imageFile = body.image_data ? await saveImage(body.image_data) : existing.image_file;
      const product = { ...existing, name: body.name.trim(), description: body.description.trim(), price_cents: body.price_cents, image_file: imageFile, is_published: body.is_published };
      products[productIndex] = product;
      try { await writeJson(productsFile, products); } catch (error) { if (imageFile !== existing.image_file && imageFile) await fs.promises.rm(path.join(imageDirectory, imageFile), { force: true }); throw error; }
      if (existing.image_file && existing.image_file !== imageFile) await fs.promises.rm(path.join(imageDirectory, existing.image_file), { force: true });
      respond(response, 200, publicProduct(product));
      return true;
    }
    if (request.method === "DELETE") {
      products.splice(productIndex, 1);
      await writeJson(productsFile, products);
      if (existing.image_file) await fs.promises.rm(path.join(imageDirectory, existing.image_file), { force: true });
      respond(response, 200, { deleted: true });
      return true;
    }
  }
  return false;
}

const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
const allowedFiles = new Set(["index.html", "admin.html", "legal.html", "app.js", "admin.js", "install.js", "legal.js", "styles.css", "supabase-config.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"]);
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      if (await handleApi(request, response, url)) return;
      respond(response, 404, { error: "Not found." });
      return;
    }
    if (url.pathname.startsWith("/uploads/")) {
      const fileName = decodeURIComponent(url.pathname.slice("/uploads/".length));
      if (!/^[a-f0-9-]+\.(jpg|png|webp|avif)$/.test(fileName)) { respond(response, 404, { error: "Not found." }); return; }
      const products = await readProducts();
      const product = products.find((item) => item.image_file === fileName);
      if (!product || (!product.is_published && !(await ownerFromRequest(request)))) { respond(response, 404, { error: "Not found." }); return; }
      const extension = path.extname(fileName);
      const type = Object.entries(imageTypes).find(([, value]) => `.${value.extension}` === extension)?.[0];
      await serveFile(response, path.join(imageDirectory, fileName), type, "private, max-age=3600");
      return;
    }

    const pathname = decodeURIComponent(url.pathname);
    const fileName = pathname === "/" ? "index.html" : pathname.slice(1);
    const file = path.resolve(root, fileName);
    if (path.dirname(file) !== root || !allowedFiles.has(fileName)) { respond(response, 404, { error: "Not found." }); return; }
    await serveFile(response, file, contentTypes[path.extname(file)] ?? "application/octet-stream");
  } catch (error) {
    if (!response.headersSent) respond(response, error.statusCode ?? 500, { error: error.statusCode ? error.message : "The local store could not complete that request." });
    else response.destroy();
  }
});

server.listen(Number(process.env.PORT) || 8000, production ? "0.0.0.0" : "127.0.0.1", () => {
  const address = server.address();
  console.log(`Timber & Tackle local store: http://localhost:${address.port}`);
  console.log("Owner photos and catalog data stay in the ignored .local-store/ folder.");
});
