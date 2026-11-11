# Add Level worker

The website is static, so it can't safely check a login or hold a GitHub token. This small
Cloudflare Worker does both. The Add Level page sends it your Google Authenticator code; if the
code is right, it saves new levels to this repo for you (one commit per level).

Everything below uses free tiers. Nothing secret is ever stored in the repo or in the page.

## 1. Make the authenticator secret

1. Pick a random base32 secret (16+ characters, letters A-Z and digits 2-7). Any generator works,
   or run `node -e "console.log(require('crypto').randomBytes(20).toString('base64').replace(/[^A-Za-z0-9]/g,'').toUpperCase().replace(/[01]/g,'2').slice(0,32))"`.
2. In Google Authenticator choose **Add a code → Enter a setup key**, name it (e.g. "lxnarmoon
   levels"), paste the secret, and leave the type on **Time based**.
3. Keep the secret somewhere safe (a password manager). You'll paste it into Cloudflare next.

## 2. Make a GitHub token

1. GitHub → Settings → Developer settings → Fine-grained personal access tokens → **Generate new token**.
2. Repository access: **Only select repositories** → `lxnarmoon-website`.
3. Permissions: **Contents: Read and write**. Nothing else.
4. Set an expiry you're comfortable with (you'll need to make a new one when it runs out).

## 3. Create the worker

1. Cloudflare dashboard → **Workers & Pages → Create → Worker**. Name it (e.g. `add-level`) and deploy the starter.
2. **Edit code**, replace everything with the contents of `add-level-worker.js`, and **Deploy**.
3. **Storage & Databases → KV → Create** a namespace (e.g. `add-level-limits`).
4. Worker → **Settings → Bindings → Add → KV namespace**. Variable name must be exactly `RATE_LIMIT`.
5. Worker → **Settings → Variables and Secrets**:

| Name | Type | Value |
| --- | --- | --- |
| `TOTP_SECRET` | Secret | the base32 secret from step 1 |
| `GITHUB_TOKEN` | Secret | the token from step 2 |
| `ALLOWED_ORIGIN` | Text | the address your site is served from, e.g. `https://lxnarmoon.github.io` (no path; separate several with commas) |

   Optional text variables: `GITHUB_REPO` (default `lxnarmoon/lxnarmoon-website`) and `GITHUB_BRANCH` (default `main`).

## 4. Point the page at the worker

Open `script/add-level.js`, set `WORKER_URL` to the worker's address (it looks like
`https://add-level.<your-subdomain>.workers.dev`), and commit. The worker address is not a secret.

## How it protects you

- Only a valid 6-digit code unlocks anything, and each code works once.
- 5 wrong codes lock that address for 15 minutes; 20 wrong codes from anywhere lock everyone for an hour.
- An unlock lasts 30 minutes, then the page asks for a fresh code.
- The worker only copies known level fields, refuses to overwrite an existing level, and only ever
  touches `data/<name>.json` and the list's `data/_<list>.json`.
- If any setting is missing, the worker refuses to run instead of guessing.

**Be aware:** the page (and its `WORKER_URL`) is public, so anyone could *try* codes. The lockouts make
guessing impractical, but an attacker could deliberately trigger the global lock to keep you out for an
hour. If that happens, wait it out or clear the `fail:global` key in the KV namespace.

## Troubleshooting

- **"This site is not allowed"**: `ALLOWED_ORIGIN` doesn't match the address in your browser bar.
- **"The Add Level service is not fully set up"**: one of `TOTP_SECRET`, `GITHUB_TOKEN` or the `RATE_LIMIT` binding is missing.
- **"That code is not valid"** every time: check your phone's clock is automatic, and that the secret in Cloudflare matches the one in the app.
- **"GitHub refused the request"**: the token expired or lacks **Contents: Read and write** on this repo.
