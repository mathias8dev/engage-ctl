# Changelog

Notable changes are reviewed per release. Versions follow Semantic Versioning.

## [Unreleased]

## [0.2.0] - 2026-11-26

- Authenticate directly with Identity using Authorization Code/S256 PKCE and rotating refresh tokens, shared by CLI and MCP.
- Add `login --issuer` and `ENGAGECTL_ISSUER`, pinned against the selected Engage API configuration.
- Refresh expired access tokens (or within 60 seconds of expiry), serialize refresh and persist new tokens before API calls.
- Revoke the Identity refresh family on logout; retain sessions on failed revocation and preserve original login freshness.
- Require the new Engage protected-resource backend and OAuth registration. Legacy cookie sessions must be archived and replaced by a new login.

### Added

- **release**: standardize reviewed semantic releases (`c0816f15`)
- **auth**: renew native OAuth sessions directly with Identity (`c47acd50`)
