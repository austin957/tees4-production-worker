# Phase 6 Shopify read-only integration

The worker uses Shopify's GraphQL Admin API to inspect products by their authoritative Shopify GIDs, page through variants, and compare them with an explicitly bound Master Input row. Shopify commands bypass the worker queue and the simulated writer adapters. They can run during the 4:20–9:10 PM America/Chicago protected window.

## Authorize the first supervised connection

1. Have the store owner create a dedicated app in the Shopify Dev Dashboard for a shop and app owned by the same Shopify organization. Configure and release an app version with **only `read_products`**, then install that version on the intended shop as an authorized administrator. This integration uses Shopify's client credentials grant for that ownership model. Confirm the arrangement with Shopify if the app and store belong to different organizations, since this grant is unsuitable for that case. [Shopify client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant)
2. Obtain the shop's canonical `*.myshopify.com` domain and authoritative `gid://shopify/Shop/…` from a trusted admin record or independently authorized read. Arrange narrowly scoped HTTPS access to that exact hostname. If the environment requires an HTTP proxy, configure the approved Node 24 proxy environment, including `NODE_USE_ENV_PROXY=1` where appropriate.
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

## Inspect products and variants

After `npm ci` and `npm run build`, run the following commands from the repository root. Replace the product example with the authoritative GID.

```sh
npm run --silent worker -- shopify-auth
npm run --silent worker -- shopify-product gid://shopify/Product/2
npm run --silent worker -- shopify-variants gid://shopify/Product/2
```

Product output includes the lifecycle status and the Online Store publication timestamp. Those fields do not establish publication to other sales channels. Variant SKU strings come from the product variant query and are preserved exactly. The query does not require extra inventory scopes. Shopify may change a product while pagination is in progress, so treat the output as an inspection of current data rather than a lock on the product. [Shopify Product query reference](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/product)

## Compare a binding with Master Input

Prepare a binding manifest using the IDs verified during Mockupify reconciliation or independently verified in Shopify. The [example manifest](../examples/shopify-readonly-bindings.json) extends the Phase 5 binding with the shop GID and the complete expected variants. Record the physical row, both assigned SKUs, and the Mockupify export reference when available. Use the exact Shopify option names if they differ from `Size` or `Color`. A null expected option value declares that the variant should have no such option.

```sh
npm run --silent worker -- shopify-compare /path/to/bindings.json 2 /path/to/artwork-selection.json /path/to/sheet-policy.json
npm run --silent worker -- shopify-preview /path/to/bindings.json 2 /path/to/sheet-fixture.json --fixture
```

The live Sheet comparison verifies the selected eligible row and its Artwork and Product SKUs through the existing Sheets read adapter. Fixture mode reads a local snapshot. Neither creates a binding or modifies it. The comparison flags conflicting IDs, variants without IDs, missing or unbound variants, differing size or color values, and unexpected nonblank SKUs. It compares the assigned colors as comma-separated labels when the binding declares a Shopify color option. It reports blank and exact temporary SKUs separately. Unexpected nonblank values remain opaque because their origin may be Hextom or another process. A preview proposes only blank assignments for an otherwise verified product and performs zero writes.

## Verification and future write work

Automated tests use mocked Shopify responses. The cloud proxy denied access to `shopify.dev`, and the environment supplied neither a Tees-4 shop hostname nor an authorized app identity. The `2026-10` production schema and live connectivity therefore remain unverified.

A future write integration needs separate authorization, an explicitly scoped identity, and a supervised test store. It must revalidate the shop, product and variant bindings and current SKU immediately before writing, preserve any nonblank SKU, enforce the America/Chicago protected window, and reconcile interrupted or ambiguous operations before retrying.
