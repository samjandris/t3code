# Mobile fork decisions

This file records mobile behavior that intentionally differs from upstream. Update it when a fork
constraint changes. During a rebase, preserve the intent below, not necessarily the current
implementation. If upstream ships an equivalent feature, prefer upstream and remove the fork code.

## Rebase policy

- Keep the fork diff as small as possible.
- Take upstream implementations when they cover the same requirement.
- Do not restore a dropped customization just because an old commit conflicts.
- Keep fork bundle IDs, signing, EAS ownership, and public T3 Connect configuration intact.
- Verify both existing-thread and new-task composers when changing shared composer behavior.

## App identity and hosted services

| Setting            | Fork decision                          |
| ------------------ | -------------------------------------- |
| Expo owner         | `samjandris`                           |
| EAS project        | `2dad1739-3d64-4f1a-b209-eb37c106b598` |
| Apple team         | `582X6VKHT4`                           |
| Development bundle | `com.samjandris.t3code.dev`            |
| Preview bundle     | `com.samjandris.t3code.preview`        |
| Production bundle  | `com.samjandris.t3code`                |

T3 Connect uses public Clerk and relay configuration. Cloud builds read it from EAS. Local and
tailnet builds must pull the matching EAS environment into the ignored root `.env.local`; do not
replace it with `.env.example` or commit its values.

Mobile passkeys remain disabled. The production Clerk relying-party domain is not configured for
the fork bundle IDs. Changing only the Apple team or copying upstream entitlements does not make the
relying-party association valid. Enable passkeys only after Clerk and the associated-domain files
explicitly authorize the fork identifiers.

Live Activities can start locally with the fork's widget and entitlements. Remote start and update
pushes are a separate APNs path. They require an APNs provider key from Apple team `582X6VKHT4` and
the fork's app topic. An upstream-team key cannot update a Live Activity signed by the fork team,
even if its value is copied into the fork's service configuration.

