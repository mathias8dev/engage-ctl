# engage-ctl

`engagectl` is the standalone command-line client and local MCP server for Engage.
It performs console actions as the signed-in user, using the backend's current
permissions, workspace boundaries and API contracts.

## Install

Install the [latest stable release](https://github.com/mathias8dev/engage-ctl/releases/latest)
on Linux or macOS directly from the installer hosted in this repository:

```sh
curl -fsSL https://raw.githubusercontent.com/mathias8dev/engage-ctl/main/install.sh | sh
engagectl --version
```

The installer defaults to `latest`, resolves GitHub's latest published stable
release, detects your OS and architecture, verifies the archive's SHA-256 and
installs into `~/.local/bin`. Add that directory to PATH if needed. No Node.js,
npm, pnpm or source checkout is required. Run the same command again to upgrade.

To select a specific version:

```sh
curl -fsSL https://raw.githubusercontent.com/mathias8dev/engage-ctl/main/install.sh | sh -s -- 0.2.0
```

Set `ENGAGECTL_BIN_DIR` on the `sh` process to choose another directory:

```sh
curl -fsSL https://raw.githubusercontent.com/mathias8dev/engage-ctl/main/install.sh | ENGAGECTL_BIN_DIR="$HOME/bin" sh
```

The installer replaces an existing binary only after the archive's checksum has
been verified. The raw `main` URL always serves the current installer; the
optional version argument selects the released binary to install.

On Windows, run the PowerShell installer directly:

```powershell
& ([scriptblock]::Create((Invoke-RestMethod https://raw.githubusercontent.com/mathias8dev/engage-ctl/main/install.ps1)))
```

It also defaults to the latest stable release. Append `-Version 0.2.0` to select
a specific version. It installs into `%LOCALAPPDATA%\Programs\engage-ctl` and
adds that directory to the current user's PATH. Open a new terminal afterward.
Stop running CLI/MCP processes before replacing the Windows executable.

With [mise](https://mise.jdx.dev/dev-tools/backends/github.html), install the
latest release globally:

```sh
mise use -g github:mathias8dev/engage-ctl@latest
mise exec -- engagectl --version
```

Or pin a version per project with
`mise use github:mathias8dev/engage-ctl@0.2.0`. Recent mise versions delay `latest`
by 24 hours by default. Pin the new version explicitly to install it immediately,
for example `mise use -g github:mathias8dev/engage-ctl@0.2.0`.

All installation methods require a published GitHub Release; CI build artifacts
alone are not installable through these release URLs.

For manual installation, download the archive for your OS and architecture from
[GitHub Releases](https://github.com/mathias8dev/engage-ctl/releases/latest), and
verify its SHA-256 against the release's `SHA256SUMS` file. Archives contain a
single `engagectl` binary (`engagectl.exe` on Windows), build provenance and licenses.
You can also download an installer to inspect it before running it.

| System | Architectures | Archive |
| --- | --- | --- |
| Linux with glibc 2.28+ | x64, ARM64 | `.tar.gz` |
| macOS 13.5+ | Intel x64, Apple Silicon ARM64 | `.tar.gz` |
| Windows 10+/Windows 11 ARM64 | x64, ARM64 | `.zip` |

Alpine/musl Linux is not supported by these builds. macOS executables are ad-hoc
signed, not Apple-notarized; Windows executables do not carry an Authenticode
signature. OS reputation checks may require approval for a downloaded executable.

## Sign in

```sh
engagectl login --api-url https://api.engage.lookandtry.com \
  --issuer https://auth.engage.lookandtry.com
engagectl status
```

`--api-url` (or `ENGAGECTL_API_URL`) selects Engage. `--issuer` (or
`ENGAGECTL_ISSUER`) selects Identity and must exactly match the issuer advertised
by that API. When omitted, the issuer is inferred from Engage's public
`/api/backoffice/auth/native/config`. An Identity issuer cannot infer the Engage
API's deployment URL.

Version 0.2.0 requires the updated Engage native OAuth resource server and an
Identity version that preserves `auth_time` in initial and refreshed access
tokens. It replaces the former Engage cookie session; archive an old session
file before signing in again. Installing this release does not deploy a backend
or apply OAuth registrations.

The separate public `engagectl` client must be registered as `NATIVE`, with token
endpoint authentication `NONE`, explicit consent, scopes
`openid email offline_access engage.console`, loopback redirect
`http://127.0.0.1/oauth2/callback`, and default resource
`ISSUER/engage/console`. Identity permits a random callback port. The resource
uses audience `engage-console-api` and scope `engage.console`; it has its own
introspection credential held only by Engage. The client never uses the
`engage-console` secret, an integration key or a browser console cookie.

Login uses Authorization Code/S256 PKCE, state, the exact callback issuer and
fresh authentication. The CLI exchanges the code directly with Identity, stores
the resulting access/rotating-refresh tokens privately, and asks Engage for
workspaces belonging to that exact issuer/subject. Email never creates a binding
or a permission. Select a workspace interactively or explicitly:

```sh
engagectl login --api-url https://api.engage.lookandtry.local \
  --issuer https://auth.engage.lookandtry.local --workspace WORKSPACE_ID
```

Before every authenticated CLI command or MCP tool call, the shared client
refreshes an expired access token or one expiring within 60 seconds. A private
session lock prevents concurrent refresh-token reuse. The replacement is saved
atomically before any Engage request. This is demand-driven; there is no
background keepalive. Identity currently limits a refresh family to seven days
from initial login; rotating does not extend that limit. Expiry or revocation
requires a new login. Writes and OAuth exchanges are never automatically retried.

Engage introspects the exact access token for every request, requires its own
issuer/audience/client/scope, and resolves live account, workspace, permissions,
MFA and IP policy. Sensitive operations keep the original authentication time:
refresh cannot satisfy a demand for fresh login.

```sh
engagectl logout
```

Logout revokes the refresh family at Identity before deleting the local session.
A remote failure retains the file for retry. The default file is
`${XDG_CONFIG_HOME:-$HOME/.config}/lookandtry/engagectl/session.json`; its POSIX
directory is `0700`, its atomically written file `0600`, and symlinks are refused.
Use `ENGAGECTL_SESSION_FILE` for separate API instances or workspaces. Issuer,
API origin, client and resource are pinned, and a running MCP also refuses user
or workspace drift. Status and MCP tools never print tokens. If workspace
selection fails after code exchange, the grant remains private for `logout` to
revoke; finish by logging out and logging in with `--workspace ID`.

Use `login --no-browser` to open the printed URL manually. Its loopback callback
must reach the machine running the CLI. Login times out after five minutes.
MCP never starts interactive login. TLS uses system CAs, bundled roots and
`NODE_EXTRA_CA_CERTS`; certificate verification remains enabled. HTTP is accepted
only on loopback. Credentials are never forwarded across redirects.

## Console actions

```sh
engagectl operations projects
engagectl operations templates --offset 0 --limit 25
engagectl schema OPERATION_ID
engagectl execute OPERATION_ID --input request.json --dry-run
engagectl execute OPERATION_ID --input request.json
```

Operation IDs and schemas come from the running backend's authenticated console
OpenAPI document. Projects, environments, audiences, templates, campaigns,
automations, monitoring, governance, billing and settings use their existing API
contracts. There is no second hand-maintained command or DTO catalog.

Follow the inspected schema and omit unused sections in the input:

```json
{
  "path": { "environmentId": "environment-id" },
  "query": { "page": 0, "size": 25 },
  "headers": {},
  "body": {}
}
```

`--input -` reads stdin. Discovery is bounded (1–100 results per page); API search
operations retain their own pagination. `--dry-run` prepares the exact request
without executing it, and does not pretend to run server-side business validation.
Writes are never retried automatically. Inspect durable operation/job state and
the operation's idempotency contract before retrying an uncertain result.

For media, begin an upload through its existing operation, then supply its asset
ID and `X-Engage-Media-Upload-Token` capability in the discovered upload operation:

```sh
engagectl execute UPLOAD_OPERATION_ID --input upload-parameters.json \
  --body-file artwork.png --content-type image/png
engagectl execute DOWNLOAD_OPERATION_ID --input download-parameters.json \
  --output private-preview.png
```

Complete the upload using its existing operation afterward. Upload/READY does not
publish media: approval, dispatch and activation retain their publication rules.
JSON input is limited to 2 MiB, local upload files to 64 MiB (subject to backend
limits), ordinary replies to 2 MiB and OpenAPI to 16 MiB. Use pagination or stream
downloads with `--output`, which creates a new private file and never overwrites
an existing path. Errors go to stderr with a nonzero exit code.

## MCP

Run `engagectl login` once, then configure your MCP host to launch the installed
executable with the argument `mcp`:

```json
{
  "mcpServers": {
    "engage": {
      "command": "engagectl",
      "args": ["mcp"]
    }
  }
}
```

Use the executable's absolute installed path if the host does not inherit your
PATH. Pass `ENGAGECTL_SESSION_FILE` in its environment when using a custom session.
The host starts the server automatically; no extra terminal needs to stay open.

| Tool | Purpose |
| --- | --- |
| `engage_status` | Inspect account, instance and workspace |
| `engage_search_operations` | Discover a bounded page of operations |
| `engage_operation_schema` | Inspect one operation and referenced schemas |
| `engage_execute` | Execute an operation with the user's permissions |

The official MCP SDK supports modern and legacy stdio clients. Execution is
marked potentially destructive because it can send, publish, delete and change
settings. The host owns approval policy; backend authorization remains mandatory.
Errors become `isError` tool results. Client cancellation reaches HTTP, but does
not undo a write or cancel a durable job: use its existing cancellation operation.
MCP never starts an interactive login. stdout is reserved for protocol messages.

## Development

Install the pinned Node/pnpm toolchain with mise, then:

```sh
mise run setup
mise run check
mise run package
mise run test:packaged
```

Development requires Node 24.16.0, pnpm 10.34.5 and the platform's build tools
(`tar` on Linux/macOS, PowerShell on Windows, and `codesign` on macOS). The Linux
TLS test also requires OpenSSL. Tests exercise the source client and the actual
standalone executable copied into an isolated temporary directory, including
browser PKCE callbacks, MCP interoperability, API errors, binary transport,
system CA trust and refusal of untrusted certificates.

## Releases

Follow [RELEASING.md](RELEASING.md): prepare the reviewed version from `develop`,
merge the same release branch into `master` and `develop` with `--no-ff`, then
publish its matching immutable stable tag. The native `package.json` version is
authoritative. Release preparation does not publish or launch CI.

A pushed `vX.Y.Z` tag authorizes the existing publication workflow. It validates
release metadata, builds and tests all six OS/architecture combinations on
matching hosted runners, then verifies checksums and exact source provenance
before publishing archives, installers and `SHA256SUMS`. Manual workflow runs
validate builds only. Existing tags and published assets are immutable; changed
artifacts require a new version. Nothing is published to npm or deployed to Engage.
