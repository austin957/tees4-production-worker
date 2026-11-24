# Phase 6 Shopify read-only integration

The worker uses Shopify's GraphQL Admin API to inspect products by their authoritative Shopify GIDs, page through variants, and compare them with an explicitly bound Master Input row. Shopify commands bypass the worker queue and the simulated writer adapters. They can run during the 4:20–9:10 PM America/Chicago protected window.

## Authorize the first supervised connection

1. Have the store owner create a dedicated app in the Shopify Dev Dashboard for a shop and app owned by the same Shopify organization. Configure and release an app version with **only `read_products`**, then install that version on the intended shop as an authorized administrator. This integration uses Shopify's client credentials grant for that ownership model. Confirm the arrangement with Shopify if the app and store belong to different organizations, since this grant is unsuitable for that case. [Shopify client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant)
2. Obtain the shop's canonical `*.myshopify.com` domain. Use a trusted admin record or the identity bootstrap below to obtain the authoritative `gid://shopify/Shop/…`. Arrange narrowly scoped HTTPS access to that exact hostname. If the environment requires an HTTP proxy, configure the approved Node 24 proxy environment, including `NODE_USE_ENV_PROXY=1` where appropriate.
3. Supply the dedicated app's client ID and secret through the approved environment secret mechanism. Use process environment variables exposed securely to the worker. Keep secret values out of commands, logs, shell history and the repository.
4. Confirm the requested API version and schema with Shopify, then run `shopify-auth`. Check the returned GID, domain, API version, and scopes against the intended shop. The worker stops if Shopify returns a different API version or the app carries additional scopes. [Shopify API versioning](https://shopify.dev/docs/api/usage/versioning)
5. For the first supervised comparison, provide one known Shopify product GID, its complete variant IDs and expected options, and the matching Master Input row and SKUs. Provide read-only Google Sheets access and an approved selection policy, or use a sanitized sheet fixture to isolate the Shopify verification. [Google Sheets authorization guide](google-sheets.md)

| Environment variable | Purpose |
| --- | --- |
| `TEES4_SHOPIFY_DOMAIN` | Canonical lowercase shop hostname without scheme, path or port |
| `TEES4_SHOPIFY_SHOP_ID` | Independently verified `gid://shopify/Shop/…` |
| `TEES4_SHOPIFY_CLIENT_ID` | Dev Dashboard app client ID |
| `TEES4_SHOPIFY_CLIENT_SECRET` | Dev Dashboard app secret supplied securely at runtime |
| `TEES4_SHOPIFY_API_VERSION` | Optional quarterly version override. This phase targets `2026-10` |

The client exchanges app credentials at the shop's OAuth token endpoint. It keeps the expiring token in memory only. Requests use HTTPS, reject redirects, and send only fixed GraphQL queries. The client verifies shop identity and app scopes before retrieving a product. It retries transient failures within a bounded budget and respects HTTP `Retry-After` and GraphQL throttle information. CLI errors omit credential values, tokens, and raw response bodies.

## Bootstrap a missing Shop GID

With the approved shop domain, API version, and app credentials configured, run:

```sh
npm run --silent worker -- shopify-identify
```

This command exercises the same OAuth grant and version checks and queries only shop identity and app scopes. It verifies the configured domain and the `read_products`-only scope, then prints the reported GID, without changing environment settings. The owner must confirm this GID for the intended store and set `TEES4_SHOPIFY_SHOP_ID` before running `shopify-auth` or any product command. They continue to require an exact configured GID match.

## Inspect products and variants

After `npm ci` and `npm run build`, run the following commands from the repository root. Replace the product example with the authoritative GID.

```sh
npm run --silent worker -- shopify-auth
npm run --silent worker -- shopify-products
npm run --silent worker -- shopify-product gid://shopify/Product/2
npm run --silent worker -- shopify-provenance gid://shopify/Product/2
npm run --silent worker -- shopify-variants gid://shopify/Product/2
```

`shopify-products` lists up to five recent product GIDs and titles for inspection. It does not match products to sheet rows or create bindings. `shopify-provenance` reads the creation time, tags, and the first 25 metafield names visible to the app, without fetching metafield values. A tag or matching title is not independent evidence of the creating app or the source row. Product output includes the lifecycle status and the Online Store publication timestamp. Those fields do not establish publication to other sales channels. Variant SKU strings come from the product variant query and are preserved exactly. The query does not require extra inventory scopes. Shopify may change a product while pagination is in progress, so treat the output as an inspection of current data rather than a lock on the product. [Shopify Product query reference](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/product)

## Audit the Hextom readiness queue

```sh
npm run --silent worker -- shopify-adjust
npm run --silent worker -- shopify-adjust gid://shopify/Product/10461800792355
```

The audit queries Shopify with `tag:adjust` and pages through the results. Shopify search can also return case variants. The worker checks the stored tags for the exact lowercase string `adjust`. It reports other search results separately and preserves all tag capitalization. If pagination cannot finish within 250 pages or Shopify repeats a cursor, the command fails without returning a partial count. Give the command a GID to audit one product regardless of its tags. [Shopify products search](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/products)

The output groups products into four mutually exclusive patterns and lists each product's GID, status, creation and update timestamps, options, variant count, and counts of exact SKU values.

| Pattern | Observation |
| --- | --- |
| `uniform` | Every variant has the same populated SKU |
| `distinct` | Every variant has a different populated SKU |
| `blank_or_partial_blank` | At least one SKU is null or empty, with no other anomaly |
| `anomalous` | No variants, missing or repeated variant IDs, SKUs with whitespace alone or around the value, or a mix of repeated and distinct populated SKUs |

Tagged products with multiple variants sharing one SKU are possible pre-Hextom candidates. Tagged products with fully distinct SKUs are possible post-Hextom candidates. These labels describe patterns for review. They do not establish Hextom completion, Mockupify provenance, or a Master Input binding. Shopify's filter and the worker's case check say nothing about Hextom's own case-matching behavior. That requires checking Hextom's actual configured rule.

The audit can run before, during, or after the **4:20–9:10 PM America/Chicago** protected window for exports and initial SKU writes. Compare snapshots by product GID without modifying tags, SKUs, or Hextom settings. Shopify data can change during a scan, so each snapshot reflects the observations made during that run.

## Verify Hextom SKU completion

```sh
npm run --silent worker -- shopify-hextom-verify gid://shopify/Product/2 --verified-base-sku 'OWNER_VERIFIED_PRODUCT_SKU'
npm run --silent worker -- shopify-hextom-verify gid://shopify/Product/2
```

Replace the example with a product GID verified independently and the original Product SKU from a trusted assignment or export record. Passing `--verified-base-sku` asserts that the caller verified the base belongs to this product. If that evidence is missing, omit the flag. The verifier does not infer a base from the title, the `adjust` tag, or any current SKU.

The verifier reads all variant pages and uses Shopify's configured option positions 1 and 2, matching each variant by the corresponding option names. It constructs `[verified_base_sku]-[option1]-[option2]` exactly once from the original strings, including spaces and hyphens where present. Reports preserve the current SKU alongside its expected value. Repeated transformations, duplicate final values, ambiguous options, missing values and partially transformed products are flagged. Shopify updates detected during pagination stop the read so the operator can repeat it with a fresh snapshot.

| Status | Meaning |
| --- | --- |
| `PENDING_HEXTOM` | Every variant still has the verified base SKU, option and variant data are unambiguous, and exact lowercase `adjust` is present |
| `VERIFIED_COMPLETE` | Every variant exactly matches the expected one-time transformation with unambiguous variant IDs and expected SKUs, regardless of whether the tag remains |
| `NEEDS_RECONCILIATION` | The caller did not supply a verified original base SKU |
| `MANUAL_REVIEW` | A mismatch, duplicate, missing value or other ambiguity exists, including initial SKUs after the exact tag is absent |

The verified Hextom configuration displays a daily 6:15 PM SKU transformation and a 9:00 PM tag removal in its local time. Its displayed timezone is still unverified against task history, and the verifier does not use those times to infer outcomes. `VERIFIED_COMPLETE` verifies the SKU result only. It does not prove which app performed the change, establish a Master Input binding, or mark a sheet row complete. Reads remain independent of the 4:20–9:10 PM America/Chicago protection for exports and initial SKU writes.

## Audit the production stage

```sh
npm run --silent worker -- shopify-production-audit <product-gid> --candidate-base-sku <supplied-sku>
npm run --silent worker -- shopify-production-audit <product-gid> --verified-source /path/to/verified-source.json --read-master-input
```

Use a [reviewed source record](shopify-reconciliation.md#verify-source-evidence) that links the shop and product GIDs to the original garment's Product and Artwork SKUs. An owner-reviewed Master Input record must include the physical row. A Mockupify export record also requires an unambiguous live Master Input row. A conflicting live row prevents verification. Use `--read-master-input` to read columns H, I and K with the read-only connection. Use `--header-row` to select a known header below row 1. Column I (`Tees-4 Completed`) is displayed for a matching live row and can flag discrepancies between the sheet and Shopify. The SKU and tag checks determine the stage.

| Status | Evidence |
| --- | --- |
| `SKU_PREPARATION_IN_PROGRESS` | Exact lowercase `adjust`, a verified source, and initial SKUs mixed with blanks or other unresolved SKU values. An entirely blank set can also be awaiting preparation. The report lists the affected variants. |
| `READY_FOR_HEXTOM` | Exact lowercase `adjust`, a verified source, and every variant carrying the exact base SKU with unambiguous variant IDs and options. |
| `HEXTOM_PROCESSING_OR_PENDING` | Exact lowercase `adjust` and a mix of the verified base and exact final SKUs, or every SKU is verified final while the tag is still present. |
| `VERIFIED_COMPLETE` | Every variant has its exact once-transformed SKU and the exact lowercase tag is absent. |
| `NEEDS_RECONCILIATION` | The Master Input linkage is unverified or conflicting, or Shopify changed between reads. |
| `MANUAL_REVIEW` | The verified source and Shopify state require review, for example duplicate transformations, invalid variant IDs or options, unexpected SKUs in a partially transformed set, or missing `adjust` with unfinished SKU work. |

A supplied candidate SKU supports a comparison of the stored variant values. The report can show an `observedStage` of `SKU_PREPARATION_IN_PROGRESS` if some variants match the supplied SKU and others still have preparation exceptions. The audit status remains `NEEDS_RECONCILIATION` until the source is verified.

The audit compares two complete Shopify reads, including the SKU, option and tag data. If a product changes during pagination or between snapshots, run a fresh audit. The command performs reads only. The existing daily **4:20 PM inclusive to 9:10 PM exclusive America/Chicago** protection for exports and initial SKU writes still applies.

## Compare a binding with Master Input

Prepare a binding manifest using the IDs verified during Mockupify reconciliation or independently verified in Shopify. The [example manifest](../examples/shopify-readonly-bindings.json) extends the Phase 5 binding with the shop GID and the complete expected variants. Record the physical row, both assigned SKUs, and the Mockupify export reference when available. Use the exact Shopify option names if they differ from `Size` or `Color`. A null expected option value declares that the variant should have no such option.

```sh
npm run --silent worker -- shopify-compare /path/to/bindings.json 2 /path/to/artwork-selection.json /path/to/sheet-policy.json
npm run --silent worker -- shopify-preview /path/to/bindings.json 2 /path/to/sheet-fixture.json --fixture
```

The live Sheet comparison verifies the selected eligible row and its Artwork and Product SKUs through the existing Sheets read adapter. Fixture mode reads a local snapshot. Neither creates a binding or modifies it. The comparison flags conflicting IDs, variants without IDs, missing or unbound variants, differing size or color values, and unexpected nonblank SKUs. It compares the assigned colors as comma-separated labels when the binding declares a Shopify color option. It reports blank and exact temporary SKUs separately. Unexpected nonblank values remain opaque because their origin may be Hextom or another process. A preview proposes only blank assignments for an otherwise verified product and performs zero writes.

## Verification and future write work

Automated tests use mocked Shopify responses. Use the commands above to verify live connectivity and schema compatibility against the intended shop and API version.

A future write integration needs separate authorization, an explicitly scoped identity, and a supervised test store. It must revalidate the shop, product and variant bindings and current SKU immediately before writing, preserve any nonblank SKU, enforce the America/Chicago protected window, and reconcile interrupted or ambiguous operations before retrying.
