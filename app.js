const colorButtons = [...document.querySelectorAll(".color-option")];
const previewSign = document.querySelector("#preview-sign");
const priceLabel = document.querySelector("#sign-price");
const bagDialog = document.querySelector("#bag-dialog");
const bagItems = document.querySelector("#bag-items");
const bagCount = document.querySelector("#bag-count");
const dialogCount = document.querySelector("#dialog-count");
const bagEmpty = document.querySelector("#bag-empty");
const bagSummary = document.querySelector("#bag-summary");
const toast = document.querySelector("#toast");

const signPrice = 18;
let selectedColor = "yellow";
let cart = loadCart();
let toastTimeout;

function loadCart() {
  try {
    const saved = JSON.parse(localStorage.getItem("timber-tackle-cart") || "[]");
    return Array.isArray(saved) ? saved.filter((item) => item && typeof item.id === "string" && Number.isFinite(item.price)) : [];
  } catch {
    return [];
  }
}

function saveCart() {
  try {
    localStorage.setItem("timber-tackle-cart", JSON.stringify(cart));
  } catch {
    showToast("Your bag is available for this visit only.");
  }
}

function formatPrice(amount) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(amount);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function updatePreview() {
  previewSign.dataset.color = selectedColor;
  priceLabel.textContent = formatPrice(signPrice);
}

function addToCart(item) {
  cart.push({ id: crypto.randomUUID(), quantity: 1, ...item });
  saveCart();
  renderCart();
  showToast("Added to your bag.");
}

function renderCart() {
  const count = cart.reduce((total, item) => total + item.quantity, 0);
  bagCount.textContent = String(count);
  bagCount.setAttribute("aria-label", `${count} items in bag`);
  dialogCount.textContent = ` (${count})`;
  bagItems.replaceChildren();

  for (const item of cart) {
    const row = document.createElement("article");
    row.className = "bag-item";
    const details = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = item.message;
    const description = document.createElement("p");
    description.textContent = `${item.size ? `${item.size} · ` : ""}${item.color} · Qty ${item.quantity}`;
    details.append(title, description);

    const actions = document.createElement("div");
    actions.className = "bag-item-price";
    const price = document.createElement("b");
    price.textContent = formatPrice(item.price * item.quantity);
    const remove = document.createElement("button");
    remove.className = "remove-item";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${item.message} from bag`);
    remove.addEventListener("click", () => {
      cart = cart.filter((cartItem) => cartItem.id !== item.id);
      saveCart();
      renderCart();
    });
    actions.append(price, remove);
    row.append(details, actions);
    bagItems.append(row);
  }

  const subtotal = cart.reduce((total, item) => total + item.price * item.quantity, 0);
  document.querySelector("#bag-subtotal").textContent = formatPrice(subtotal);
  bagEmpty.hidden = count > 0;
  bagSummary.hidden = count === 0;
}

for (const button of colorButtons) {
  button.addEventListener("click", () => {
    selectedColor = button.dataset.color;
    for (const option of colorButtons) option.setAttribute("aria-pressed", String(option === button));
    updatePreview();
  });
}

document.querySelector("#sign-form").addEventListener("submit", (event) => {
  event.preventDefault();
  addToCart({ message: "NO TRESPASSING", size: "12 × 18 in", color: selectedColor, price: signPrice });
});
document.querySelector("#open-bag").addEventListener("click", () => bagDialog.showModal());
document.querySelector("#close-bag").addEventListener("click", () => bagDialog.close());
document.querySelector("#shop-now").addEventListener("click", () => {
  bagDialog.close();
  document.querySelector("#shop").scrollIntoView({ behavior: "smooth" });
});
bagDialog.addEventListener("click", (event) => {
  if (event.target === bagDialog) bagDialog.close();
});
document.querySelector("#request-order").addEventListener("click", async () => {
  const lines = cart.map((item) => `${item.quantity} × ${item.message} — ${item.size ? `${item.size}, ` : ""}${item.color}, ${formatPrice(item.price * item.quantity)}`);
  lines.push(`Subtotal: ${formatPrice(cart.reduce((total, item) => total + item.price * item.quantity, 0))}`);
  try {
    await navigator.clipboard.writeText(`Timber & Tackle Supply order request\n${lines.join("\n")}`);
    showToast("Order summary copied. Payment is not connected yet.");
  } catch {
    showToast("Copy unavailable. Please note the items in your bag.");
  }
});

async function loadProducts() {
  const status = document.querySelector("#catalog-status");
  const grid = document.querySelector("#catalog-grid");
  const config = window.STORE_CONFIG;
  const useSupabase = window.supabase && config && !config.url.includes("YOUR_") && !config.anonKey.includes("YOUR_");
  let client;
  let data;
  if (useSupabase) {
    client = window.supabase.createClient(config.url, config.anonKey);
    const result = await client.from("products").select("id,name,description,price_cents,image_path").eq("is_published", true).order("created_at", { ascending: false });
    if (result.error) {
      status.textContent = "Our sign catalog is temporarily unavailable.";
      return;
    }
    data = result.data;
  } else {
    try {
      const response = await fetch("/api/products");
      if (!response.ok) throw new Error("Local store not running");
      data = await response.json();
    } catch {
      status.textContent = "Start the local store to see available signs.";
      return;
    }
  }

  status.hidden = data.length > 0;
  if (!data.length) {
    status.textContent = "More signs are on the way.";
    status.hidden = false;
    return;
  }

  for (const product of data) {
    const card = document.createElement("article");
    card.className = "product-card";
    let image;
    if (product.image_url || product.image_path) {
      image = document.createElement("img");
      image.className = "product-image";
      if (product.image_url) {
        image.src = product.image_url;
      } else {
        const { data: signedImage } = await client.storage.from("product-images").createSignedUrl(product.image_path, 3600);
        image.src = signedImage?.signedUrl ?? "";
      }
      image.alt = product.name;
      image.loading = "lazy";
    } else {
      image = document.createElement("div");
      image.className = "product-image";
      const fallback = document.createElement("div");
      fallback.className = "product-fallback";
      fallback.textContent = product.name;
      image.append(fallback);
    }
    const copy = document.createElement("div");
    copy.className = "product-card-copy";
    const top = document.createElement("div");
    top.className = "product-card-top";
    const name = document.createElement("h3");
    name.textContent = product.name;
    const price = document.createElement("span");
    price.className = "product-card-price";
    price.textContent = formatPrice(product.price_cents / 100);
    top.append(name, price);
    const description = document.createElement("p");
    description.textContent = product.description;
    const add = document.createElement("button");
    add.className = "catalog-add";
    add.type = "button";
    add.textContent = "ADD TO BAG +";
    add.addEventListener("click", () => addToCart({ message: product.name, size: "Standard", color: "As shown", price: product.price_cents / 100 }));
    copy.append(top, description, add);
    card.append(image, copy);
    grid.append(card);
  }
}

document.querySelector("#year").textContent = String(new Date().getFullYear());
updatePreview();
renderCart();
loadProducts();