An opt-in [private push helper](../operations/mobile-activity-bridge.md) can send updates and notification alerts with
Sam's key while retaining upstream T3 Connect and Clerk. It discovers the account's environments
and combines read-only subscriptions, receiving device and activity tokens through Tailscale. It reuses
upstream notification policy and payloads, observes all threads before the card's display limit, and
seeds reconnect snapshots without replaying alerts. Helper-enabled builds disable both upstream push
types to avoid duplicate delivery. Each environment
needs its own read-only pairing until upstream deploys OAuth support for the relay token exchange,
as proposed in [PR #7483](https://github.com/pingdotgg/t3code/pull/7483). Then prefer the upstream
account activity feed and remove our per-environment subscriptions. Keep this transport separate
from upstream connection/authentication logic. Remove the helper entirely if upstream supports the
fork's signing identity.

Paid-team local builds pin `ios.appleTeamId` so the app, widget, share extension, App Group, and push
entitlements use one team. The Personal Team mode is only a reduced-capability fallback. It strips
the widget, share extension, push, App Group, and native Apple sign-in capabilities rather than
pretending they can be signed.

## Image attachments

Keep upstream's bounded native photo conversion in `composerImages.ts`. Do not restore the old
picker `base64: true` option or fork compression stages; full-resolution camera exports stalled
the composer before those stages could run.

New image drafts use upstream's inline storage for picked, pasted, and shared images. Do not
restore the fork's file-backed image writers during a rebase. Keep upstream's file-backed readers
and cleanup guards so drafts and queued messages saved by earlier fork builds remain usable.
Keep the existing fingerprint storage-baseline salt for compatibility with those builds. Files
and videos still use owned files. The shared 10 MB image limit still applies.

### Temporary HDR HEIC compatibility patch

`expo-image-manipulator@57.0.17` has a version-pinned native patch backported from
[Expo PR #50011](https://github.com/expo/expo/pull/50011), for
[Expo issue #49953](https://github.com/expo/expo/issues/49953). Its orientation transformer
creates a bitmap context that rejects 10-bit HDR HEIC screenshots before resizing or JPEG
encoding. The patch keeps upright images unchanged and uses UIKit's renderer for other
orientations. Keep the existing bounded conversion and upstream draft storage.

The mobile `expo.autolinking.buildFromSource` entry for `expo-image-manipulator` is required:
otherwise a prebuilt native module can bypass the patched Swift code. This needs a new binary;
JavaScript tests and an OTA update cannot verify or deliver it.

When Expo ships an equivalent fix and upstream T3 adopts that version, prefer it. Remove the
patch file, its `pnpm-workspace.yaml` entry, and this patch's `buildFromSource` entry together,
then regenerate the lockfile and remove this subsection. If another patch needs source builds,
retain that entry. Before removal, verify the actual installed native source and run a 10-bit
HDR HEIC conversion plus ordinary JPEG orientation checks against the replacement binary.
Do not carry this patch forward merely because a dependency upgrade conflicts with it.

## Video attachments

Oversized videos use native compression before file-backed persistence, including Photos, Files,
and incoming shares. Keep originals untouched and keep temporary encoder output out of draft state.
Show compressing videos as attachment tiles in existing-thread, new-task, and question composers.
For videos requiring compression, the tile uses 0 to 50% for compression and 50 to 100% for upload;
other attachments keep upstream upload progress. Removing a compressing tile cancels it.
Disable submission during compression, including keyboard submission. Do not restore a separate
compression status row, modal, or full-window overlay.
The compressor is a native dependency, so this change needs a new binary, not an OTA-only update.

Compression starts from a duration-based file-size budget. On every attempt, including the first,
choose the largest resolution supported by the bitrate, source frame rate, and a codec-specific
quality floor. A long 4K clip can start at 1080p rather than starving its original resolution of bits.
The floor is a heuristic, not a content-aware quality measurement. Native metadata supplies the
codec and frame rate; missing or invalid frame rates use 30 fps. Retries halve bitrate and reconsider
resolution, with five attempts at most. Every attempt reads the original. Reserve space for audio
and container overhead and validate the actual output size; encoder bitrate is only a target.
Metadata failures use a bounded fixed-quality ladder. Keep progress increasing across retries.

The version-pinned `react-native-compressor@2.0.3` patch selects HEVC for manual iOS compression when
AVFoundation advertises a compatible HEVC export preset, otherwise H.264. Do not apply an H.264
profile setting to HEVC. It also preserves source frame rate in the video composition instead of
silently falling back to 30 fps when codec frame-rate keys are absent. Keep those unsupported H.264
keys absent. Android retains H.264 encoding and reports its track frame rate for quality budgeting.
T3 stores the MP4 without a codec restriction, but other clients still need HEVC playback support.
Prefer equivalent upstream codec selection and frame-rate handling. Remove this patch and its
lockfile/workspace entries together once upstream covers them. Verify video decoding, retained
audio, source frame rate, and playback against the replacement binary.

## Voice dictation

Use upstream's voice-input controller, composer UI, waveform, editor freeze, recording lifecycle,
and on-device Apple transcriber. The fork adds ChatGPT as the preferred transcriber when the user is
signed in.

- Authentication uses Codex's ChatGPT device-code flow. The UI intentionally has two steps: copy
  the one-time code, then open ChatGPT. Tokens are stored with Expo SecureStore and refreshed before
  expiry.
- When no ChatGPT session exists, use upstream's on-device transcriber on supported iPhones. Do not
  require ChatGPT just to expose the microphone or remove the local fallback.
- Audio is recorded on the phone and uploaded directly to ChatGPT's private
  `chatgpt.com/backend-api/transcribe` endpoint. There is no fork relay or T3 server in this path.
- Cleanup calls the private Codex responses endpoint with `gpt-5.6-luna`, low reasoning, no tools,
  and at most 2,000 characters of draft text captured when recording starts. Cleanup may correct
  transcription and formatting but must not answer the user or add content.
- A cleanup failure falls back to the raw transcript. Authentication and transcription failures
  remain visible errors.
- Keep upstream's five-minute recording limit. There is no fork-specific 30-second cap.
- The private ChatGPT endpoints are unsupported and can change without notice. Settings omits
  the service disclaimer footer and the duplicate title below the microphone by fork preference.
  Do not describe this as a stable public OpenAI API.

Do not restore the fork's old `DictationBar`, recorder hook, composer layout, or native input-lock
patches. Upstream now owns those behaviors. The only composer integration the fork needs is selecting
the ChatGPT transcriber and passing the captured draft text as cleanup context.

## Build and install behavior

Tailnet installs are standalone Release builds, not EAS builds and not development clients. Use the
`preview` variant, the fingerprint runtime policy, a fresh DerivedData directory, and the installed
`ios-builder` skill. The app must contain `main.jsbundle`, pass strict code-signature and
provisioning checks, include the target device, and run without Metro.

Before a tailnet build, pull the EAS preview environment as described in
[`apps/mobile/README.md`](../../apps/mobile/README.md). This keeps Clerk, OAuth, hosted app, and relay
configuration identical to EAS builds without reusing a stale hand-maintained credential file.

Release workflows use the fork's EAS project and repository credentials. Upstream workflow changes
should be adopted where possible, but must not switch ownership, bundle IDs, signing team, or hosted
configuration back to upstream values.

## Deliberately dropped changes

- Use the upstream mobile model picker. The fork's old model-property customization was removed.
- Use upstream branding and assets. The temporary mobile brand simplification was reverted.
- Do not spoof upstream bundle IDs, Apple team membership, APNs topics, or associated domains.
- Do not add `feature/tool-summarization` to `dev` unless that exclusion is explicitly reversed.

## Conflict map

| Area                       | Primary paths                                                              | Intent to preserve                                                             |
| -------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| App identity and signing   | `apps/mobile/app.config.ts`, `apps/mobile/eas.json`, mobile config plugins | Fork IDs, team, owner, capabilities, public hosted config                      |
| Attachments                | `apps/mobile/src/lib/composerImages.ts` and its callers                    | Compatible conversion and bounded on-device compression                        |
| Dictation auth and service | `apps/mobile/src/features/dictation/`                                      | Device-code auth, secure token storage, direct transcription, cleanup fallback |
| Dictation integration      | `apps/mobile/src/features/voice-input/useVoiceInputController.ts`          | Prefer ChatGPT when signed in, retain upstream local fallback                  |
| Dictation UI and lifecycle | Upstream voice-input and composer files                                    | Take upstream; do not recreate the removed fork implementation                 |
| Tailnet builds             | `apps/mobile/README.md`, `ios-builder` skill                               | EAS-matched config, Release bundle, no Metro                                   |

After resolving a conflict, run the mobile TypeScript check, focused tests for the changed area,
native static checks when native editor code changed, and one real-device or simulator pass for any
composer behavior change.
