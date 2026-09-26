# Timber & Tackle Supply

A responsive storefront for no-trespassing signs made from custom-moulded plastic and printed in Michigan, with a private product catalog for adding product details and photos.

## Run locally and upload products

1. Start the local store with `node server.js`.
2. Open `http://localhost:8000/admin.html`. The first visit asks you to create an owner password of at least 12 characters; later visits require that password.
3. Add a product name, details, price, and a JPG, PNG, WebP, or AVIF photo (up to 8 MB). Choose whether to publish it. Published products and their actual uploaded photos appear in the storefront automatically.

Catalog data and photos are stored in `.local-store/`, which is excluded from Git. Back up that folder to keep your local catalog and images. The local server binds to `127.0.0.1`; it is intended for your private development machine, not direct public hosting.

In a supported browser, open `/admin.html` and choose **Install App** to add a desktop-style shortcut. The installed app menu includes shortcuts to the owner catalog and storefront. When creating the owner login, save `owner` and your password in your browser's password manager; the site stores only a salted password hash on the server.

## Hosted owner uploads

The included `render.yaml` runs the Node app with a persistent disk for products and real product photos. To publish it on Render:

1. Push this project to GitHub, then in Render choose **New + → Blueprint** and connect the repository.
2. Set the requested `OWNER_SETUP_KEY` environment variable to a unique random secret at least 32 characters long. Keep it private; you enter it once on the first owner setup screen. Render Starter and its persistent disk are paid resources.
3. Deploy the Blueprint and open the Render URL. Go to `/admin.html`, enter the setup key, and create an owner password with at least 12 characters. After that, owner sign-in uses the password; the one-time key is no longer needed.

The Render service binds to the provider's network, uses HTTPS-only secure owner cookies, and persists products/photos on its mounted disk. Keep the Render service and setup key private. A new deployment needs the changes in this repository pushed to GitHub first.

For a separately hosted Supabase setup, the database and private storage policies restrict edits and uploads to the verified owner email; only published product photos are viewable by shoppers. Never put a Supabase service-role key in this project.

## Before taking orders

The bag is saved only in the visitor's browser. Payment, shipping, inventory, and order submission are not connected. Set actual product prices/specifications and verify country-of-origin claims before publishing, then connect a commerce provider before accepting orders.
