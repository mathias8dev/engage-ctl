# engage-ctl

`engagectl` is the standalone command-line client and local MCP server for Engage.
It performs console actions as the signed-in user, using the backend's current
permissions, workspace boundaries and API contracts.

## Install

Download the archive for your operating system and architecture from
[GitHub Releases](https://github.com/mathias8dev/engage-ctl/releases), and verify
its SHA-256 against the release's `SHA256SUMS` file. Archives contain a single
`engagectl` binary (`engagectl.exe` on Windows), the build provenance and licenses.
No Node.js, npm, pnpm or source checkout is required to run it.

| System | Architectures | Archive |
| --- | --- | --- |
| Linux with glibc 2.28+ | x64, ARM64 | `.tar.gz` |
| macOS 13.5+ | Intel x64, Apple Silicon ARM64 | `.tar.gz` |
| Windows 10+/Windows 11 ARM64 | x64, ARM64 | `.zip` |

Alpine/musl Linux is not supported by these builds. macOS executables are ad-hoc
signed, not Apple-notarized; Windows executables do not carry an Authenticode
signature. OS reputation checks may require approval for a downloaded executable.

For Linux/macOS, the release also provides an installer which verifies the
selected archive before installing into `~/.local/bin`:

```sh
# Download install.sh from the chosen release, inspect it, then:
sh install.sh 0.1.0
engagectl --version
```

Set `ENGAGECTL_BIN_DIR` to select a different directory. The installer replaces
an existing binary only after the archive's checksum has been verified.

On Windows, download `install.ps1` from the release and run:

```powershell
.\install.ps1 -Version 0.1.0
```

It installs into `%LOCALAPPDATA%\Programs\engage-ctl` and adds that directory to
the current user's PATH. Open a new terminal afterward. Stop running CLI/MCP
processes before replacing the Windows executable.

## Sign in

```sh
engagectl login --api-url https://api.engage.lookandtry.com
engagectl status
```

The selected Engage backend and its configured Identity provider must be running
and support the native authorization API. Authentication uses the existing
Engage browser flow, including Identity or organization SSO, MFA and workspace
selection. The browser asks for explicit approval, then returns a single-use
code to a random `127.0.0.1` port. The CLI validates state and exchanges the code
with an S256 PKCE proof.

The CLI receives its own revocable Engage session. It never receives a password,
Identity refresh token or administrator access key. Session freshness and the
absolute deadline cannot be extended beyond the authorizing browser proof.
Live permissions, membership, workspace status, MFA and IP policy stay enforced
by Engage. Revoke the session from the console's session settings or run:

```sh
engagectl logout
```

The default session file is
`${XDG_CONFIG_HOME:-$HOME/.config}/lookandtry/engagectl/session.json`. On POSIX,
the directory is private (`0700`) and the file is created atomically (`0600`).
Symlinks are rejected. On Windows, keep it in the account-private user profile;
POSIX permission checks do not apply.

Use `ENGAGECTL_SESSION_FILE` for separate workspaces or API instances, and
`ENGAGECTL_API_URL` to supply the login origin. When supplied later, the API
origin must match the stored session. A running MCP client refuses account,
workspace or instance drift until it is restarted. `status` never prints tokens.

Use `login --no-browser` to open the printed URL manually. The callback must reach
the machine running the CLI; forward its loopback port when using a remote shell.
Login times out after five minutes. Expired sessions require logout and a new
login. Logout retains the session file on remote failure so revocation can be
retried; an HTTP 401 means it is already invalid.

TLS uses the installed system CAs alongside Node's bundled roots and
`NODE_EXTRA_CA_CERTS`. Certificate and hostname verification stay enabled.
Local development origins are supported with `--api-url`; HTTP is accepted only
for `localhost` or `127.0.0.1`. Credentials are never forwarded across redirects.

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

GitHub Actions builds and tests all six OS/architecture combinations on matching
hosted runners for pushes to `main` and pull requests. It uploads short-lived
build artifacts without publishing a release.

To publish, update `package.json`'s version, merge into `main`, then manually run
the workflow **Build and release engagectl** with **publish** enabled. Every
native build and packaged test must pass. The final job verifies archive hashes,
version, target and exact source revision, creates a draft `vX.Y.Z` release,
uploads the archives/installers/`SHA256SUMS`, then publishes it. It does not deploy
Engage or publish anything to npm. No additional release token is required.

Existing tags cannot be retargeted and published assets cannot be overwritten.
Retry the failed publish job with the same artifacts after a partial draft upload;
changed artifacts require a new version. Check the Actions run before treating
foreign-platform builds as verified. Runtime and bundled dependency license
notices are included in every release archive.
