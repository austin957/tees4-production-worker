# Tees-4 Production Worker development instructions

- Develop in the existing checkout. Use Node.js 24, TypeScript, and the committed npm lockfile.
- Use `npm ci` to install. Run `npm run typecheck`, `npm test`, and `npm run build` before handing off changes.
- Keep platform integrations behind platform-specific adapters. Keep workflow decisions, persistence, and command-line handling out of adapters where possible.
- Keep dry-run mode the default. Dry-run may persist local job state and must bypass all write adapter methods.
- Use simulation and synthetic fixtures. Keep live production endpoints and credentials out of configuration, tests, and documentation. Do not request production credentials, add paid services, or change other Tees-4 repositories.
- Use the supplied artwork and assigned SKU. Never generate artwork or SKUs, overwrite artwork, omit designer attribution, or publish without explicit approval.
- For initial Shopify variant SKU assignment, write only to blank variants outside the protected 5–9 PM America/Chicago window. Preserve every existing nonblank SKU and stop on ambiguous product bindings.
- Stop and surface missing or conflicting required information. Record business rules only when the owner has documented them. Label fixture conventions as such.
- Preserve completed checkpoints and stable write identities across retries. Cover approval, duplicate prevention, and recovery when changing queue or adapter behavior.
- Use ignored local storage for queue databases. Keep fixture data synthetic and avoid logging raw adapter exceptions or secrets.
- Keep pull requests in draft when requested. Publication, deployment, and merge require separate authorization.
