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
let paypalInitialized = false;
let paypalCheckoutItemIds = [];

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
  addToCart({ product_id: "boundary-sign", message: "NO TRESPASSING", size: "12 × 18 in", color: selectedColor, price: signPrice });
});
document.querySelector("#open-bag").addEventListener("click", () => {
  bagDialog.showModal();
  if (cart.length) configurePaypal();
});
document.querySelector("#close-bag").addEventListener("click", () => bagDialog.close());
document.querySelector("#shop-now").addEventListener("click", () => {
  bagDialog.close();
  document.querySelector("#shop").scrollIntoView({ behavior: "smooth" });
});
bagDialog.addEventListener("click", (event) => {
  if (event.target === bagDialog) bagDialog.close();
});
function setCheckoutStatus(message, isError = false) {
  const status = document.querySelector("#checkout-note");
  status.textContent = message;
  status.dataset.error = String(isError);
}

function paypalCartItems() {
  return cart.map((item) => {
    const productId = item.product_id || (item.message === "NO TRESPASSING" ? "boundary-sign" : null);
    if (!productId) throw new Error("Remove and re-add older catalog items before checking out.");
    return {
      product_id: productId,
      quantity: item.quantity,
      color: productId === "boundary-sign" ? item.color.toLowerCase() : undefined,
    };
  });
}

async function configurePaypal() {
  if (paypalInitialized) return;
  paypalInitialized = true;
  try {
    const response = await fetch("/api/paypal/config", { cache: "no-store" });
    if (!response.ok) throw new Error("PayPal settings could not be loaded.");
    const config = await response.json();
    if (!config.enabled) {
      setCheckoutStatus(config.missingDetails?.length
        ? "Checkout is unavailable until the owner publishes a legal business name, mailing address, support email, shipping and return policies, tax disclosure, and compliance confirmation."
        : "PayPal is not connected yet. The owner must add PayPal app credentials before taking payments.", true);
      return;
    }

    const script = document.createElement("script");
    script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.clientId)}&currency=USD&intent=capture&components=buttons`;
    script.async = true;
    script.addEventListener("error", () => setCheckoutStatus("PayPal checkout could not load. Please try again later.", true), { once: true });
    script.addEventListener("load", async () => {
      if (!window.paypal) {
        setCheckoutStatus("PayPal checkout could not load. Please try again later.", true);
        return;
      }
      try {
        await window.paypal.Buttons({
          style: { layout: "vertical", color: "gold", shape: "rect", label: "paypal" },
          createOrder: async () => {
            if (!document.querySelector("#accept-store-terms").checked) {
              throw new Error("Please agree to the store terms and review its privacy notice before continuing.");
            }
            let items;
            try {
              items = paypalCartItems();
            } catch (error) {
              setCheckoutStatus(error.message, true);
              throw error;
            }
            const result = await fetch("/api/paypal/orders", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ items }),
            });
            const order = await result.json();
            if (!result.ok) throw new Error(order.error || "PayPal could not start checkout.");
            paypalCheckoutItemIds = cart.map((item) => item.id);
            return order.id;
          },
          onInit: (_data, actions) => {
            const consent = document.querySelector("#accept-store-terms");
            const syncConsent = () => consent.checked ? actions.enable() : actions.disable();
            syncConsent();
            consent.addEventListener("change", syncConsent);
          },
          onApprove: async (details) => {
            const result = await fetch(`/api/paypal/orders/${encodeURIComponent(details.orderID)}/capture`, { method: "POST" });
            const capture = await result.json();
            if (!result.ok || capture.status !== "COMPLETED") throw new Error(capture.error || "PayPal could not confirm payment.");
            cart = cart.filter((item) => !paypalCheckoutItemIds.includes(item.id));
            paypalCheckoutItemIds = [];
            saveCart();
            renderCart();
            bagDialog.close();
            showToast("Payment received. Your PayPal receipt has the order details.");
          },
          onCancel: () => setCheckoutStatus("Checkout was cancelled. No payment was confirmed."),
          onError: () => {
            setCheckoutStatus("PayPal could not complete checkout. If PayPal shows a receipt, the payment was received.", true);
            showToast("PayPal checkout needs attention.");
          },
        }).render("#paypal-button-container");
        const shipping = config.shippingCents > 0
          ? ` A ${formatPrice(config.shippingCents)} flat shipping fee will be added.`
          : " No online shipping fee is configured.";
        const mode = config.environment === "sandbox" ? " PayPal sandbox test mode is active." : "";
        setCheckoutStatus(`PayPal checkout is ready.${shipping} Applicable taxes are not included.${mode}`);
      } catch {
        setCheckoutStatus("PayPal checkout could not initialize. Please try again later.", true);
      }
    }, { once: true });
    document.head.append(script);
  } catch {
    setCheckoutStatus("PayPal checkout is currently unavailable. Please try again later.", true);
  }
}

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
    add.addEventListener("click", () => addToCart({ product_id: product.id, message: product.name, size: "Standard", color: "As shown", price: product.price_cents / 100 }));
    copy.append(top, description, add);
    card.append(image, copy);
    grid.append(card);
  }
}

document.querySelector("#year").textContent = String(new Date().getFullYear());
updatePreview();
renderCart();
loadProducts();