const config = window.STORE_CONFIG;
const useSupabase = window.supabase && config && !config.url.includes("YOUR_") && !config.anonKey.includes("YOUR_");
const setupStatus = document.querySelector("#setup-status");
const loginPanel = document.querySelector("#login-panel");
const loginStatus = document.querySelector("#login-status");
const dashboard = document.querySelector("#dashboard");
const productForm = document.querySelector("#product-form");
const productStatus = document.querySelector("#product-status");
const productList = document.querySelector("#product-list");
const imageInput = document.querySelector("#product-image");
const imagePreview = document.querySelector("#image-preview");
const uploadBox = document.querySelector("#upload-box");
const localLoginForm = document.querySelector("#local-login-form");
const localSetupForm = document.querySelector("#local-setup-form");
const sellerSettingsPanel = document.querySelector("#seller-settings-panel");
const sellerSettingsForm = document.querySelector("#seller-settings-form");
const sellerSettingsStatus = document.querySelector("#seller-settings-status");
const sellerPaypalStatus = document.querySelector("#seller-paypal-status");
let client;
let previewUrl;
let editingProduct;

function setStatus(element, message, isError = false) {
  element.textContent = message;
  element.dataset.error = String(isError);
}

async function localRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The local store could not complete that request.");
  return result;
}

function resetForm() {
  productForm.reset();
  document.querySelector("#product-published").checked = true;
  document.querySelector("#editor-title").textContent = "ADD A PRODUCT";
  document.querySelector("#save-product").textContent = "SAVE PRODUCT";
  document.querySelector("#cancel-edit").classList.add("admin-hidden");
  imagePreview.classList.add("admin-hidden");
  imagePreview.removeAttribute("src");
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = undefined;
  editingProduct = undefined;
}

function showDashboard(ownerName) {
  loginPanel.classList.add("admin-hidden");
  dashboard.classList.remove("admin-hidden");
  document.querySelector("#owner-label").textContent = ownerName;
  loadOwnerProducts();
  if (!useSupabase) loadSellerSettings();
}

async function loadSellerSettings() {
  try {
    const settings = await localRequest("/api/admin/legal-settings");
    document.querySelector("#legal-business-name").value = settings.businessName;
    document.querySelector("#legal-support-email").value = settings.supportEmail;
    document.querySelector("#legal-postal-address").value = settings.postalAddress;
    document.querySelector("#legal-shipping-policy").value = settings.shippingPolicy;
    document.querySelector("#legal-returns-policy").value = settings.returnsPolicy;
    document.querySelector("#legal-tax-disclosure").value = settings.taxDisclosure;
    document.querySelector("#legal-policy-date").value = settings.policyDate;
    document.querySelector("#legal-compliance-confirmed").checked = settings.complianceConfirmed;
    sellerPaypalStatus.textContent = `PayPal Client ID: ${settings.paypalClientIdConfigured ? "configured" : "missing"} · PayPal Secret: ${settings.paypalClientSecretConfigured ? "configured" : "missing"}. Credentials are managed in the server environment, not in this form.`;
  } catch (error) {
    setStatus(sellerSettingsStatus, `Could not load seller settings: ${error.message}`, true);
  }
}

sellerSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const saveButton = document.querySelector("#save-seller-settings");
  saveButton.disabled = true;
  setStatus(sellerSettingsStatus, "Saving seller settings…");
  const settings = {
    businessName: document.querySelector("#legal-business-name").value.trim(),
    supportEmail: document.querySelector("#legal-support-email").value.trim(),
    postalAddress: document.querySelector("#legal-postal-address").value.trim(),
    shippingPolicy: document.querySelector("#legal-shipping-policy").value.trim(),
    returnsPolicy: document.querySelector("#legal-returns-policy").value.trim(),
    taxDisclosure: document.querySelector("#legal-tax-disclosure").value.trim(),
    policyDate: document.querySelector("#legal-policy-date").value,
    complianceConfirmed: document.querySelector("#legal-compliance-confirmed").checked,
  };
  try {
    const result = await localRequest("/api/admin/legal-settings", { method: "PUT", body: JSON.stringify(settings) });
    setStatus(sellerSettingsStatus, result.checkoutReady
      ? "Seller settings saved. PayPal checkout is ready in the configured environment."
      : `Seller settings saved. PayPal checkout stays disabled: ${result.missingDetails.join(", ")}.`);
    await loadSellerSettings();
  } catch (error) {
    setStatus(sellerSettingsStatus, `Seller settings could not be saved: ${error.message}`, true);
  } finally {
    saveButton.disabled = false;
  }
});

