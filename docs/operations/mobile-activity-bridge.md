# Fork push helper

The fork is signed by Sam's Apple team. Upstream's APNs key cannot update its Live Activities.
One Node helper on cusebox discovers the account's T3 Connect environments and combines read-only
subscriptions to their existing servers. It sends updates with Sam's APNs key. No helper, forked
server, or separate Clerk instance runs on the other boxes. The phone starts the card and registers
its activity token through Tailscale. The helper alerts through that card while it is active and uses
ordinary notifications when there is no usable card. Remote activity starts remain outside its scope.

The helper nests navigation fields in APNs `body`. Expo iOS
`NotificationRecords.serializedNotificationData` exposes only that dictionary as `content.data` for
remote notifications. Upstream's current APNs sender places those fields at the payload's top level,
which displays an alert but loses its tap destination. Keep this adaptation at the helper's sender
boundary and replace it with upstream's implementation when it accounts for Expo's serializer. The
app's existing notification navigation stays unchanged.

## Why per-server pairing is still necessary

The helper's own Clerk device-code login can list linked environments and refresh its session.
The hosted relay currently rejects that OAuth credential at `/v1/client/dpop-token` with
`invalid_bearer`. Its token exchange accepts session-template JWTs, while the listing endpoint also
accepts CLI OAuth credentials. Both the mobile activity feed and relay connection minting need the
DPoP exchange. This was checked against upstream `7445aa733a` and the hosted relay on September 20.

