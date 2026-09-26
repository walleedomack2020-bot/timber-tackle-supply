const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const root = __dirname;
const dataDirectory = path.resolve(process.env.STORE_DATA_DIR || path.join(root, ".local-store"));
const imageDirectory = path.join(dataDirectory, "images");
const authFile = path.join(dataDirectory, "owner.json");
const productsFile = path.join(dataDirectory, "products.json");
const sessionCookie = "timber_owner_session";
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const production = process.env.NODE_ENV === "production";
const ownerSetupKey = process.env.OWNER_SETUP_KEY;
if (production && (!ownerSetupKey || ownerSetupKey.length < 32)) {
  throw new Error("Set OWNER_SETUP_KEY to a random value of at least 32 characters before running in production.");
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
const allowedFiles = new Set(["index.html", "admin.html", "app.js", "admin.js", "styles.css", "supabase-config.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"]);
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