function syncSupabaseAuth(session) {
  if (session?.user) showDashboard(session.user.email);
  else {
    dashboard.classList.add("admin-hidden");
    loginPanel.classList.remove("admin-hidden");
  }
}

function syncLocalAuth(authenticated) {
  if (authenticated) showDashboard("Local owner");
  else {
    dashboard.classList.add("admin-hidden");
    loginPanel.classList.remove("admin-hidden");
  }
}

async function productImage(product) {
  if (product.image_url) return product.image_url;
  if (product.image_path && client) {
    const { data } = await client.storage.from("product-images").createSignedUrl(product.image_path, 3600);
    return data?.signedUrl ?? "";
  }
  return "";
}

async function loadOwnerProducts() {
  let products;
  if (useSupabase) {
    const { data, error } = await client.from("products").select("id,name,description,price_cents,image_path,is_published,created_at").order("created_at", { ascending: false });
    if (error) {
      setStatus(productStatus, "Could not load products. Check the Supabase setup and owner policies.", true);
      return;
    }
    products = data;
  } else {
    try {
      products = await localRequest("/api/admin/products");
    } catch (error) {
      setStatus(productStatus, error.message, true);
      return;
    }
  }

  document.querySelector("#product-count").textContent = `${products.length} ${products.length === 1 ? "product" : "products"}`;
  productList.replaceChildren();
  if (!products.length) {
    const empty = document.createElement("p");
    empty.className = "admin-help";
    empty.textContent = "Your catalog is empty. Add your first sign above.";
    productList.append(empty);
  }
  for (const product of products) productList.append(await createProductRow(product));
}

async function createProductRow(product) {
  const row = document.createElement("article");
  row.className = "admin-product";
  const imageUrl = await productImage(product);
  if (imageUrl) {
    const image = document.createElement("img");
    image.src = imageUrl;
    image.alt = product.name;
    image.loading = "lazy";
    row.append(image);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "admin-product-placeholder";
    placeholder.textContent = "NO PHOTO";
    row.append(placeholder);
  }
  const content = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = product.name;
  const description = document.createElement("p");
  description.textContent = product.description;
  const meta = document.createElement("div");
  meta.className = "admin-product-meta";
  meta.textContent = `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(product.price_cents / 100)} · ${product.is_published ? "LIVE IN STORE" : "HIDDEN"}`;
  const actions = document.createElement("div");
  actions.className = "admin-product-actions";
  const edit = document.createElement("button");
  edit.className = "admin-secondary";
  edit.type = "button";
  edit.textContent = "EDIT";
  edit.addEventListener("click", () => startEdit(product));
  const remove = document.createElement("button");
  remove.className = "admin-danger";
  remove.type = "button";
  remove.textContent = "DELETE";
  remove.addEventListener("click", () => deleteProduct(product));
  actions.append(edit, remove);
  content.append(title, description, meta, actions);
  row.append(content);
  return row;
}

