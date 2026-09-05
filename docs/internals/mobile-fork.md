# Mobile fork decisions

This file records mobile behavior that intentionally differs from upstream. Update it with every
fork-only mobile change. During a rebase, preserve the intent below, not necessarily the current
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

Paid-team local builds pin `ios.appleTeamId` so the app, widget, share extension, App Group, and push
entitlements use one team. The Personal Team mode is only a reduced-capability fallback. It strips
the widget, share extension, push, App Group, and native Apple sign-in capabilities rather than
pretending they can be signed.

## Image attachments

The phone converts selected photos before creating composer attachments:

- Ask the iOS picker for a compatible representation so HEIC and similar library assets can become
  a provider-supported format.
- Detect the resulting MIME type from the bytes, not stale picker metadata, and normalize the file
  extension.
- If a JPEG exceeds the shared 10 MB provider limit, recompress it through bounded resolution and
  quality stages on the phone. Reject it only when no stage gets under the existing contract limit.
- Apply the same attachment conversion path to existing threads, new tasks, review comments, and
  native paste entry points where applicable.

Do not raise the wire limit to fix large photos. The fork should adapt the local image to the shared
provider contract.

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
- The private ChatGPT endpoints are unsupported and can change without notice. Keep that warning in
  Settings. Do not describe this as a stable public OpenAI API.

Do not restore the fork's old `DictationBar`, recorder hook, composer layout, or native input-lock
patches. Upstream now owns those behaviors. The only composer integration the fork needs is selecting
the ChatGPT transcriber and passing the captured draft text as cleanup context.

## Build and install behavior

Tailnet installs are standalone Release builds, not EAS builds and not development clients. Use the
`preview` variant, the fingerprint runtime policy, a fresh DerivedData directory, and the installed
`ios-tailnet-installer` skill. The app must contain `main.jsbundle`, pass strict code-signature and
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
| Tailnet builds             | `apps/mobile/README.md`, `ios-tailnet-installer` skill                     | EAS-matched config, Release bundle, no Metro                                   |

After resolving a conflict, run the mobile TypeScript check, focused tests for the changed area,
native static checks when native editor code changed, and one real-device or simulator pass for any
composer behavior change.