[Upstream PR #7483](https://github.com/pingdotgg/t3code/pull/7483) proposes the missing OAuth support.
Once it is deployed, verify the helper login against the real token exchange and account activity
feed. Prefer that feed, remove our per-server subscriptions and pairing credentials, and retain only
the fork's APNs sender. Merely merging the PR into our fork cannot change the hosted relay.
Remove the entire helper if upstream supports the fork's signing identity.

## Discovery and activity updates

- Refresh the T3 Connect server list and local credential mapping every 60 seconds.
- Subscribe to each authorized server through its advertised endpoint. Cusebox uses a loopback
  override. Endpoint changes restart that subscription; unlinking a server stops it and removes its
  rows. New servers appear in health as `authorization_required` until paired.
- Reuse upstream shell events, projection, aggregate ordering, counts, and widget payloads. Combine
  all servers before limiting the displayed rows. A task finishing on one box must not end the card
  while another box still has active work.
- Reconnect failed subscriptions after 5, 10, 20, 40, then 45 seconds between attempts.
  Reset to five seconds after a subscription stays connected for at least one minute. Show last-known
  active work from a disconnected box as waiting, while connected boxes continue updating. Pause pushes if all boxes disconnect or
  account discovery has not succeeded for 90 seconds. A fresh helper process has no snapshot of a
  sleeping box until that box reconnects.
- Project each changed server snapshot once and reuse those rows for alerts and card aggregation.
  Continue recomputing time-based expiry and disconnected status on each delivery pass.
- Reuse one APNs HTTP/2 connection across pushes. Replace closed, failed, or GOAWAY connections;
  a ten-second request timeout retires a stalled connection.
- Check delivery every five seconds. Follow upstream's fifteen-second throttle for routine redraws;
  counts, attention, completions, and alerts bypass that throttle. Compare the full aggregate,
  including row timestamps, and suppress identical state. Foreground registration replays current
  content even for the same token. There is no separate unchanged-state heartbeat.
- Keep recent Done/Failed rows for upstream's fifteen-minute display window, then end an empty card.
  Give a freshly armed empty card two minutes for its first server event. Use upstream's end dismissal
  delays, five minutes with final content and fifteen seconds without it. Retire invalid or
  eight-hour-old tokens. Re-registering the same card must not extend its lifetime.

## Notification alerts

Observe every thread transition before limiting the Live Activity's display rows. Reuse upstream's
notification preferences, terminal freshness checks, grouping, text sanitization, and navigation
payload. Before delivery or retry, discard alerts whose phase or timestamp no longer matches the
latest observed thread state. An active card owns approval, input, completion, and failure alerts. Attach `aps.alert` with
sound to a priority-10 Live Activity update, so it can wake and buzz without a separate notification.
Group simultaneous attention events or completions using upstream's alert copy; attention goes first.
Routine redraws stay silent at priority 5. Deliver grouped alerts even for threads outside the five
visible rows. Keep a queued completion if work finishes before its running event was observed.

With no card, a disabled or expired card, or an APNs-rejected activity token, use the ordinary device
push token. A transient activity failure keeps the alert queued for that card, never producing a
companion notification. One coordinated delivery pass consumes an alert only after APNs accepts it.
In-flight replies must not remove replacement tokens or newly queued transitions. Notification
permission and each event preference apply to both channels. Live Activities can alert without an
ordinary device token; fallback delivery requires that token, registered when the app opens.

Initial and reconnect snapshots establish a baseline without notifying about old work. Phase changes
within the attention group or within the terminal group do not send another alert; update undelivered
copy in place. Drop pending alerts when a thread leaves that group, disappears, or its server
disconnects. Use upstream's ten-minute job expiry and two-minute terminal freshness limit. APNs
collapse IDs coalesce ordinary-notification retries. Permission changes, sign-out, and device push
token rotation cancel queued delivery for the old
registration. Invalid notification tokens do not invalidate Live Activity tokens, and card expiry does
not remove notification registration.

The queue and transition baselines live in memory. A helper restart deliberately drops pending alerts
and reseeds from server snapshots. This trades an occasional missed alert during downtime for no
historical notification burst. Push acceptance does not prove the phone displayed a banner.

## Network and authentication

The listener binds to loopback, published through private Tailscale Serve, never Funnel. It allows
only the configured `Tailscale-User-Login`. Serve strips caller-supplied identity headers and injects
the authenticated identity. Tagged devices do not receive that user header. This is a single-user
helper, not a multi-user service.

The phone needs Tailscale to register a new or rotated push token. Subsequent delivery travels
through Apple without a continuous phone/helper connection. The helper connects outward to T3
Connect, each server's WebSocket, and APNs. No public callback or Cloudflare Tunnel for the helper is
needed. Server endpoints may already use T3 Connect's managed tunnels.

Use the same T3 Connect account on the helper and phone. The helper login has the upstream CLI OAuth
scopes; our implementation uses it only to list environments. Each server subscription separately
uses a bearer credential scoped to `orchestration:read`. It does not modify tasks or read databases.

## Cusebox installation

The persistent user unit is `~/.config/systemd/user/t3-activity-bridge.service`. It runs Node with
`Restart=on-failure`, `UMask=0077`, and the protected `bridge.env` EnvironmentFile. Immutable bundles
live in `~/.local/share/t3-activity-bridge/releases/`, selected by the `current` symlink. Never run this
service directly from a maintenance worktree that will be switched or rebased.

The listener is `127.0.0.1:43130`, exposed at `https://ubuntu-dev.taildd063f.ts.net:9447`.
The cusebox `~/SERVER_CONFIG.md` records the deployed release, credential expiry, and verification.
The initial multi-server configuration includes cusebox, Baybox, and Sam's MacBook Pro.

`~/.config/t3-activity-bridge/` is mode 0700; files are mode 0600:

- `bridge.env` holds paths, allowed Tailscale login, app identity, and listen port.
- `apns.p8` is Sam's existing Apple provider key, never included in an app, repository, or log.
- `connect-session.json` is the helper's own renewable OAuth session. Never copy a desktop's
  rotating refresh token. This session can be revoked independently of the desktop login.
- `environments.json` maps discovered environment IDs to `{ "tokenPath": "/absolute/path" }`.
  An optional `url` overrides the discovered HTTP endpoint. Unlisted environments stay unpaired.
- `environment-token`, `baybox-token`, and `macbook-token` are the three read-only server credentials.

Device notification tokens, preferences, and activity tokens remain in the protected
`~/.local/state/t3-activity-bridge/devices.json`.
Do not copy that file into build artifacts.

```dotenv
ACTIVITY_BRIDGE_TAILSCALE_LOGIN=<authorized Tailscale login>
ACTIVITY_BRIDGE_PORT=43130
ACTIVITY_BRIDGE_STATE_PATH=/home/sam/.local/state/t3-activity-bridge/devices.json
ACTIVITY_BRIDGE_CONNECT_SESSION_PATH=/home/sam/.config/t3-activity-bridge/connect-session.json
ACTIVITY_BRIDGE_ENVIRONMENTS_PATH=/home/sam/.config/t3-activity-bridge/environments.json
APNS_TEAM_ID=582X6VKHT4
APNS_KEY_ID=<Apple key identifier>
APNS_KEY_PATH=/home/sam/.config/t3-activity-bridge/apns.p8
APNS_BUNDLE_ID=com.samjandris.t3code.preview
APNS_ENVIRONMENT=sandbox
```

The APNs environment must match the signed entitlement. Current tailnet Release builds use Apple
Development signing and therefore the sandbox endpoint.

## Authorization and renewal

Authorize or replace the helper's T3 Connect session on cusebox from the integrated checkout:

```sh
node --env-file=/home/sam/.config/t3-activity-bridge/bridge.env infra/activity-bridge/src/login.ts
systemctl --user restart t3-activity-bridge.service
```

Complete the printed device authorization in your browser. The helper refreshes this session itself.
If access is revoked, run login again. Never put credentials in command arguments or logs.

Server pairing is separate and lasts 30 days. The helper checks each credential hourly and renews
with seven days remaining. Expired or revoked credentials can also be replaced through the installed
CLI; the old bearer is not needed for issuance. Offline machines retry on the next hourly check.
Replacement requires the expected environment identity, only `orchestration:read`, and a fresh expiry.
The helper atomically replaces the mode-0600 token file after validation and reconnects that source
on the next discovery pass. Failed renewal retains the old file. Previous sessions expire naturally.

`ACTIVITY_BRIDGE_RENEWAL_TARGETS_PATH` points to a protected JSON map keyed by environment ID.
Each entry has `binary`, optional `entry` for an Electron server CLI, and the server-local `url`.
Remote entries also have `ssh`, an argv array ending in the SSH destination. Use batch authentication,
pinned host keys, and a connection timeout. These commands are trusted operator configuration, never
accepted from the phone or discovery. Cusebox uses its local installed CLI; the Macs use their
installed Nightly executable in Node mode. The helper sends a short program over SSH stdin, captures
its output privately, and leaves no script, credential file, service, or scheduled job on the Macs.
The existing SSH account authorizes issuance, while the subscription retains read-only access.
A new machine needs its own approved SSH target and initial credential mapping.

Health exposes `credential.expiresAt`, `checkedAt`, `automaticRenewal`, and status. `unavailable`
means inspection failed, including an offline server; `renewal_failed` means issuance or validation
failed. Neither logs command output or secrets. Removing a renewal target disables minting for that
server. Revoking a helper bearer alone will trigger replacement; disable its renewal target first
when intentionally withdrawing access.

For initial or manual pairing, Run `infra/activity-bridge/src/pair.ts` on
the machine running that server with `ACTIVITY_BRIDGE_ENVIRONMENT_URL=http://127.0.0.1:3773` and
`ACTIVITY_BRIDGE_ENVIRONMENT_TOKEN_PATH` pointing to a protected output file. It invokes the official
`t3 pair` command, captures its bootstrap token, and exchanges it for `orchestration:read` only.
It does not start a server or directly open a database.

For desktop installs without `t3` on PATH, set `ELECTRON_RUN_AS_NODE=1`,
`ACTIVITY_BRIDGE_CLI_BINARY` to the installed app's `Contents/MacOS/T3 Code (Nightly)` executable,
and `ACTIVITY_BRIDGE_CLI_ENTRY` to its `Contents/Resources/app.asar/apps/server/dist/bin.mjs`.
Copy the standalone pairing script temporarily if necessary, then remove that copy afterward.
Transfer only the resulting credential over authenticated SSH to its cusebox token path, mode 0600.
Remove any temporary credential copy on the source box. Add the environment ID to `environments.json`.
No persistent helper installation is required on that box.

Discovery picks up new mapping entries within a minute. For a manual token replacement, restart the
helper to reconnect immediately. Automatic renewal invalidates only the affected subscription.
Record authentication setup changes in the affected machine inventories. OAuth refresh and
per-server renewal remain separate until the hosted relay supports the helper's OAuth account feed.

## Build, deploy, and verify

Build a tested integrated `dev` bundle and point `current` at the new immutable directory:

```sh
vp pack --no-config infra/activity-bridge/src/main.ts --deps.always-bundle '/.*/' \
  --platform node --format esm --out-dir <new-release-directory>
systemctl --user restart t3-activity-bridge.service
```

Build the integrated preview app with EAS-pulled configuration and the normal signing checks. The
only public helper variable is `EXPO_PUBLIC_T3CODE_ACTIVITY_BRIDGE_URL=https://ubuntu-dev.taildd063f.ts.net:9447`.
Do not set the former single-environment variable. No private helper credentials belong in the app.
The fork keeps upstream device registration but disables both upstream notifications and Live
Activities for this device, leaving one push sender. Android and builds without the helper URL keep
upstream behavior.

```sh
systemctl --user status t3-activity-bridge.service
journalctl --user -u t3-activity-bridge.service -n 40 --no-pager
curl https://ubuntu-dev.taildd063f.ts.net:9447/health
```

Health lists discovered servers, their connection or authorization status, and the number of devices
with notification tokens. It does not prove
phone delivery. Unauthenticated loopback requests must return 403. Logs record APNs status/reason,
never keys or tokens. Test a task on each box with the phone locked, including one box finishing
while another remains active. Source push, publication, device installation, Apple acceptance, and
visible updates are separate verification steps. For notifications, enable permission in iOS, open
the fork to register, then lock the phone and complete a task. Verify the banner and that tapping it
opens the correct environment and thread. With a card active, verify the wake/buzz comes through the
Live Activity without a separate notification and that completion keeps the Done row visible. With
Live Activities disabled, verify the ordinary banner and tap navigation. Test approval and input
alerts when those prompts occur. APNs logs include `alert: true` for an alerting card update.

For rollback, keep the previous bundle and configuration backup. To remove the helper, disable
`t3-activity-bridge.service`, remove only the Serve route with `tailscale serve --https=9447 off`,
revoke its OAuth grant and each server session, and rebuild without the helper URL. Preserve the Apple
key securely. Update machine inventories after service, route, or authentication changes.
