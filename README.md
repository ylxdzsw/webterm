# webterm

A web-based **persistent virtual terminal** that works over plain **HTTP/1.1**
— no WebSocket, no HTTP/2, no raw TCP. It is built to survive a corporate proxy
that (a) MITM-inspects HTTPS and (b) occasionally hijacks every request to the
domain with an interstitial "acknowledge" page until you click through it.

You run the server on a machine you control, put your existing nginx+TLS in
front of it, and open it in regular Chrome on a locked-down work PC. You get a
full interactive terminal — including TUI apps like `opencode`, `claude code`,
`vim`, `htop` — that keeps running when the browser disconnects.

## Why this design

This is **not** web SSH. SSH-over-HTTP tunneling exists to carry a byte stream
to a *remote* host; here the host you want a shell on *is* the web server, and
you only need an interactive shell. So we skip SSH entirely:

- The server runs your shell/TUI in a **PTY**.
- A server-side **headless xterm.js** continuously consumes the PTY output and
  tracks the full screen state (colors, cursor, modes, scrollback).
- The browser is a **disposable view**. On every (re)connect the server replays
  a **serialized screen snapshot**, then streams live output. One clean resume
  path, no terminal-mode desync.
- Persistence lives in the **server process itself**: browser disconnects never
  touch the PTY. (Trade-off: restarting the *server* loses the session — see
  below. We intentionally don't use tmux/dtach.)

### Transport (WebSocket-free)

Two half-duplex HTTP/1.1 channels:

| Channel | Request | Purpose |
| --- | --- | --- |
| Output | `GET /api/stream` (long-lived chunked response) | snapshot + live PTY output |
| Input  | `POST /api/input` (coalesced, keep-alive) | keystrokes |
| Resize | `POST /api/resize` | terminal size → PTY `SIGWINCH` |
| Restart| `POST /api/restart` | start a fresh shell |

Every legitimate message is one line of JSON beginning with `{"m":"WT1"`. The
proxy's reminder page is HTML, so the client detects a hijack by checking that
prefix. When detected, it **stops and shows instructions + a Reconnect button**:
acknowledge the page in another tab, then click Reconnect — no page reload
needed (the app stays in memory), and your session is intact.

## Quick start (local)

```bash
npm install
WEBTERM_TOKEN=$(openssl rand -base64 24) npm start
# open the printed URL, paste the token when prompted
```

Without `WEBTERM_TOKEN` the server generates and prints a one-off token.

## Deploy

1. Copy the repo to the server (e.g. `/opt/webterm`), run `npm install --omit=dev`.
2. Set a strong `WEBTERM_TOKEN` (see `.env.example`).
3. Install the systemd unit: `deploy/webterm.service`.
4. Front it with TLS using `deploy/nginx.conf.sample` — **the important bit is
   `proxy_buffering off` on `/api/stream`** so output flushes in real time.
5. Open `https://your-domain/` in Chrome on the work PC and paste your token.

## Configuration

See `.env.example`. Common knobs: `WEBTERM_TOKEN`, `WEBTERM_PORT`,
`WEBTERM_CMD` / `WEBTERM_ARGS` (what runs in the terminal),
`WEBTERM_KEEPALIVE_MS`.

## TUI notes

The child process gets `TERM=xterm-256color`, `COLORTERM=truecolor`, and a
UTF-8 locale, and the PTY is resized to match the browser viewport before the
first paint, so full-screen apps render correctly. Mouse reporting and bracketed
paste are passed through by xterm.js.

## Limitations / trade-offs

- **Server restart loses the session.** Persistence is in-process by design (no
  tmux/dtach). Run under systemd with `Restart=on-failure`, keep the server
  stable, and avoid needless redeploys. If you later need to survive restarts,
  wrap the child in `dtach`/`abduco` behind the same backend.
- **No end-to-end secrecy from the proxy.** The MITM proxy can read the session
  in plaintext. This tool targets *approved, monitored* use where that is
  acceptable; it only works around the technical transport restrictions.
- Interactive latency is roughly one proxy round-trip per keystroke (fine for a
  shell and most TUIs). Throughput is not meant for large file transfers.
- One screen size per session (single active viewport). Multiple tabs on the
  same session will fight over the size.

## Security

This exposes a shell to anyone with the URL and token, so:

- **Set a strong `WEBTERM_TOKEN`.** Generate it with `openssl rand -base64 32`.
  If `WEBTERM_TOKEN` is set but empty or a known placeholder, the server refuses
  to start (fail closed). If it is left entirely unset, a random one-off token
  is generated and printed (local use only).
- The token is sent **only via the `Authorization: Bearer` header** — it is
  never accepted as a `?token=` query parameter (which would leak into proxy
  logs, history, and Referer headers).
- Serve only over TLS and consider additional restrictions (nginx allow-list,
  basic auth) at the proxy layer.
- Concurrent sessions are capped by `WEBTERM_MAX_SESSIONS` (default 8).
