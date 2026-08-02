# Repository Workflow

- Develop features on `dev`; keep `main` release-ready.
- Every push to `main` can publish the package after CI passes.
- Use Conventional Commits: `feat:` releases a minor version, `fix:` releases a patch, and `feat!:` / `fix!:` or `BREAKING CHANGE` releases a major version.
- `docs:`, `test:`, `ci:`, `chore:`, and other non-release commits do not publish a version.
- Do not edit versions, tags, or `CHANGELOG.md` manually; semantic-release owns them.
- Before merging to `main`, run `npm run typecheck`, `npm test`, and `npm run build`.
- The release workflow publishes npm only. It must not deploy or modify the production Koishi server.
