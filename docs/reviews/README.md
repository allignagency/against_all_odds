# AAO native reviews

Replaces the Loox Reviews app ($39.99/mo) with theme-owned code. Nothing about the storefront
should look different: the widget is a transcription of the live Loox widget's own DOM and CSS
(captured 2026-09-18 from `https://loox.io/widget/v-OorfUjQM/reviews/7176149008537`), down to the
star path data, the grey histogram bars, the 2px card radius and the `0 0 3px rgba(0,0,0,.2)` card
shadow. The `[loox]` comments in `assets/aao-reviews.css` mark every value taken verbatim.

The one deliberate difference: Loox painted stars gold (`#EBBF20`). AAO is a strict monochrome
brand, so `--aao-rev-star` defaults to `#111`. Set it back to `#EBBF20` in
`assets/aao-reviews.css` if the gold is wanted.

## Architecture

```
assets/aao-reviews.json     migrated Loox export, baked into the theme  -> fast, always available
        +
https://allign.agency/aao/reviews/approved.json   reviews approved since the migration (VPS)
        =
window.AAOReviews merged dataset -> widget + rating badges
```

| File | Role |
| --- | --- |
| `assets/aao-reviews.json` | The migrated review corpus. Schema below. Currently a **placeholder** (`"placeholder": true`). |
| `assets/aao-reviews.css` | All widget and badge styling. Transcribed from the Loox stylesheet. |
| `assets/aao-reviews.js` | The engine: merge, render, paginate, lightbox, form, JSON-LD. No dependencies. |
| `snippets/aao-reviews-boot.liquid` | Rendered once from `layout/theme.liquid`. Emits the stylesheet, the engine and the endpoint config. |
| `snippets/aao-reviews-widget.liquid` | The PDP widget mount point. Replaces the Loox `loox-dynamic-section` block. |
| `snippets/aao-rating-badge.liquid` | Stars + count badge. Replaces the Loox `loox-rating` block and the hard-coded `.loox-rating` div in `product-card.liquid`. |
| `sections/aao-reviews.liquid` | Section wrapper so the widget can sit below the product, where the Loox app section sat. |

### Data schema

```json
{
  "generated_at": "ISO-8601",
  "store": "againstallodds-clothing.myshopify.com",
  "products": {
    "<product_handle>": {
      "product_id": 123,
      "title": "...",
      "avg": 4.8,
      "count": 12,
      "reviews": [
        { "rating": 5, "author": "...", "date": "ISO-8601", "text": "...", "photos": ["url"], "verified": true }
      ]
    }
  }
}
```

`approved.json` uses the **same** shape. Per handle the engine concatenates the overlay's reviews
onto the baked ones, de-duplicates on `author|date|text[0:60]`, and recomputes `avg` / `count`.
Set `"replace": true` on an overlay product entry to discard the baked reviews for that handle
instead of merging.

If `approved.json` is unreachable, 404s, or is not valid JSON, the failure is swallowed and the
baked data still renders. Same for the asset fetch when the data is inlined.

### Performance

Product cards render dozens of times per collection page, so `aao-rating-badge.liquid`
server-renders nothing but `<span class="aao-rating" data-handle="...">`. The engine parses the
dataset **once** per page and hydrates every badge from that single object. The engine returns
immediately (and never fetches anything) on pages that contain no widget and no badge.

By default the dataset is fetched from the theme asset URL (CDN-cached). Render the boot snippet
with `inline_data: true` to embed the whole JSON in the page instead
(`{%- render 'aao-reviews-boot', inline_data: true -%}` in `layout/theme.liquid`). That gives a
server-rendered, crawlable copy of every review, at the cost of shipping the full corpus on every
page. See the SEO note below before flipping it.

## Approval flow

1. A visitor clicks **Write a review** on a PDP and fills in rating, name, email, review text.
2. The widget POSTs JSON to `https://allign.agency/aao/reviews/submit`:
   ```json
   { "handle": "dreamers-to-believers-t-shirt", "rating": 5, "author": "...", "email": "...", "text": "..." }
   ```
   A hidden honeypot field (`website`) is checked client-side; anything filled in is dropped
   silently. The endpoint should do its own validation and rate limiting.
3. The endpoint replies `{"ok": true}`. Anything else shows a retry message. On success the form
   is replaced with *"Thanks. Your review is pending and will appear once it has been approved."*
