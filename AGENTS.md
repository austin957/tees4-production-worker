# Tees-4 Production Worker development instructions

- Develop in the existing checkout. Use Node.js 24, TypeScript, and the committed npm lockfile.
- Use `npm ci` to install. Run `npm run typecheck`, `npm test`, and `npm run build` before handing off changes.
- Keep platform integrations behind platform-specific adapters. Keep workflow decisions, persistence, and command-line handling out of adapters where possible.
- Keep dry-run mode the default. Dry-run may persist local job state and must bypass all write adapter methods.
- Keep Mockupify and Shopify simulated and use synthetic test data. The Google Sheets adapter may read the authorized Master Input tab through ADC and must use read-only access. Keep secrets out of the repository and logs. Do not add paid services or change other Tees-4 repositories.
- Use the supplied artwork and assigned SKU. Never generate artwork or SKUs, overwrite artwork, omit designer attribution, or publish without explicit approval.
- Protect new Mockupify exports and initial Shopify variant SKU writes daily from 4:20 PM inclusive to 9:10 PM exclusive America/Chicago. Check the clock immediately before each write. Defer blocked work without spending a retry attempt or resetting checkpoints.
- Require an explicitly configured Mockupify export safety margin and start a new export only when more than that margin remains before the next 4:20 PM cutoff.
- Assign initial Shopify SKUs only to blank variants. Preserve every existing nonblank SKU, flag unexpected values for review, and stop on ambiguous product bindings.
- Stop and surface missing or conflicting required information. Record business rules only when the owner has documented them. Label fixture conventions as such.
- Preserve completed checkpoints and stable write identities across retries. Cover approval, duplicate prevention, and recovery when changing queue or adapter behavior.
- Use ignored local storage for queue databases. Keep fixture data synthetic and avoid logging raw adapter exceptions or secrets.
- Keep pull requests in draft when requested. Publication, deployment, and merge require separate authorization.
