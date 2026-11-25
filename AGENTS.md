# LabKit repository instructions

- Read README.md, docs/DEVELOPMENT.md and docs/CONTRACT.md before changing public behavior.
- Keep SDK code independent of laboratories. Do not move domain models, DSP or musical transport into the SDK without evidence of a reusable primitive.
- Preserve public package boundaries, canonical per-instance state, explicit capabilities, lifecycle cleanup and test seams.
- Use ESLint, Prettier and strict TypeScript; do not introduce competing formatting tools or broad lint exceptions.
- Run npm run verify and the relevant consumer checks before merging. Update tests and current documentation with behavioral changes.
- Keep comments concise and explain decisions and invariants. Put planned work in Issues, not in implementation commentary.
- Preserve released tags; follow docs/RELEASING.md for version changes. Never commit credentials or generated artifacts.
