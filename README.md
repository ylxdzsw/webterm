# webterm

A web-based **persistent virtual terminal** that works over plain **HTTP/1.1**
— no WebSocket, no HTTP/2, no raw TCP. It is built to survive a corporate proxy
that (a) MITM-inspects HTTPS and (b) occasionally hijacks every request to the
domain with an interstitial "acknowledge" page until you click through it.

You run the server on a machine you control, put your existing nginx+TLS in
front of it, and open it in regular Chrome on a locked-down work PC. You get a
full interactive terminal — including TUI apps like `opencode`, `claude code`,
`vim`, `htop` — that keeps running when the browser disconnects.

**One server process = one shell.** The server launches the account's login
shell from passwd on startup; the page is a disposable view of it. When that
shell exits, the server process exits too. Multiple independent terminals are
provided by running **several instances behind nginx + systemd socket
activation** (see *Deploy*), not by an in-process session registry.

## Why this design

This is **not** web SSH. SSH-over-HTTP tunneling exists to carry a byte stream
to a *remote* host; here the host you want a shell on *is* the web server, and
you only need an interactive shell. So we skip SSH entirely:

- The server runs the shell/TUI in its own **PTY**.
- A server-side **headless xterm.js** continuously consumes the PTY output and
  tracks the full screen state (colors, cursor, modes, scrollback).
- The browser is a **disposable view**. On every (re)connect the server replays
  a **serialized screen snapshot**, then streams live output. One clean resume
  path, no terminal-mode desync.
- Persistence lives in the **server process itself**: browser disconnects never
  touch the PTY, and the shell keeps running with no browser attached. The
  session ends only when the program exits — and then the process exits with it.

### Lifecycle (shell ↔ process ↔ systemd)

The server owns exactly one PTY. When the program in it exits, the server calls
`process.exit`. Run under systemd socket activation, this gives:

- **Reliable cleanup.** The unit uses `KillMode=control-group`, so when the
  process exits, systemd reaps the entire cgroup — backgrounded jobs and any
  daemons the shell forked included. This is more thorough than signalling a
  process group from inside the app.
- **Near-zero idle cost.** A slot that has no live shell is just a systemd
  socket being listened on; there is no Node process. The first request starts
  one; the shell exiting tears it back down.
- **No restart loop.** The service is `Restart=no`: after the shell exits it
  stays inactive until the next request re-activates it. `StartLimit*` (service)
  and `TriggerLimit*` (socket) bound the worst case if activation ever fails in
  a loop.

Browser disconnects do **not** end the session — only the program exiting does.
When it exits the attached page shows a **Reload** button and a dismiss control;
close the dialog to scroll and copy cached output, then reload when you want a
fresh shell (under socket activation the next request starts a new process).

### Transport (WebSocket-free)

Two half-duplex HTTP/1.1 channels per page:

| Channel | Request | Purpose |
| --- | --- | --- |
| Output | `GET api/stream` (long-lived chunked response) | snapshot + live PTY output |
| Input  | `POST api/input` (coalesced, keep-alive) | keystrokes |
| Resize | `POST api/resize` | terminal size → PTY `SIGWINCH` |

URLs are **relative** to the page, so the same client works whether it is served
at `/` (local) or under a `/<slot>/` prefix (behind nginx).

Every legitimate message is one line of JSON beginning with `{"m":"WT1"`. If
the network returns anything else — HTML, a redirect, the wrong MIME type, or
other non-protocol bytes — the client stops and asks you to **Refresh**. That
lets the browser land on any acknowledgement page the network requires before
you return to the terminal. Plain transport failures are retried automatically
for a while; after several failed reconnect attempts the client also falls back
to a refresh prompt.

## Quick start (local, no systemd/nginx)

```bash
npm install
WEBTERM_TOKEN=$(openssl rand -base64 24) npm start
# open the printed URL (http://127.0.0.1:8080), paste the token when prompted
```

