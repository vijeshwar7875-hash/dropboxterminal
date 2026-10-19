# Dropbox Image Library

This local website lists image files in the root of the connected Dropbox account, uploads images to that folder, and deletes them from Dropbox.

## Requirements

- Node.js 18 or newer
- A Dropbox API access token with `files.metadata.read`, `files.content.read`, and `files.content.write` permissions

The token previously pasted into chat was also accidentally included in the earlier README. Revoke that token in the Dropbox App Console and replace the value in `.env` with a newly created token. Never commit `.env` or paste its contents into a message.

## Run on Windows PowerShell

The server reads `DROPBOX_ACCESS_TOKEN` from `.env` automatically, or from an environment variable already set in the terminal. The `.env` file should contain a line in this format:

```text
DROPBOX_ACCESS_TOKEN=replace_with_your_new_token
```

After updating `.env`, start or restart the server:

```powershell
node .\server.js
```

Open <http://127.0.0.1:3000>. Keep the server bound to localhost; it has no authentication and is intended only for local use. The app works with the Dropbox root folder authorized by the token. Dropbox temporary image links expire, so refresh the page if an image no longer loads. Dropbox errors are shown in the page so token and permission issues are easier to identify.
