# webterm

Web-based persistent virtual terminal served over plain HTTP/1.1 (no WebSocket/HTTP2). A Node/Express server runs a shell in a PTY (`node-pty`) and a server-side headless `xterm.js` tracks screen state; the browser is a disposable view. See `README.md` for architecture and deploy details.

## Cursor Cloud specific instructions

There is a single service: the Node server (`npm start` / `npm run dev`, both run `node src/server.js`).

- The server reads `WEBTERM_TOKEN` from the env. If unset, it prints a random one-off token on startup; if set but empty or a placeholder it fails closed. For local/dev and the puppeteer tests, start it with `WEBTERM_TOKEN=testtoken` (the test scripts default `SMOKE_TOKEN`/`TOKEN` to `testtoken`).
- Default bind is `127.0.0.1:8080` (`WEBTERM_HOST`/`WEBTERM_PORT`). Health check: `GET /api/health`.
- The browser sends the token only via the `Authorization: Bearer` header; it is entered in the UI token prompt and stored in `localStorage['webterm_token']`. There is no `?token=` query param.

### Tests (puppeteer-core, require a running server + Chrome)
- `npm run test:smoke` (`scripts/browser-smoke.js`) and `npm run test:nag` (`scripts/browser-nag.js`).
- There is **no** `test:lobby` script / `browser-lobby.js` in this repo despite occasional references to it.
- Both tests need a real Chrome at `/usr/bin/google-chrome-stable` (override with `CHROME_PATH`). `google-chrome-stable` is preinstalled in the cloud VM; `puppeteer-core` does not bundle a browser.
- Start the server first (e.g. `WEBTERM_TOKEN=testtoken npm start`), then run the tests in a separate shell. The tests hit `http://127.0.0.1:8080/` by default (`SMOKE_URL` to override).

### Notes
- `node-pty` is a native addon; `npm install` compiles it (build toolchain is present in the VM).
- There is no lint script and no automated unit-test runner; the puppeteer scripts are the test suite.
