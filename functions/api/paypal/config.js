import { configuration, databaseReady, databaseRequest, errorResponse, jsonResponse, paypalReady, validPolicyDate } from "../../_utils/paypal.js";

export async function onRequestGet({ env }) {
  const config = configuration(env);
  if (!databaseReady(config)) {
    return jsonResponse({ enabled: false, environment: config.environment, missingDetails: ["SUPABASE_CONFIGURATION"] });
  }

  try {
    const [settings] = await databaseRequest(
      config,
      "store_legal_settings?select=business_name,support_email,postal_address,shipping_policy,returns_policy,tax_disclosure,policy_date,compliance_confirmed,is_published&id=eq.1",
    );
    const missingDetails = [];
    if (!settings?.business_name) missingDetails.push("STORE_LEGAL_NAME");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings?.support_email || "")) missingDetails.push("STORE_SUPPORT_EMAIL");
    if (!settings?.postal_address) missingDetails.push("STORE_POSTAL_ADDRESS");
    if (!settings?.shipping_policy) missingDetails.push("STORE_SHIPPING_POLICY");
    if (!settings?.returns_policy) missingDetails.push("STORE_RETURNS_POLICY");
    if (!settings?.tax_disclosure) missingDetails.push("STORE_TAX_DISCLOSURE");
    if (!validPolicyDate(settings?.policy_date)) missingDetails.push("STORE_POLICY_EFFECTIVE_DATE");
    if (!settings?.compliance_confirmed || !settings?.is_published) missingDetails.push("SELLER_COMPLIANCE_CONFIRMATION");
    if (!config.clientId || !config.clientSecret) missingDetails.push("PAYPAL_APP_CREDENTIALS");
    if (!["sandbox", "live"].includes(config.environment)) missingDetails.push("PAYPAL_ENVIRONMENT");
    if (!Number.isSafeInteger(config.shippingCents) || config.shippingCents < 0) missingDetails.push("PAYPAL_SHIPPING_CENTS");

    const enabled = missingDetails.length === 0 && paypalReady(config);
    return jsonResponse({
      enabled,
      clientId: enabled ? config.clientId : null,
      shippingCents: enabled ? config.shippingCents : null,
      environment: config.environment,
      missingDetails,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
