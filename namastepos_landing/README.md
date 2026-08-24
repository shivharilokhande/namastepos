# NamastePOS Landing Page

Single-file static site. No build step.

## Run locally

```bash
cd "$HOME/AI Development/Java Projects/PetPooja Clone/namastepos_landing"
python3 -m http.server 5175
```

Open http://localhost:5175 .

## Before deploying to production

Edit the `window.NAMASTEPOS_URLS` block at the top of `<body>` in `index.html`:

```js
window.NAMASTEPOS_URLS = {
  app:       'https://app.namastepos.in',
  register:  'https://app.namastepos.in/register',
  login:     'https://app.namastepos.in/login',
  privacy:   'https://app.namastepos.in/legal/privacy',
  terms:     'https://app.namastepos.in/legal/terms',
  grievance: 'https://app.namastepos.in/privacy',
};
```

Also update the email addresses in the footer (`hello@namastepos.in`, `support@namastepos.in`).

## Deploy — Cloudflare Pages (free, India edge)

```bash
cd "$HOME/AI Development/Java Projects/PetPooja Clone/namastepos_landing"
npx wrangler pages deploy . --project-name=namastepos-landing
```

Then in the Cloudflare dashboard:
1. Pages → namastepos-landing → Custom domains → add `namastepos.in` and `www.namastepos.in`
2. Cloudflare auto-provisions TLS within ~60 seconds

## Alternative hosts (all free, all have India edges)

- **Netlify** — drag-and-drop `index.html` at https://app.netlify.com/drop
- **Vercel** — `npx vercel --prod`
- **Render** — connect this folder as a "Static Site" repo