async function startEdit(product) {
  editingProduct = product;
  document.querySelector("#product-name").value = product.name;
  document.querySelector("#product-price").value = (product.price_cents / 100).toFixed(2);
  document.querySelector("#product-description").value = product.description;
  document.querySelector("#product-published").checked = product.is_published;
  document.querySelector("#editor-title").textContent = "EDIT PRODUCT";
  document.querySelector("#save-product").textContent = "SAVE CHANGES";
  document.querySelector("#cancel-edit").classList.remove("admin-hidden");
  imagePreview.classList.add("admin-hidden");
  const imageUrl = await productImage(product);
  if (imageUrl) {
    imagePreview.src = imageUrl;
    imagePreview.classList.remove("admin-hidden");
  }
  productForm.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function deleteProduct(product) {
  if (!window.confirm(`Delete “${product.name}” from your shop?`)) return;
  try {
    if (useSupabase) {
      const { error } = await client.from("products").delete().eq("id", product.id);
      if (error) throw error;
      if (product.image_path) await client.storage.from("product-images").remove([product.image_path]);
    } else {
      await localRequest(`/api/admin/products/${product.id}`, { method: "DELETE" });
    }
    setStatus(productStatus, "Product deleted.");
    await loadOwnerProducts();
  } catch (error) {
    setStatus(productStatus, `Product could not be deleted: ${error.message}`, true);
  }
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(new Error("Could not read that photo.")));
    reader.readAsDataURL(file);
  });
}

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus(loginStatus, "Sending secure sign-in link…");
  const email = document.querySelector("#owner-email").value.trim();
  const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}`, shouldCreateUser: false } });
  setStatus(loginStatus, error ? error.message : "Check your email for a secure sign-in link.", Boolean(error));
});

localSetupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.querySelector("#setup-password").value;
  if (password !== document.querySelector("#confirm-password").value) {
    setStatus(loginStatus, "The passwords do not match.", true);
    return;
  }
  try {
    const setupKey = document.querySelector("#owner-setup-key").value;
    await localRequest("/api/setup", { method: "POST", body: JSON.stringify({ password, setupKey }) });
    localSetupForm.reset();
    setStatus(setupStatus, "Owner login created. Keep your password private.");
    showDashboard("Local owner");
  } catch (error) {
    setStatus(loginStatus, error.message, true);
  }
});

localLoginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await localRequest("/api/login", { method: "POST", body: JSON.stringify({ password: document.querySelector("#local-password").value }) });
    localLoginForm.reset();
    setStatus(loginStatus, "");
    showDashboard("Local owner");
  } catch (error) {
    setStatus(loginStatus, error.message, true);
  }
});

document.querySelector("#sign-out").addEventListener("click", async () => {
  try {
    if (useSupabase) await client.auth.signOut();
    else await localRequest("/api/logout", { method: "POST" });
    resetForm();
    if (useSupabase) syncSupabaseAuth(null);
    else syncLocalAuth(false);
  } catch (error) {
    setStatus(productStatus, error.message, true);
  }
});

document.querySelector("#cancel-edit").addEventListener("click", resetForm);

function previewImage(file) {
  if (!file) return;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  imagePreview.src = previewUrl;
  imagePreview.classList.remove("admin-hidden");
}

imageInput.addEventListener("change", () => {
  previewImage(imageInput.files[0]);
});

for (const eventName of ["dragenter", "dragover"]) {
  uploadBox.addEventListener(eventName, (event) => {
    event.preventDefault();
    uploadBox.classList.add("is-dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  uploadBox.addEventListener(eventName, (event) => {
    event.preventDefault();
    uploadBox.classList.remove("is-dragging");
  });
}

uploadBox.addEventListener("drop", (event) => {
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const files = new DataTransfer();
  files.items.add(file);
  imageInput.files = files.files;
  previewImage(file);
});

productForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const saveButton = document.querySelector("#save-product");
  saveButton.disabled = true;
  setStatus(productStatus, "Saving product and photo…");
  const name = document.querySelector("#product-name").value.trim();
  const description = document.querySelector("#product-description").value.trim();
  const priceCents = Math.round(Number(document.querySelector("#product-price").value) * 100);
  const imageFile = imageInput.files[0];
  const isPublished = document.querySelector("#product-published").checked;
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) {
    setStatus(productStatus, "Enter a valid price greater than zero.", true);
    saveButton.disabled = false;
    return;
  }
  const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/avif"];
  if (imageFile && (!allowedTypes.includes(imageFile.type) || imageFile.size > 8 * 1024 * 1024)) {
    setStatus(productStatus, "Choose a JPG, PNG, WebP, or AVIF image under 8 MB.", true);
    saveButton.disabled = false;
    return;
  }

  try {
    if (useSupabase) {
      let imagePath = editingProduct?.image_path ?? null;
      let uploadedPath;
      if (imageFile) {
        const extension = imageFile.name.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "");
        uploadedPath = `${crypto.randomUUID()}.${extension}`;
        const { error: uploadError } = await client.storage.from("product-images").upload(uploadedPath, imageFile, { cacheControl: "3600", upsert: false, contentType: imageFile.type });
        if (uploadError) throw uploadError;
        imagePath = uploadedPath;
      }
      const values = { name, description, price_cents: priceCents, image_path: imagePath, is_published: isPublished };
      const query = editingProduct
        ? client.from("products").update(values).eq("id", editingProduct.id)
        : client.from("products").insert(values);
      const { error } = await query;
      if (error) {
        if (uploadedPath) await client.storage.from("product-images").remove([uploadedPath]);
        throw error;
      }
      if (uploadedPath && editingProduct?.image_path) await client.storage.from("product-images").remove([editingProduct.image_path]);
    } else {
      const values = { name, description, price_cents: priceCents, is_published: isPublished, image_data: imageFile ? await fileAsDataUrl(imageFile) : null };
      const productPath = editingProduct ? `/api/admin/products/${editingProduct.id}` : "/api/admin/products";
      await localRequest(productPath, { method: editingProduct ? "PUT" : "POST", body: JSON.stringify(values) });
    }
    setStatus(productStatus, editingProduct ? "Product updated." : "Product added to your catalog.");
    resetForm();
    await loadOwnerProducts();
  } catch (error) {
    setStatus(productStatus, `Could not save product: ${error.message}`, true);
  } finally {
    saveButton.disabled = false;
  }
});

async function initialize() {
  const supabaseLogin = document.querySelector("#login-form");
  if (useSupabase) {
    sellerSettingsPanel.classList.add("admin-hidden");
    localLoginForm.classList.add("admin-hidden");
    localSetupForm.classList.add("admin-hidden");
    supabaseLogin.classList.remove("admin-hidden");
    document.querySelector("#login-help").textContent = "Editing is restricted to the verified owner email in your Supabase project.";
    client = window.supabase.createClient(config.url, config.anonKey);
    client.auth.onAuthStateChange((_event, session) => syncSupabaseAuth(session));
    const { data } = await client.auth.getSession();
    syncSupabaseAuth(data.session);
    return;
  }

  supabaseLogin.classList.add("admin-hidden");
  sellerSettingsPanel.classList.remove("admin-hidden");
  document.querySelector("#login-help").textContent = "Your local catalog and product photos stay in this project's ignored data folder.";
  try {
    const session = await localRequest("/api/session");
    if (session.authenticated) {
      syncLocalAuth(true);
    } else if (session.setupRequired) {
      document.querySelector("#login-title").textContent = "CREATE OWNER LOGIN";
      document.querySelector("#login-copy").textContent = session.setupRequiresKey
        ? "Enter the one-time key from your Render service settings, then create your private owner password."
        : "Set the private password you’ll use to manage product details and photos.";
      document.querySelector("#setup-key-field").classList.toggle("admin-hidden", !session.setupRequiresKey);
      document.querySelector("#owner-setup-key").required = session.setupRequiresKey;
      localSetupForm.classList.remove("admin-hidden");
      localLoginForm.classList.add("admin-hidden");
    } else {
      document.querySelector("#login-title").textContent = "OWNER SIGN-IN";
      document.querySelector("#login-copy").textContent = "Enter your local owner password to manage product details and photos.";
      localSetupForm.classList.add("admin-hidden");
      localLoginForm.classList.remove("admin-hidden");
    }
  } catch {
    setStatus(setupStatus, "Start the local store with `node server.js` to upload product photos.", true);
    setStatus(loginStatus, "The owner dashboard needs its local store server.", true);
  }
}

initialize();