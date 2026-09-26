# Timber & Tackle Supply

A responsive storefront for no-trespassing signs made from custom-moulded plastic and printed in Michigan, with a private product catalog for adding product details and photos.

## Run locally and upload products

1. Start the local store with `npm start` (or `node server.js`); run `npm run check` to validate the JavaScript files.
2. Open `http://localhost:8000/admin.html`. The first visit asks you to create an owner password of at least 12 characters; later visits require that password.
3. In **Seller & Checkout Settings**, enter accurate seller identity/contact details, shipping, returns/refund, and tax policies and a policy date. Confirm you have reviewed the details for your business and sales destinations. Save these settings before checkout can be enabled. Add a product name, details, price, and a JPG, PNG, WebP, or AVIF photo (up to 8 MB). Choose whether to publish it. Published products and their actual uploaded photos appear in the storefront automatically.

Catalog data and photos are stored in `.local-store/`, which is excluded from Git. Back up that folder to keep your local catalog and images. The local server binds to `127.0.0.1`; it is intended for your private development machine, not direct public hosting.

Choose **Save Quick Link** in the store or owner-catalog header to install the site as an app. The installed shortcut opens the storefront; its app menu includes direct shortcuts to the owner catalog and shop. If your browser does not offer installation, use its menu to choose **Install app** or **Add to Home Screen**. When creating the owner login, save `owner` and your password in your browser's password manager; the site stores only a salted password hash on the server.

## Hosted owner uploads

The included `render.yaml` runs the Node app with a persistent disk for products and real product photos. To publish it on Render:

1. Push this project to GitHub, then in Render choose **New + → Blueprint** and connect the repository.
2. Set `OWNER_SETUP_KEY` to a unique random secret at least 32 characters long and provide your PayPal sandbox `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`. Render also asks for the store's legal identity, contact details, shipping/return/tax disclosures, and policy date; publish accurate values. Keep credentials private; the owner setup key is entered once on the first owner setup screen. Render Starter and its persistent disk are paid resources.
3. Deploy the Blueprint and open the Render URL. Go to `/admin.html`, enter the setup key, and create an owner password with at least 12 characters. After that, owner sign-in uses the password; the one-time key is no longer needed.

The Render service binds to the provider's network, uses HTTPS-only secure owner cookies, and saves the catalog, owner login, and uploaded photos on its mounted persistent disk. The installed quick link opens that live store, so your saved products are available from the same hosted URL on your devices. Keep the Render service and setup key private. A new deployment needs the changes in this repository pushed to GitHub first.

For a separately hosted Supabase setup, the database and private storage policies restrict edits and uploads to the verified owner email; only published product photos are viewable by shoppers. Never put a Supabase service-role key in this project.

## PayPal checkout

The PayPal email on your account is not enough to connect checkout: create a PayPal REST app in the PayPal Developer Dashboard and use its Client ID and Secret. Locally, copy `.env.example` to `.env` and fill in the values; the server loads `.env` at startup and Git ignores the file. Restart the local server after editing. Use sandbox credentials with `PAYPAL_ENV=sandbox` for test purchases. Keep the Secret out of browser code, Git, and chat. The Render Blueprint asks for the two credentials and starts in sandbox mode. Switch to live credentials and `PAYPAL_ENV=live` only when you are ready to accept real payments.

PayPal verifies checkout totals against the current published catalog, collects the buyer's shipping address, and stores checkout summaries and payment status in `.local-store/orders.json` (or the hosted persistent disk). Use your PayPal business account to view shipping details, issue refunds, and fulfill orders. Set `PAYPAL_SHIPPING_CENTS` to your flat shipping charge in cents; it defaults to zero. Applicable taxes are not calculated by this site, so configure and account for taxes before enabling live payments. If using the Supabase catalog, also set `SUPABASE_URL` and `SUPABASE_ANON_KEY` on the server so it can verify current published prices. Never use a Supabase service-role key here.

The public `/legal.html` page displays the seller details and policies saved in the authenticated owner dashboard. On hosted deployments, these are stored on the persistent data disk. Alternatively, environment settings can supply initial details. PayPal checkout remains disabled unless the seller settings are complete, the owner confirms their review, and both PayPal credentials are configured. Checkout also requires customers to agree to the linked store terms. These starter disclosures are not legal advice or a guarantee of compliance in every state or country. This PayPal integration does not calculate or add destination-based sales tax; do not enable live payments until the seller has independently established that checkout totals and tax treatment comply in each destination.

## Before taking live orders

The shopping bag is saved in the visitor's browser; confirmed orders are stored by the server. Set actual product prices/specifications and the shipping charge, verify country-of-origin and performance claims, publish accurate seller/policy details, review privacy/returns/shipping obligations where you sell, test the full purchase in PayPal sandbox, and arrange tax handling before switching to live credentials.
