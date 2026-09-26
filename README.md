# Timber & Tackle Supply

A responsive storefront for no-trespassing signs made from custom-moulded plastic and printed in Michigan, with a private product catalog for adding product details and photos.

## Run locally and upload products

1. Start the local store with `npm start` (or `node server.js`); run `npm run check` to validate the JavaScript files.
2. Open `http://localhost:8000/admin.html`. The first visit asks you to create an owner password of at least 12 characters; later visits require that password.
3. In **Seller & Checkout Settings**, enter accurate seller identity/contact details, shipping, returns/refund, and tax policies and a policy date. Confirm you have reviewed the details for your business and sales destinations. Save these settings before checkout can be enabled. Add a product name, details, price, and a JPG, PNG, WebP, or AVIF photo (up to 8 MB). Choose whether to publish it. Published products and their actual uploaded photos appear in the storefront automatically.

Catalog data and photos are stored in `.local-store/`, which is excluded from Git. Back up that folder to keep your local catalog and images. The local server binds to `127.0.0.1`; it is intended for your private development machine, not direct public hosting.

Choose **Save Quick Link** in the store or owner-catalog header to install the site as an app. The installed shortcut opens the storefront; its app menu includes direct shortcuts to the owner catalog and shop. If your browser does not offer installation, use its menu to choose **Install app** or **Add to Home Screen**. When creating the owner login, save `owner` and your password in your browser's password manager; the site stores only a salted password hash on the server.

## Free hosted storefront

The free-hosting setup is **Cloudflare Pages + Supabase Free**. Pages serves this static storefront and its `/api/paypal/*` checkout functions; Supabase stores the catalog, product photos, seller policies, and paid-order records. Free tiers have quotas, can pause inactive databases, and are not an uptime or backup guarantee. No hosting provider can promise permanent availability on a free plan.

1. Create a Supabase project on its Free plan. In **SQL Editor**, replace `you@example.com` in `supabase/setup.sql` with the owner's verified sign-in email and run the script. Enable that account in Supabase Auth. Copy the project URL and publishable/anon key from its API settings into `supabase-config.js`; this key is public by design and protected by the SQL row/storage policies.
2. In Supabase Auth, set the deployed Pages hostname as the Site URL and add `https://<your-pages-hostname>/**` to allowed Redirect URLs for owner email sign-in links. The owner uses **Owner Login** and Supabase emails a sign-in link. Add the same owner email to `store_owners`.
3. In Cloudflare, choose **Workers & Pages → Create → Pages → Connect to Git** and select this GitHub repository. Use `main`, leave the build command empty, and set the output directory to `.`. Pages detects the `functions/` directory automatically and deploys the PayPal API routes with the storefront.
4. Add these **server-only** Pages environment variables in project **Settings → Variables and Secrets**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (the Supabase legacy `service_role` JWT key), `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV=sandbox`, and `PAYPAL_SHIPPING_CENTS=0`. Mark keys as secrets. Never place a Supabase service-role key or PayPal Secret in `supabase-config.js`, Git, or chat.
5. Set the seller/legal policies in the authenticated **Owner Login → Seller & Checkout Settings** panel. Add/edit products and upload photos there; they are stored in Supabase. Test in PayPal sandbox. PayPal checkout remains disabled until app credentials and seller/legal details are present.

Pages Functions verify cart products and prices against the Supabase catalog, create/capture PayPal orders server-side, and save confirmed order summaries in Supabase. Public users only see published products and policies; only the verified owner can manage the catalog, photos, seller policies, and orders. The detailed SQL setup enables row-level security and private product-photo storage.

If you choose the included Render Blueprint instead, note that its persistent disk requires a paid Render plan. Render's free web service has no persistent disk, so it cannot be used as a durable product/photo store.

## PayPal checkout

The PayPal email on your account is not enough to connect checkout: create a PayPal REST app in the PayPal Developer Dashboard and use its Client ID and Secret. Locally, copy `.env.example` to `.env` and fill in the values; the server loads `.env` at startup and Git ignores the file. Restart the local server after editing. For Pages, add PayPal credentials as server-side Cloudflare secrets. Use sandbox credentials with `PAYPAL_ENV=sandbox` for test purchases. Keep the Secret out of browser code, Git, and chat. Switch to live credentials and `PAYPAL_ENV=live` only when ready to accept real payments.

PayPal verifies checkout totals against the current published catalog, collects the buyer's shipping address, and stores checkout summaries and payment status in `.local-store/orders.json` locally or the Supabase `store_orders` table on Pages. Use your PayPal business account to view shipping details, issue refunds, and fulfill orders. Set `PAYPAL_SHIPPING_CENTS` to your flat shipping charge in cents; it defaults to zero. Applicable taxes are not calculated by this site, so configure and account for taxes before enabling live payments. On Pages, keep the Supabase service-role key exclusively in server-side Cloudflare secrets.

The public `/legal.html` page displays seller details and policies saved in the authenticated owner dashboard. On Pages they are stored in Supabase; locally they are stored with the catalog. PayPal checkout remains disabled unless the seller settings are complete, the owner confirms their review, and the PayPal credentials and hosted backend are configured. Checkout also requires customers to agree to the linked store terms. These starter disclosures are not legal advice or a guarantee of compliance in every state or country. This PayPal integration does not calculate or add destination-based sales tax; do not enable live payments until the seller has independently established that checkout totals and tax treatment comply in each destination.

## Before taking live orders

The shopping bag is saved in the visitor's browser; confirmed orders are stored by the server. Set actual product prices/specifications and the shipping charge, verify country-of-origin and performance claims, publish accurate seller/policy details, review privacy/returns/shipping obligations where you sell, test the full purchase in PayPal sandbox, and arrange tax handling before switching to live credentials.