4. Someone approves the submission on the VPS.
5. The VPS regenerates `https://allign.agency/aao/reviews/approved.json` containing every approved
   review in the products-map schema. The endpoint must send permissive CORS
   (`Access-Control-Allow-Origin: https://www.againstallodds.shop`, or `*`) on **both** routes, and
   answer the preflight `OPTIONS` on `/submit`.
6. The next PDP or collection page view picks the new review up. No theme deploy needed.

Endpoint URLs are hard-coded in `snippets/aao-reviews-boot.liquid`. Change them there.

## Swapping in the real harvested reviews

1. Take the harvest output (same schema, without `"placeholder": true`).
2. Re-host the photos first (see below), then rewrite each `photos[]` URL to the new host.
3. Overwrite `assets/aao-reviews.json`.
4. Sanity check before deploying:
   ```bash
   python3 -c "import json;d=json.load(open('assets/aao-reviews.json'));print(len(d['products']),'products',sum(p['count'] for p in d['products'].values()),'reviews');assert not d.get('placeholder')"
   shopify theme check
   ```
5. Open a PDP and a collection page on a preview theme and confirm the badge counts match what
   Loox shows today.

Handles are the join key, so a product renamed in Shopify after the harvest loses its reviews until
the handle in the JSON is updated. Keep `product_id` in the file as a second key for repair work.

## Before cancelling Loox

- **Export finality.** Loox's export is only available while the subscription is live. Take a full
  export (reviews CSV + photos) and verify the review count in the file matches the count in the
  Loox dashboard *before* cancelling. Loox does not retain data after cancellation.
- **Photos are still on loox.io.** Every migrated photo URL points at
  `//images.loox.io/uploads/YYYY/M/D/<id>_mid.jpg`. Those are Loox's CDN, not Shopify's, and they
  are not guaranteed to survive cancellation. **Re-host every photo before cancelling.** Options,
  best first:
  1. Upload to Shopify **Content > Files** (`shopify.com/admin/content/files`) and use the returned
     `cdn.shopify.com` URLs. Free, same CDN as the rest of the storefront.
  2. Upload to the agency VPS next to the reviews endpoint and serve from
     `https://allign.agency/aao/reviews/photos/...`.
  Then rewrite `photos[]` in `assets/aao-reviews.json` (and anything already in `approved.json`).
  Grep for `loox.io` in both files afterwards; the result must be empty.
- **The Loox app embed in `config/settings_data.json`** is still present and is handled separately
  (theme settings, not templates). Turn it off in the theme editor's App embeds panel, or the Loox
  script keeps loading until the app is uninstalled.
- **Loox review-request emails.** If Loox was sending post-purchase review requests, that flow
  disappears with the app. Rebuild it in Klaviyo pointing at the PDP's `#aao-reviews` anchor.
- **Loox product grouping.** Loox grouped variants/products so reviews were shared across them.
  This system keys strictly on handle. Check whether any product relied on grouping and, if so,
  duplicate those reviews across the relevant handles in the JSON.
- **Google Shopping / rich results.** Re-run the Rich Results Test on a PDP after deploy and
  confirm `AggregateRating` and `Review` are still detected before cancelling.

## SEO note

Liquid cannot parse a JSON asset, so the review text cannot be rendered server-side from
`assets/aao-reviews.json`. The engine injects the `AggregateRating` / `Review` JSON-LD and a
visually hidden text copy of the reviews into the DOM after load. This is exactly what Loox does
today (`looxAddProductLdJsonSchema()` runs client-side there too), so the swap is not an SEO
regression. If true server-rendered review markup is wanted later, either:

- render the boot snippet with `inline_data: true` (whole corpus inlined, crawlable in source), or
- have the harvest emit a generated Liquid snippet with a `case product.handle` block per product.

## Where things are wired

- `layout/theme.liquid` -> `{%- render 'aao-reviews-boot' -%}` before `</body>`.
- `sections/main-product.liquid` -> block types `aao-rating` and `aao-reviews` in the schema.
- `snippets/product-info.liquid` -> `when 'aao-rating'` / `when 'aao-reviews'` in the block case.
- `snippets/product-card.liquid` -> `{%- render 'aao-rating-badge' -%}` where `.loox-rating` was.
- `templates/product.json`, `product.legends.json`, `product.store-wide.json`,
  `product.collection-fight-week.json` -> block `aao_rating` at the old `loox_rating` position, and
  section `173593565665a6d37f` retyped from `apps` to `aao-reviews` so it keeps its place in
  `order`.