Without `WEBTERM_TOKEN` the server generates and prints a one-off token. In this
mode there is no multi-session and no cgroup-based cleanup — it is a single shell
served at `/`, intended for local use and development.

## Deploy (systemd socket activation + nginx, multi-session)

Multiple terminals come from running several socket-activated instances, one per
slot id, routed by nginx. The templates live in `deploy/`.

1. Copy the repo to the server (e.g. `/opt/webterm`), run `npm install --omit=dev`.
2. Set a strong `WEBTERM_TOKEN` (shared by all slots) — see `.env.example` and
   the `webterm@.service` template.
3. Install the units and the socket directory:
   ```bash
   sudo cp deploy/webterm@.socket deploy/webterm@.service /etc/systemd/system/
   sudo cp deploy/webterm.tmpfiles.conf /etc/tmpfiles.d/webterm.conf
   sudo systemd-tmpfiles --create /etc/tmpfiles.d/webterm.conf
   sudo systemctl daemon-reload
   sudo systemctl enable --now webterm@{0,1,2,3,4,5,6,7}.socket
   ```
   Edit `User=`, `WorkingDirectory=`, and the token in `webterm@.service` first.
4. Front it with TLS using `deploy/nginx.conf.sample`. It routes
   `https://your-domain/<id>/…` to `/run/webterm/<id>.sock` (stripping the
   prefix) and redirects `/` → `/0/`. The important bits are `proxy_buffering
   off` and the relative-URL prefix handling.
5. Open `https://your-domain/` (or `/3/` for slot 3) in Chrome on the work PC
   and paste your token.

Each slot is fully independent: its own shell, its own cgroup, started on first
use and gone when its shell exits. To change the number of slots, edit the
`[0-7]` ranges in `nginx.conf.sample` and the `enable` instance list.

## Configuration

See `.env.example`. Common knobs: `WEBTERM_TOKEN`, `WEBTERM_HOST` /
`WEBTERM_PORT` (only used without socket activation), `WEBTERM_CWD`,
`WEBTERM_SCROLLBACK`, `WEBTERM_KEEPALIVE_MS`.

WebTerm always runs the effective user's login shell from passwd as a login
shell. If the passwd entry has no shell or points to something unusable, the
server fails to start with an explicit error instead of falling back to another
shell.

## TUI notes

The child process gets `TERM=xterm-256color`, `COLORTERM=truecolor`, and a
UTF-8 locale, and the PTY is resized to match the browser viewport before the
first paint, so full-screen apps render correctly. Mouse reporting and bracketed
paste are passed through by xterm.js.

## Limitations / trade-offs

- **A process restart loses that slot's session.** Persistence is in-process by
  design (no tmux/dtach). The shell only survives as long as its server process,
  which is exactly the lifecycle we want here.
- **No end-to-end secrecy from the proxy.** The MITM proxy can read the session
  in plaintext. This tool targets *approved, monitored* use where that is
  acceptable; it only works around the technical transport restrictions.
- Interactive latency is roughly one proxy round-trip per keystroke (fine for a
  shell and most TUIs). Throughput is not meant for large file transfers.
- One screen size per session (single active viewport). Multiple tabs attached
  to the *same* slot will fight over the size.

## Security

This exposes a shell to anyone with the URL and token, so:

- **Set a strong `WEBTERM_TOKEN`.** Generate it with `openssl rand -base64 32`.
  If `WEBTERM_TOKEN` is set but empty or a known placeholder, the server refuses
  to start (fail closed). If it is left entirely unset, a random one-off token
  is generated and printed (local use only). All slots share this one token.
- The token is sent **only via the `Authorization: Bearer` header** — it is
  never accepted as a `?token=` query parameter (which would leak into proxy
  logs, history, and Referer headers).
- Serve only over TLS and consider additional restrictions (nginx allow-list,
  basic auth) at the proxy layer.
- Per-slot unix sockets are gated by filesystem permissions
  (`SocketUser`/`SocketGroup`/`SocketMode`); only nginx needs connect access.
