# Phase 10 product matching

`shopify-match` reads Shopify products with the exact lowercase `adjust` tag and compares them with physical rows in Design Input Master's **Master Input** tab. It reads B (title), D (vendor), E (garment), F (colors), G (tags), H (Product SKU), I (Tees-4 Completed), and K (Artwork SKU). Column I is shown for context. A completed row can still be tagged while Hextom is pending. The workflow does not require historical Mockupify exports.

```sh
npm run build
npm run --silent worker -- shopify-match
npm run --silent worker -- shopify-match --confirmations /path/to/owner-confirmations.json
```

## Candidate reports

The report ranks candidates per Shopify product and identifies competing rows. Titles, vendors, garment labels, color sets, and overlapping non-workflow tags are compared after case-folding, trimming and collapsing runs of whitespace. Garment evidence comes from Shopify's `productType`. Colors come from the single Shopify option named Color or Colour and the Sheet's comma-separated color labels. No garment or color mapping is inferred from a product title. SKU comparisons preserve exact strings and report a match to the initial SKU or to a possible one-time Hextom transformation separately.

Title matches use four points, matching garment types use three, matching color sets use two, and vendor or tag matches use one each. Initial or transformed SKU matches contribute five points. A title match, exact observed SKU match, or matching garment plus color or tag evidence admits a candidate. A single signal or a conflict has low confidence. For non-conflicting rows with multiple signals, nine or more points is high confidence and lower scores are medium. This is a review order without a statistical confidence guarantee. Equal top candidates and two Shopify products competing for one top row are flagged. Neither an exact title nor an exact SKU verifies the identity.

The [synthetic fixture](../examples/matching-sheet-fixture.json) can be used with `--sheet-fixture` for non-authoritative comparison. A fixture can never support a proposal. The command reports unavailable access separately from a live sheet with no matching rows.

## Owner confirmation

Independently check the physical row and exact H/K values plus the Shopify product GID in the intended shop. Resolve ambiguous rows or products using trusted operational evidence. Include each reviewed row once in an owner-confirmation JSON array. Use the current set of known confirmations together to check for duplicate assignments in the same run. For example:

```json
[
  {
    "spreadsheetId": "1UxdIY03ICu5t2G0fEo0nor6-giAEF4xdMuNEvYN_JMM",
    "rowNumber": 2,
    "productSku": "000710",
    "artworkSku": "00042",
    "shopId": "gid://shopify/Shop/1",
    "productId": "gid://shopify/Product/2",
    "confirmedBy": "Owner name"
  }
]
```

Pass the file with `--confirmations`. This is an explicit owner attestation. The worker validates the current live row and exact SKUs, the configured shop and current Shopify product GID, and the complete unique variant IDs. It refuses proposals for missing rows or conflicting or repeated assignments. A product explicitly confirmed by GID may be re-read after Hextom has removed its tag. Successful results return an `OWNER_REVIEW_REQUIRED` binding proposal in JSON. Keep owner files in approved local storage. The command neither saves a permanent binding nor changes Shopify, Sheets or Hextom.

For a future approved assignment workflow, persist reviewed bindings in a registry with unique shop/product and sheet/row keys. Re-read that binding and the current SKU immediately before any write. Require explicit write approval, preserve every nonblank SKU, and enforce the 4:20–9:10 PM America/Chicago protected window. This command performs reads and produces proposals only.

## Connect Google Sheets securely

1. Enable the Sheets API in the approved Google Cloud project and grant the principal Viewer access to Design Input Master.
2. Configure approved Google Application Default Credentials with the `spreadsheets.readonly` scope. If the approved setup requires a credential file, keep it outside the repository and configure only its protected path through `GOOGLE_APPLICATION_CREDENTIALS`. Do not put credentials in confirmation or fixture JSON.
3. Allow HTTPS to `sheets.googleapis.com` and the identity provider's required token endpoint, such as `oauth2.googleapis.com`, in the environment's egress settings.
4. Run `shopify-match`. The report should show a live Master Input source. Use `--header-row N` if the verified header is below the first row. The command stops the Sheet comparison when headers fail validation. [Sheets authorization guide](google-sheets.md)
