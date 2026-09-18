#!/usr/bin/env python3
"""
Turn a Loox harvest into the theme assets the native review widget reads.

Why this is not a straight copy
-------------------------------
The harvest looks like 17,993 reviews but holds only 185 distinct ones. Loox served a shared
"showcase" feed on products that had no reviews of their own, so the same review set is repeated
across many handles. Measured on the 2026-09-18 harvest:

    8 shared review sets  covering 251 handles   (every review in them appears on 2+ handles)
   11 unique review sets  covering  11 handles   (15 reviews, each appearing on exactly one handle)

Storing that verbatim would mean 3.3MB of near-identical assets, so each distinct review SET is
written once and the summary points every handle at the set it displays.

Output
------
    assets/aao-reviews-summary.json      one row per handle:
                                           avg, count       what the PDP displays today (parity)
                                           own_avg, own_count  its genuine, product-specific reviews
                                           pool             true when it has no reviews of its own
                                           src              which asset holds its review list
    assets/aao-reviews-store.json        the dominant shared set (the store-wide showcase feed)
    assets/aao-reviews-set-<hash>.json   the other shared sets
    assets/aao-reviews-p-<handle>.json   one file per product with a review set of its own
    assets/aao-rev-<name>.jpg            review photos, copied off the Loox CDN

Every review carries "own": true/false so the widget can filter to genuine reviews only when the
boot snippet sets genuineOnly (see docs/reviews/README.md).

Photos
------
Pass --photos to rewrite every photo URL to a theme asset. `photos[]` then holds bare asset
filenames; the engine prefixes them with the theme's asset base URL, which the boot snippet
derives from `'aao-reviews.css' | asset_url`. After this runs, nothing in the baked data points at
images.loox.io.

Usage
-----
    python3 docs/reviews/split_reviews.py <harvest.json> \
        --photos <dir-with-photos-index.json> [--assets-dir assets] [--dry-run] [--no-prune]
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from collections import defaultdict

SUMMARY_NAME = "aao-reviews-summary.json"
STORE_NAME = "aao-reviews-store.json"
SET_PREFIX = "aao-reviews-set-"
PRODUCT_PREFIX = "aao-reviews-p-"
PHOTO_PREFIX = "aao-rev-"

SAFE_HANDLE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
SAFE_PHOTO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.(jpg|jpeg|png|webp|gif)$", re.I)


def review_id(r):
    """Identity of a review, used to tell a repeated review from a distinct one."""
    return "%s|%s|%s" % (r.get("author") or "", r.get("date") or "", (r.get("text") or "")[:120])


def set_signature(reviews):
    return hashlib.md5(json.dumps(sorted(review_id(r) for r in reviews)).encode()).hexdigest()


def load_photo_map(photos_dir):
    """original loox URL -> (local file path, asset filename)."""
    index_path = os.path.join(photos_dir, "photos-index.json")
    if not os.path.isfile(index_path):
        sys.exit("error: %s not found" % index_path)
    with open(index_path, encoding="utf-8") as fh:
        idx = json.load(fh)

    mapping = {}
    files = {}
    for entry in idx.get("index", []):
        local = entry.get("local_path")
        if not local:
            continue
        base = os.path.basename(local)
        asset = PHOTO_PREFIX + base
        if not SAFE_PHOTO.match(asset):
            sys.exit("error: photo %r does not make a safe Shopify asset filename" % base)
        src = os.path.join(photos_dir, local) if not os.path.isabs(local) else local
        if not os.path.isfile(src):
            sys.exit("error: photo file %s is missing" % src)
        files[asset] = src
        for key in ("url", "fetched_variant_url"):
            if entry.get(key):
                mapping[entry[key]] = asset
    return mapping, files


def rewrite_photos(review, photo_map, stats):
    out = []
    for url in review.get("photos") or []:
        asset = photo_map.get(url) if photo_map else None
        if asset:
            stats["rewritten"] += 1
            out.append(asset)
        else:
            stats["unmapped"].add(url)
            out.append(url)
    return out


def normalise(entry, holders, photo_map, stats):
    """Sort newest first, recompute avg/count, tag each review as genuine or shared, fix photos."""
    reviews = []
    for r in entry.get("reviews") or []:
        if not isinstance(r, dict):
            continue
        r = dict(r)
        r["photos"] = rewrite_photos(r, photo_map, stats)
        r["own"] = len(holders[review_id(r)]) == 1
        reviews.append(r)
    reviews.sort(key=lambda r: str(r.get("date") or ""), reverse=True)
    return reviews


def avg_of(reviews):
    if not reviews:
        return 0.0
    return round(sum(float(r.get("rating") or 0) for r in reviews) / len(reviews), 1)


def write_json(path, payload, dry_run):
    blob = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    if not dry_run:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(blob)
    return len(blob.encode("utf-8"))


def human(n):
    if n < 1024:
        return "%d B" % n
    if n < 1024 * 1024:
        return "%.1f KB" % (n / 1024.0)
    return "%.2f MB" % (n / 1048576.0)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("harvest", help="path to the harvest JSON")
    ap.add_argument("--photos", help="directory holding photos-index.json and the downloaded files")
    ap.add_argument("--assets-dir", default="assets", help="theme assets directory (default: assets)")
    ap.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    ap.add_argument("--no-prune", action="store_true", help="keep generated assets not in this run")
    args = ap.parse_args()

    if not os.path.isdir(args.assets_dir):
        sys.exit("error: assets directory %r does not exist" % args.assets_dir)

    with open(args.harvest, encoding="utf-8") as fh:
        data = json.load(fh)
    if "products" not in data:
        sys.exit("error: %s has no top-level 'products' map" % args.harvest)
    products = data["products"]

    photo_map, photo_files = ({}, {})
    if args.photos:
        photo_map, photo_files = load_photo_map(args.photos)
    stats = {"rewritten": 0, "unmapped": set()}

    # Which handles carry each distinct review. A review on exactly one handle is that product's own.
    holders = defaultdict(set)
    bad_handles = []
    for handle, entry in products.items():
        if not SAFE_HANDLE.match(handle):
            bad_handles.append(handle)
            continue
        for r in entry.get("reviews") or []:
            holders[review_id(r)].add(handle)

    # Group handles by the exact set of reviews they display.
    by_signature = defaultdict(list)
    prepared = {}
    for handle in sorted(products):
        if handle in bad_handles:
            continue
        reviews = normalise(products[handle] or {}, holders, photo_map, stats)
        if not reviews:
            continue
        prepared[handle] = reviews
        by_signature[set_signature(reviews)].append(handle)

    shared = {s: hs for s, hs in by_signature.items() if len(hs) > 1}
    unique = {s: hs for s, hs in by_signature.items() if len(hs) == 1}

    # The dominant shared set is the store-wide showcase feed and gets the friendly filename.
    dominant = max(shared, key=lambda s: len(shared[s])) if shared else None

    summary = {}
    written = []
    keep = {SUMMARY_NAME}

    def emit(name, reviews, title, product_id):
        payload = {
            "product_id": product_id,
            "title": title,
            "avg": avg_of(reviews),
            "count": len(reviews),
            "reviews": reviews,
        }
        size = write_json(os.path.join(args.assets_dir, name), payload, args.dry_run)
        written.append((name, size, len(reviews)))
        keep.add(name)

    for signature, handles in sorted(shared.items(), key=lambda kv: -len(kv[1])):
        reviews = prepared[handles[0]]
        name = STORE_NAME if signature == dominant else SET_PREFIX + signature[:8] + ".json"
        emit(name, reviews, "Customer reviews", None)
        for handle in handles:
            summary[handle] = {
                "avg": avg_of(reviews),
                "count": len(reviews),
                "own_avg": 0.0,
                "own_count": 0,
                "pool": True,
                "src": name,
            }

    for signature, handles in unique.items():
        handle = handles[0]
        reviews = prepared[handle]
        name = PRODUCT_PREFIX + handle + ".json"
        emit(name, reviews, (products[handle] or {}).get("title") or "", (products[handle] or {}).get("product_id"))
        own = [r for r in reviews if r["own"]]
        summary[handle] = {
            "avg": avg_of(reviews),
            "count": len(reviews),
            "own_avg": avg_of(own),
            "own_count": len(own),
            "pool": len(own) == 0,
            "src": name,
        }

    summary_bytes = write_json(
        os.path.join(args.assets_dir, SUMMARY_NAME),
        {
            "generated_at": data.get("generated_at"),
            "store": data.get("store"),
            "products": dict(sorted(summary.items())),
        },
        args.dry_run,
    )

    # Photos
    copied = 0
    photo_bytes = 0
    for asset, src in sorted(photo_files.items()):
        keep.add(asset)
        dest = os.path.join(args.assets_dir, asset)
        photo_bytes += os.path.getsize(src)
        if not args.dry_run:
            shutil.copyfile(src, dest)
        copied += 1

    pruned = []
    if not args.no_prune:
        for name in sorted(os.listdir(args.assets_dir)):
            generated = (
                name == STORE_NAME
                or name.startswith(SET_PREFIX)
                or name.startswith(PRODUCT_PREFIX)
                or name.startswith(PHOTO_PREFIX)
            )
            if generated and name not in keep:
                pruned.append(name)
                if not args.dry_run:
                    os.remove(os.path.join(args.assets_dir, name))

    review_assets = sum(size for _, size, _ in written) + summary_bytes
    written.sort(key=lambda row: row[1], reverse=True)
    genuine = [h for h, row in summary.items() if not row["pool"]]

    print("harvest         : %s" % args.harvest)
    print("generated_at    : %s" % data.get("generated_at"))
    print("products in     : %d (%d with reviews)" % (len(products), len(summary)))
    print("distinct reviews: %d across %d review rows"
          % (len(holders), sum(row["count"] for row in summary.values())))
    print("shared sets     : %d, covering %d handles (pool: no reviews of their own)"
          % (len(shared), sum(len(h) for h in shared.values())))
    print("genuine products: %d, %d reviews unique to one product"
          % (len(genuine), sum(summary[h]["own_count"] for h in genuine)))
    print("summary         : %s (%d rows, %s)" % (SUMMARY_NAME, len(summary), human(summary_bytes)))
    print("review assets   : %d files, %s (incl. summary)" % (len(written), human(review_assets)))
    for name, size, n in written[:5]:
        print("                  %-34s %8s  %4d reviews" % (name, human(size), n))
    if copied:
        print("photos          : %d files, %s (%d URLs rewritten to theme assets)"
              % (copied, human(photo_bytes), stats["rewritten"]))
    if stats["unmapped"]:
        print("WARNING         : %d photo URLs had no entry in photos-index.json and were left "
              "pointing at their original host" % len(stats["unmapped"]))
        for url in sorted(stats["unmapped"])[:5]:
            print("                  %s" % url)
    if pruned:
        print("pruned          : %d stale generated files" % len(pruned))
    if bad_handles:
        print("WARNING         : %d handles are not asset-filename safe and were SKIPPED" % len(bad_handles))
        for h in bad_handles[:5]:
            print("                  %s" % h)
    print("total written   : %s" % human(review_assets + photo_bytes))
    if args.dry_run:
        print("\n(dry run - nothing written)")


if __name__ == "__main__":
    main()
