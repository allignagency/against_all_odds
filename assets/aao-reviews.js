/* ---------------------------------------------------------------------------------------------
   AAO NATIVE REVIEWS - widget engine
   ---------------------------------------------------------------------------------------------
   Replaces the Loox reviews app. No dependencies, no framework.

   Data sources, merged in this order (later wins per product handle):
     1. assets/aao-reviews.json  - the migrated Loox export, baked into the theme.
        Read from an inline <script type="application/json" id="aao-reviews-data"> when the
        snippet inlined it, otherwise fetched from the theme asset URL.
     2. <approval endpoint>/approved.json - reviews approved since the migration, served by the
        agency VPS. Fetched client-side; failure is silent and the baked data still shows.

   New submissions POST to <endpoint>/submit as
     {handle, rating, author, email, text}
   and expect {"ok": true}.
   --------------------------------------------------------------------------------------------- */

(function () {
  'use strict';

  if (window.AAOReviews) return;

  var cfg = window.AAO_REVIEWS_CONFIG || {};
  var PAGE_SIZE = 5;

  /* --- star svg ------------------------------------------------------------------------------
     Path data transcribed from the Loox icon sprite (#looxicons-rating-icon-fill / -line) so the
     star silhouette is identical to what the store shows today. */
  var STAR_FILL =
    'M24 9.425c0 .212-.125.443-.375.693l-5.236 5.105 1.24 7.212c.01.067.015.164.015.289a.85.85 0 0 1-.151.511.51.51 0 0 1-.44.21c-.183 0-.375-.058-.577-.174L12 19.869l-6.476 3.404c-.212.115-.404.173-.577.173-.202 0-.353-.07-.454-.21a.85.85 0 0 1-.152-.511c0-.058.01-.154.03-.289l1.24-7.211-5.25-5.106C.12 9.858 0 9.628 0 9.425c0-.355.27-.577.808-.663l7.24-1.053 3.245-6.562c.183-.395.418-.592.707-.592s.524.197.707.592l3.245 6.562 7.24 1.053c.539.086.808.308.808.663Z';
  var STAR_LINE =
    'm16.399 14.574 4.413-4.283-6.086-.894L12 3.887l-2.726 5.51-6.086.894L7.6 14.574l-1.053 6.072L12 17.776l5.438 2.87-1.039-6.072ZM24 9.425c0 .212-.125.443-.375.693l-5.236 5.105 1.24 7.212c.01.067.015.164.015.289 0 .48-.197.72-.591.72-.183 0-.375-.057-.577-.172L12 19.867l-6.476 3.404c-.212.115-.404.173-.577.173-.202 0-.353-.07-.454-.21a.85.85 0 0 1-.152-.511c0-.058.01-.154.03-.289l1.24-7.211-5.25-5.106C.12 9.858 0 9.628 0 9.425c0-.355.27-.577.808-.663l7.24-1.053 3.245-6.562c.183-.395.418-.592.707-.592s.524.197.707.592l3.245 6.562 7.24 1.053c.539.086.808.308.808.663Z';

  var VERIFIED_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 1.5 14.36 4l3.4-.35.72 3.35 3.02 1.65-1.6 3.03 1.6 3.02-3.02 1.66-.72 3.34-3.4-.34L12 22.5 9.64 20l-3.4.34-.72-3.34-3.02-1.66 1.6-3.02-1.6-3.03L5.52 7l.72-3.35 3.4.35L12 1.5Zm-1.2 13.94 5.68-5.69-1.42-1.41-4.26 4.26-2.14-2.13-1.41 1.41 3.55 3.56Z"/></svg>';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* Percentage fill for one star at position `index` (1-5) given a rating. Loox snapped to
     empty / half / full; we do the same so the row reads the same at a glance. */
  function starPct(rating, index) {
    var d = rating - (index - 1);
    if (d >= 0.75) return 100;
    if (d >= 0.25) return 50;
    return 0;
  }

  function starsHTML(rating, label) {
    var out = '<span class="aao-stars" role="img" aria-label="' + esc(label || (Math.round(rating * 10) / 10) + ' out of 5 stars') + '">';
    for (var i = 1; i <= 5; i++) {
      out +=
        '<svg class="aao-star" viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="--aao-star-pct:' +
        starPct(rating, i) +
        '%"><path class="aao-star__fill" fill="currentColor" d="' +
        STAR_FILL +
        '"/><path class="aao-star__line" fill="currentColor" d="' +
        STAR_LINE +
        '"/></svg>';
    }
    return out + '</span>';
  }

  function fmtDate(value) {
    if (!value) return '';
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    try {
      return d.toLocaleDateString(document.documentElement.lang || 'en-GB', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
    } catch (e) {
      return d.toDateString();
    }
  }

  function toTime(value) {
    var t = new Date(value).getTime();
    return isNaN(t) ? 0 : t;
  }

  /* --- data ---------------------------------------------------------------------------------- */

  var dataPromise = null;

  function readInline() {
    var el = document.getElementById('aao-reviews-data');
    if (!el) return null;
    try {
      var parsed = JSON.parse(el.textContent);
      return parsed && parsed.products ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function fetchJSON(url) {
    if (!url) return Promise.resolve(null);
    return fetch(url, { credentials: 'omit' })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .catch(function () {
        return null;
      });
  }

  /* Merge overlay over base, per handle. A handle present in the overlay replaces the baked entry
     unless the overlay entry only carries extra reviews, in which case they are concatenated and
     avg/count are recomputed. */
  function merge(base, overlay) {
    var products = {};
    var h;
    if (base && base.products) {
      for (h in base.products) {
        if (Object.prototype.hasOwnProperty.call(base.products, h)) products[h] = base.products[h];
      }
    }
    if (overlay && overlay.products) {
      for (h in overlay.products) {
        if (!Object.prototype.hasOwnProperty.call(overlay.products, h)) continue;
        var fresh = overlay.products[h];
        var existing = products[h];
        if (!existing) {
          products[h] = fresh;
          continue;
        }
        if (fresh.replace === true) {
          products[h] = fresh;
          continue;
        }
        var seen = {};
        var all = (existing.reviews || []).concat(fresh.reviews || []).filter(function (r) {
          var key = (r.author || '') + '|' + (r.date || '') + '|' + (r.text || '').slice(0, 60);
          if (seen[key]) return false;
          seen[key] = true;
          return true;
        });
        var sum = all.reduce(function (a, r) {
          return a + (Number(r.rating) || 0);
        }, 0);
        products[h] = {
          product_id: fresh.product_id || existing.product_id,
          title: fresh.title || existing.title,
          reviews: all,
          count: all.length,
          avg: all.length ? Math.round((sum / all.length) * 10) / 10 : 0
        };
      }
    }
    return { products: products };
  }

  function load() {
    if (dataPromise) return dataPromise;
    var inline = readInline();
    var basePromise = inline ? Promise.resolve(inline) : fetchJSON(cfg.assetUrl);
    var overlayPromise = cfg.approvedUrl ? fetchJSON(cfg.approvedUrl) : Promise.resolve(null);
    dataPromise = Promise.all([basePromise, overlayPromise]).then(function (res) {
      return merge(res[0], res[1]);
    });
    return dataPromise;
  }

  function entryFor(data, handle) {
    if (!data || !data.products || !handle) return null;
    var e = data.products[handle];
    if (!e) return null;
    var reviews = (e.reviews || []).slice().sort(function (a, b) {
      return toTime(b.date) - toTime(a.date);
    });
    var count = typeof e.count === 'number' ? e.count : reviews.length;
    var avg = typeof e.avg === 'number' ? e.avg : 0;
    if (!avg && reviews.length) {
      avg =
        Math.round(
          (reviews.reduce(function (a, r) {
            return a + (Number(r.rating) || 0);
          }, 0) /
            reviews.length) *
            10
        ) / 10;
    }
    return { title: e.title, product_id: e.product_id, reviews: reviews, count: count, avg: avg };
  }

  /* --- lightbox ------------------------------------------------------------------------------ */

  var lightbox = null;

  function openLightbox(photos, index, caption) {
    closeLightbox();
    var i = index || 0;
    lightbox = document.createElement('div');
    lightbox.className = 'aao-reviews-lightbox';
    lightbox.setAttribute('role', 'dialog');
    lightbox.setAttribute('aria-modal', 'true');
    lightbox.innerHTML =
      '<button type="button" class="aao-reviews-lightbox__close" aria-label="Close">&times;</button>' +
      (photos.length > 1
        ? '<button type="button" class="aao-reviews-lightbox__nav" data-dir="prev" aria-label="Previous photo">&#8249;</button>' +
          '<button type="button" class="aao-reviews-lightbox__nav" data-dir="next" aria-label="Next photo">&#8250;</button>'
        : '') +
      '<img alt="' + esc(caption || 'Customer photo') + '">' +
      '<div class="aao-reviews-lightbox__caption"></div>';

    var img = lightbox.querySelector('img');
    var cap = lightbox.querySelector('.aao-reviews-lightbox__caption');

    function show() {
      img.src = photos[i];
      cap.textContent = photos.length > 1 ? i + 1 + ' / ' + photos.length : '';
    }

    lightbox.addEventListener('click', function (e) {
      var dir = e.target.getAttribute && e.target.getAttribute('data-dir');
      if (dir === 'prev') {
        i = (i - 1 + photos.length) % photos.length;
        show();
      } else if (dir === 'next') {
        i = (i + 1) % photos.length;
        show();
      } else if (e.target === lightbox || e.target.classList.contains('aao-reviews-lightbox__close')) {
        closeLightbox();
      }
    });

    document.addEventListener('keydown', onKey);
    document.body.appendChild(lightbox);
    show();
  }

  function onKey(e) {
    if (e.key === 'Escape') closeLightbox();
  }

  function closeLightbox() {
    if (!lightbox) return;
    document.removeEventListener('keydown', onKey);
    if (lightbox.parentNode) lightbox.parentNode.removeChild(lightbox);
    lightbox = null;
  }

  /* --- review card --------------------------------------------------------------------------- */

  function cardHTML(review) {
    var photos = Array.isArray(review.photos) ? review.photos.filter(Boolean) : [];
    var html = '<article class="aao-review"><div class="aao-review__main">';
    html += '<div class="aao-review__title"><span>' + esc(review.author || 'Anonymous') + '</span>';
    if (review.verified) {
      html +=
        '<span class="aao-review__verified">' + VERIFIED_ICON + '<span>Verified</span></span>';
    }
    html += '</div>';
    html +=
      '<div class="aao-review__stars">' +
      starsHTML(Number(review.rating) || 0, (Number(review.rating) || 0) + ' out of 5 stars') +
      '</div>';
    if (review.text) html += '<p class="aao-review__text">' + esc(review.text) + '</p>';
    if (photos.length) {
      html += '<div class="aao-review__photos">';
      for (var p = 0; p < Math.min(photos.length, 4); p++) {
        html +=
          '<button type="button" class="aao-review__photo" data-photo-index="' +
          p +
          '" aria-label="Open customer photo ' +
          (p + 1) +
          '"><img src="' +
          esc(photos[p]) +
          '" alt="Customer photo from ' +
          esc(review.author || 'a customer') +
          '" loading="lazy" decoding="async">' +
          (p === 3 && photos.length > 4
            ? '<span class="aao-review__photo-more">+' + (photos.length - 3) + '</span>'
            : '') +
          '</button>';
      }
      html += '</div>';
    }
    if (review.date) {
      html += '<div class="aao-review__time">' + esc(fmtDate(review.date)) + '</div>';
    }
    html += '</div></article>';
    return html;
  }

  /* --- structured data ----------------------------------------------------------------------- */

  function injectJSONLD(root, entry, productName, productUrl) {
    if (!entry || !entry.count) return;
    var node = {
      '@context': 'https://schema.org/',
      '@type': 'Product',
      name: productName || entry.title || '',
      url: productUrl || (location.origin + location.pathname),
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: String(entry.avg),
        reviewCount: String(entry.count),
        bestRating: '5',
        worstRating: '1'
      },
      review: entry.reviews.slice(0, 20).map(function (r) {
        return {
          '@type': 'Review',
          reviewRating: {
            '@type': 'Rating',
            ratingValue: String(Number(r.rating) || 0),
            bestRating: '5',
            worstRating: '1'
          },
          author: { '@type': 'Person', name: r.author || 'Anonymous' },
          datePublished: (r.date || '').slice(0, 10),
          reviewBody: r.text || ''
        };
      })
    };
    var s = document.createElement('script');
    s.type = 'application/ld+json';
    s.setAttribute('data-aao-reviews', '');
    s.textContent = JSON.stringify(node);
    root.appendChild(s);
  }

  function seoBlock(entry) {
    var out = '<div class="aao-reviews__seo">';
    out +=
      '<p>' +
      esc(entry.title || '') +
      ' - rated ' +
      entry.avg +
      ' out of 5 from ' +
      entry.count +
      ' customer reviews.</p><ul>';
    entry.reviews.slice(0, 20).forEach(function (r) {
      out +=
        '<li>' +
        esc(r.author || 'Anonymous') +
        ' - ' +
        (Number(r.rating) || 0) +
        '/5 - ' +
        esc(r.text || '') +
        '</li>';
    });
    return out + '</ul></div>';
  }

  /* --- write-a-review form ------------------------------------------------------------------- */

  function formHTML(handle) {
    var out = '<div class="aao-reviews__form-wrap" data-open="false">';
    out += '<h3 class="aao-reviews__form-title">Write a review</h3>';
    out += '<form class="aao-reviews__form" novalidate>';
    out += '<input type="hidden" name="handle" value="' + esc(handle) + '">';
    out +=
      '<label class="aao-reviews__field"><span>Your rating</span>' +
      '<span class="aao-reviews__rating-input" role="radiogroup" aria-label="Your rating">';
    for (var i = 1; i <= 5; i++) {
      out +=
        '<button type="button" role="radio" aria-checked="' +
        (i === 5 ? 'true' : 'false') +
        '" data-value="' +
        i +
        '" aria-label="' +
        i +
        ' star' +
        (i > 1 ? 's' : '') +
        '"><svg class="aao-star" viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="--aao-star-pct:100%"><path class="aao-star__fill" fill="currentColor" d="' +
        STAR_FILL +
        '"/><path class="aao-star__line" fill="currentColor" d="' +
        STAR_LINE +
        '"/></svg></button>';
    }
    out += '</span></label>';
    out +=
      '<label class="aao-reviews__field"><span>Name</span><input type="text" name="author" autocomplete="name" maxlength="80" required></label>';
    out +=
      '<label class="aao-reviews__field"><span>Email (not published)</span><input type="email" name="email" autocomplete="email" maxlength="160" required></label>';
    out +=
      '<label class="aao-reviews__field"><span>Your review</span><textarea name="text" maxlength="2000" required></textarea></label>';
    out +=
      '<label class="aao-reviews__hp" aria-hidden="true" tabindex="-1"><span>Leave this field empty</span><input type="text" name="website" tabindex="-1" autocomplete="off"></label>';
    out +=
      '<div class="aao-reviews__form-actions">' +
      '<button type="submit" class="aao-reviews__btn">Submit review</button>' +
      '<button type="button" class="aao-reviews__btn" data-aao-cancel>Cancel</button>' +
      '<p class="aao-reviews__note" role="status" aria-live="polite"></p>' +
      '</div>';
    out += '</form></div>';
    return out;
  }

  function wireForm(root, handle) {
    var wrap = root.querySelector('.aao-reviews__form-wrap');
    var form = root.querySelector('.aao-reviews__form');
    if (!wrap || !form) return;
    var note = form.querySelector('.aao-reviews__note');
    var rating = 5;

    function paint() {
      form.querySelectorAll('.aao-reviews__rating-input button').forEach(function (btn) {
        var v = Number(btn.getAttribute('data-value'));
        btn.setAttribute('aria-checked', v === rating ? 'true' : 'false');
        btn.querySelectorAll('.aao-star').forEach(function (svg) {
          svg.style.setProperty('--aao-star-pct', v <= rating ? '100%' : '0%');
        });
      });
    }

    form.querySelectorAll('.aao-reviews__rating-input button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        rating = Number(btn.getAttribute('data-value')) || 5;
        paint();
      });
    });
    paint();

    root.querySelectorAll('[data-aao-write]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var open = wrap.getAttribute('data-open') === 'true';
        wrap.setAttribute('data-open', open ? 'false' : 'true');
        if (!open) {
          var first = form.querySelector('input[name="author"]');
          if (first) first.focus();
        }
      });
    });

    var cancel = form.querySelector('[data-aao-cancel]');
    if (cancel) {
      cancel.addEventListener('click', function () {
        wrap.setAttribute('data-open', 'false');
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (form.website && form.website.value) return; /* honeypot */
      note.removeAttribute('data-state');

      var payload = {
        handle: handle,
        rating: rating,
        author: (form.author.value || '').trim(),
        email: (form.email.value || '').trim(),
        text: (form.text.value || '').trim()
      };

      if (!payload.author || !payload.email || !payload.text) {
        note.setAttribute('data-state', 'error');
        note.textContent = 'Please fill in your name, email and review.';
        return;
      }
      if (!cfg.submitUrl) {
        note.setAttribute('data-state', 'error');
        note.textContent = 'Reviews are not accepting submissions right now.';
        return;
      }

      var submit = form.querySelector('button[type="submit"]');
      if (submit) submit.disabled = true;
      note.textContent = 'Sending...';

      fetch(cfg.submitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (r) {
          return r.json().catch(function () {
            return null;
          });
        })
        .then(function (json) {
          if (json && json.ok) {
            form.innerHTML =
              '<p class="aao-reviews__note">Thanks. Your review is pending and will appear once it has been approved.</p>';
          } else {
            throw new Error('rejected');
          }
        })
        .catch(function () {
          if (submit) submit.disabled = false;
          note.setAttribute('data-state', 'error');
          note.textContent = 'Sorry, we could not send that. Please try again in a moment.';
        });
    });
  }

  /* --- widget -------------------------------------------------------------------------------- */

  function renderWidget(root, data) {
    var handle = root.getAttribute('data-handle');
    var productName = root.getAttribute('data-product-title') || '';
    var productUrl = root.getAttribute('data-product-url') || '';
    var entry = entryFor(data, handle);
    var heading = root.getAttribute('data-heading') || 'Customer Reviews';

    if (!entry || !entry.count) {
      root.innerHTML =
        '<div class="aao-reviews__header"><div class="aao-reviews__summary"><span class="aao-reviews__summary-text"><span>Be the first to review this product</span></span></div>' +
        '<div class="aao-reviews__actions"><button type="button" class="aao-reviews__btn" data-aao-write>Write a review</button></div></div>' +
        formHTML(handle);
      wireForm(root, handle);
      return;
    }

    var buckets = [0, 0, 0, 0, 0];
    entry.reviews.forEach(function (r) {
      var v = Math.round(Number(r.rating) || 0);
      if (v >= 1 && v <= 5) buckets[v - 1]++;
    });

    var html = '';
    html += '<h2 class="aao-reviews__seo">' + esc(heading) + '</h2>';
    html += '<div class="aao-reviews__header" data-dist-open="false">';
    html += '<div class="aao-reviews__summary">';
    html +=
      '<button type="button" class="aao-reviews__summary-btn" aria-expanded="false" data-aao-dist>' +
      '<span class="aao-reviews__summary-stars">' +
      starsHTML(entry.avg, 'Average rating: ' + entry.avg + ' out of 5') +
      '</span>' +
      '<span class="aao-reviews__summary-text"><span>' +
      entry.count +
      ' Review' +
      (entry.count === 1 ? '' : 's') +
      '</span><span class="aao-reviews__chevron"><svg width="14" height="8" viewBox="0 0 14 8" fill="none" aria-hidden="true"><path d="M7.11098 5.15691L2.16098 0.206909L0.746979 1.62091L7.11098 7.98491L13.475 1.62091L12.061 0.206911L7.11098 5.15691Z" fill="currentColor"/></svg></span></span>' +
      '</button>';
    html += '</div>';
    html +=
      '<div class="aao-reviews__actions"><button type="button" class="aao-reviews__btn" data-aao-write>Write a review</button></div>';

    html += '<div class="aao-reviews__dist">';
    /* [loox] the distribution panel shows ONE star followed by the average, at 32px. */
    html +=
      '<span class="aao-reviews__dist-avg" role="figure" aria-label="Average rating: ' +
      entry.avg +
      ' out of 5">' +
      '<svg class="aao-star" viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="--aao-star-pct:100%"><path class="aao-star__fill" fill="currentColor" d="' +
      STAR_FILL +
      '"/></svg>' +
      '<span>' +
      entry.avg +
      '</span></span>';
    html += '<table><tbody>';
    for (var s = 5; s >= 1; s--) {
      var n = buckets[s - 1];
      var pct = entry.reviews.length ? (n / entry.reviews.length) * 100 : 0;
      html +=
        '<tr class="aao-reviews__dist-row" data-rating="' +
        s +
        '" role="button" tabindex="0" aria-pressed="false"' +
        (n === 0 ? ' aria-disabled="true"' : '') +
        ' aria-label="Filter by ' +
        s +
        ' stars, ' +
        n +
        ' reviews">' +
        '<td>' +
        starsHTML(s, s + ' stars') +
        '</td>' +
        '<td class="aao-reviews__dist-bar"><div class="aao-reviews__progress"><span style="width:' +
        pct +
        '%"></span></div></td>' +
        '<td class="aao-reviews__dist-count">(' +
        n +
        ')</td></tr>';
    }
    html += '</tbody></table></div>';
    html += '</div>';

    html += formHTML(handle);
    html += '<div class="aao-reviews__grid"></div>';
    html += '<div class="aao-reviews__more" hidden><button type="button">Load more reviews</button></div>';
    html += seoBlock(entry);

    root.innerHTML = html;

    var grid = root.querySelector('.aao-reviews__grid');
    var moreWrap = root.querySelector('.aao-reviews__more');
    var moreBtn = moreWrap.querySelector('button');
    var filter = 0;
    var shown = 0;

    function visible() {
      return filter ? entry.reviews.filter(function (r) { return Math.round(Number(r.rating) || 0) === filter; }) : entry.reviews;
    }

    function draw(reset) {
      var list = visible();
      if (reset) {
        grid.innerHTML = '';
        shown = 0;
      }
      var next = list.slice(shown, shown + PAGE_SIZE);
      var frag = document.createElement('div');
      frag.innerHTML = next.map(cardHTML).join('');
      while (frag.firstChild) grid.appendChild(frag.firstChild);
      shown += next.length;
      moreWrap.hidden = shown >= list.length;
      if (!list.length) {
        grid.innerHTML = '<p class="aao-reviews__empty">No reviews with that rating yet.</p>';
      }
      bindPhotos();
    }

    function bindPhotos() {
      grid.querySelectorAll('.aao-review__photo').forEach(function (btn) {
        if (btn.__aaoBound) return;
        btn.__aaoBound = true;
        btn.addEventListener('click', function () {
          var card = btn.closest('.aao-review');
          var cards = Array.prototype.slice.call(grid.querySelectorAll('.aao-review'));
          var list = visible();
          var review = list[cards.indexOf(card)];
          if (!review) return;
          openLightbox(review.photos || [], Number(btn.getAttribute('data-photo-index')) || 0, review.author);
        });
      });
    }

    moreBtn.addEventListener('click', function () {
      draw(false);
    });

    var header = root.querySelector('.aao-reviews__header');
    var distBtn = root.querySelector('[data-aao-dist]');
    distBtn.addEventListener('click', function () {
      var open = header.getAttribute('data-dist-open') === 'true';
      header.setAttribute('data-dist-open', open ? 'false' : 'true');
      distBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
    });

    root.querySelectorAll('.aao-reviews__dist-row').forEach(function (row) {
      function toggle() {
        var v = Number(row.getAttribute('data-rating'));
        filter = filter === v ? 0 : v;
        root.querySelectorAll('.aao-reviews__dist-row').forEach(function (r) {
          r.setAttribute('aria-pressed', Number(r.getAttribute('data-rating')) === filter ? 'true' : 'false');
        });
        draw(true);
      }
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    });

    draw(true);
    wireForm(root, handle);
    injectJSONLD(root, entry, productName, productUrl);
  }

  /* --- rating badges (product cards / PDP inline) -------------------------------------------- */

  function renderBadge(el, data) {
    var entry = entryFor(data, el.getAttribute('data-handle'));
    if (!entry || !entry.count) {
      if (el.getAttribute('data-show-empty') !== 'true') return;
      el.innerHTML = '';
      return;
    }
    var showCount = el.getAttribute('data-hide-count') !== 'true';
    el.innerHTML =
      starsHTML(entry.avg, entry.avg + ' out of 5 stars') +
      (showCount ? '<span class="aao-rating__count">(' + entry.count + ')</span>' : '');
    el.setAttribute('data-rating', entry.avg);
    el.setAttribute('data-count', entry.count);
  }

  /* --- boot ---------------------------------------------------------------------------------- */

  function hydrate(scope) {
    var host = scope || document;
    var widgets = host.querySelectorAll('.aao-reviews[data-handle]:not([data-aao-ready])');
    var badges = host.querySelectorAll('.aao-rating[data-handle]:not([data-aao-ready])');
    if (!widgets.length && !badges.length) return;

    load().then(function (data) {
      widgets.forEach(function (el) {
        el.setAttribute('data-aao-ready', '');
        try {
          renderWidget(el, data);
        } catch (e) {
          if (window.console) console.error('[aao-reviews]', e);
        }
      });
      badges.forEach(function (el) {
        el.setAttribute('data-aao-ready', '');
        try {
          renderBadge(el, data);
        } catch (e) {
          if (window.console) console.error('[aao-reviews]', e);
        }
      });
    });
  }

  window.AAOReviews = { hydrate: hydrate, load: load, stars: starsHTML };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      hydrate();
    });
  } else {
    hydrate();
  }

  /* Prestige swaps sections in via the Section Rendering API (quick view, variant changes,
     infinite-scroll collections, theme editor). Re-hydrate whatever arrives. */
  document.addEventListener('shopify:section:load', function () {
    hydrate();
  });
  if (window.MutationObserver) {
    var queued = false;
    new MutationObserver(function (records) {
      if (queued) return;
      for (var i = 0; i < records.length; i++) {
        if (records[i].addedNodes.length) {
          queued = true;
          requestAnimationFrame(function () {
            queued = false;
            hydrate();
          });
          return;
        }
      }
    }).observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
})();
