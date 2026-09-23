# Install from GitHub on Windows

There are two different ZIP downloads:

- **Code → Download ZIP** is GitHub's unencrypted source snapshot. It has no
  `dist` directory. Extract it, run `npm ci --ignore-scripts` and
  `npm run build`, then use `dist/bin.js`.
- The **Releases** asset named `inoproshop-mcp-v1.1.1-windows.zip` includes
  compiled JavaScript and the bundled Python scripts under `dist`. It is also
  unencrypted. Extract it, run `npm ci --omit=dev --ignore-scripts`, then use
  `dist/bin.js`. Node.js 18 or newer is required.

The release asset does not include InoProShop, device packages, PLC project
files, credentials or `node_modules`. Configure the actual InoProShop executable,
Profile and workspace as described in the main README. Keep all model-specific
reference `.project` templates inside the workspace, such as `.templates/`.

To check a downloaded ZIP in PowerShell:

```powershell
Expand-Archive -LiteralPath '.\inoproshop-mcp-v1.1.1-windows.zip' -DestinationPath '.\inoproshop-mcp-v1.1.1'
```

If another tool reports a password prompt, verify the exact file name and
checksum from the release page. The GitHub ZIP and our release asset contain
no encrypted entries. A password prompt from opening a vendor `.project` file
inside the IDE is a separate issue and depends on that project.
