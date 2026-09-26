const readiness = document.querySelector("#policy-readiness");
const fields = {
  businessName: document.querySelector("#legal-business-name"),
  postalAddress: document.querySelector("#legal-postal-address"),
  supportEmail: document.querySelector("#legal-support-email"),
  policyDate: document.querySelector("#legal-policy-date"),
  shippingPolicy: document.querySelector("#legal-shipping-policy"),
  returnsPolicy: document.querySelector("#legal-returns-policy"),
};
const emailLinks = [...document.querySelectorAll(".legal-email-link")];

async function loadStorePolicies() {
  try {
    const response = await fetch("/api/store/legal", { cache: "no-store" });
    if (!response.ok) throw new Error("Store policies could not be loaded.");
    const details = await response.json();
    fields.businessName.textContent = details.businessName || "Seller has not published its legal business name.";
    fields.postalAddress.textContent = details.postalAddress || "Seller has not published a business mailing address.";
    fields.supportEmail.textContent = details.supportEmail || "Seller has not published a customer-support email.";
    fields.policyDate.textContent = details.policyDate || "Seller has not published an effective date.";
    fields.shippingPolicy.textContent = details.shippingPolicy || "Shipping costs and delivery timings have not been published by the seller.";
    fields.returnsPolicy.textContent = details.returnsPolicy || "The seller has not published its cancellation, return, or refund terms.";
    if (details.supportEmail) {
      fields.supportEmail.href = `mailto:${details.supportEmail}`;
      for (const link of emailLinks) {
        link.href = `mailto:${details.supportEmail}`;
        link.textContent = details.supportEmail;
      }
    } else {
      fields.supportEmail.removeAttribute("href");
      for (const link of emailLinks) link.textContent = "the seller (contact details are not configured)";
    }
    document.querySelector("#legal-tax-policy").textContent = details.taxDisclosure || "The seller has not published a sales-tax disclosure.";
    if (details.disclosuresReady) {
      readiness.textContent = "Seller details and checkout policy settings are published. Contact the seller with questions before ordering.";
      readiness.classList.add("is-ready");
    } else {
      readiness.textContent = "Seller details or checkout policies are incomplete. PayPal checkout is unavailable until the seller publishes them.";
      readiness.classList.add("is-incomplete");
    }
  } catch {
    readiness.textContent = "Store policies could not be loaded. Please try again later.";
    readiness.classList.add("is-incomplete");
  }
}

loadStorePolicies();
