# Engage CLI and MCP

Use the mathias-engineering skill. This public repository contains the Engage operator client only. Never copy backend sources, Git history, environment files, credentials or stored sessions here.

- `engagectl` and its stdio MCP server share one authenticated HTTP client and the running backend's OpenAPI catalog. Keep one implementation of discovery, schema inspection and execution.
- Authenticate directly with Identity using the separate public NATIVE engagectl client and Authorization Code/PKCE. Never reuse engage-console or its secret/session. Engage verifies the Identity code and ID token before issuing its own session. Never use integration keys or match accounts by email. Preserve live backend permissions, workspace scoping and private media/publication rules.
- Sessions must be private and pinned to API origin, user and workspace. Never log session tokens or forward cookies across redirects. Keep TLS verification enabled and preserve system/extra CA trust.
- Model closed domain/API vocabularies with enums. Keep application behavior independent of packaging.
- Ship standalone executables built with the pinned Node runtime. `engagectl mcp` must work without a checkout, Node installation or node_modules. Do not publish to npm.
- Version comes from package.json. GitHub Actions builds and tests Linux/macOS/Windows artifacts on matching hosts and architectures. Publication is automatic only for pushed stable vX.Y.Z tags matching package.json, after every artifact passed; immutable releases must never be overwritten.
- Run `pnpm check`, `pnpm package`, and the tests against the packaged executable before delivery. Review the entire diff and public file inventory for secrets and unrelated content.
- Do not commit, push, publish a release or change external settings without explicit authorization. Use Conventional Commits with a meaningful body for nontrivial changes.
