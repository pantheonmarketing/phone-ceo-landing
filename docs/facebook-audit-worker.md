# Facebook Lost Customer Audit worker V1

## Architecture

The public Vercel Function validates an authorized submission, creates a private report token, stores the audit in a private Vercel Blob store, and sends the existing Telegram notification. It does not keep a browser or timer alive. The worker records that its dedicated persistent profile was selected, but this is not proof of the Facebook account identity or Page ownership; the real acceptance test must verify those manually.

Jonny's Windows worker polls the same private store. It claims one queued audit with an optimistic-concurrency write, opens a visible Chromium browser with a dedicated persistent Facebook profile, finds Messenger, prepares the single-send guard, sends one labelled audit message, and starts the two-minute clock only after the sent message is visible in the conversation.

Every action is appended to the audit record with an ISO timestamp. Screenshots are stored privately. The local dashboard binds to `127.0.0.1` and streams worker/store changes; it is not a public administration surface. Prospects use a separate token-protected report page.

Lifecycle:

`queued → starting → message_sent → waiting → passed | failed | error`

Detailed events such as `page_opening`, `messenger_reachable`, `message_prepared`, `reply_detected`, and `evidence_captured` appear inside that lifecycle.

## Result rule

- `A`: useful answer in 60 seconds or less.
- `B`: useful answer from 61 through 120 seconds.
- `F`: no useful answer by 2:00 after a confirmed send.
- `C` diagnostic: the F was accompanied only by a generic automatic acknowledgement.
- `D` diagnostic: the F had a reachable channel but no acknowledgement or useful answer.
- Browser, login, Messenger, storage, or ambiguous-send failures are `error` and remain unscored.

This split keeps the hard two-minute F rule authoritative while preserving the requested C/D behavior detail.

## Normal operation (no terminal required)

1. Double-click `Connect Facebook Audit Account.vbs` once. Sign in to the dedicated Facebook audit account in the browser window, then close it.
2. Double-click `Start Facebook Audit Agent.vbs`. The private dashboard opens and the agent begins watching the queue. The worker fails safely if its browser adapter does not report that the dedicated profile was selected; it never treats that signal as account-identity verification.
3. Leave the Windows machine signed in. New authorized form submissions are picked up automatically; no command needs to be run per audit.

The browser profile defaults to the git-ignored `data/facebook-audit-browser-profile` directory, so it is separate from the normal Facebook browser session without requiring configuration.

## Technical setup and troubleshooting

1. Install dependencies:

   ```powershell
   npm install
   ```

2. In the existing Vercel project, create one **private Vercel Blob** store and connect it to the project. Add its read-write token as `BLOB_READ_WRITE_TOKEN` in Vercel and in the worker's uncommitted `.env.local`.

3. Copy `.env.example` to an uncommitted `.env.local` and fill the environment values. Keep the existing Telegram token and chat ID; do not create or rotate them.

4. `FACEBOOK_AUDIT_PROFILE_DIR` is optional. When omitted, the worker uses its dedicated git-ignored profile under `data/`. Never point it at Jonny's everyday Facebook browser profile.

5. Open that dedicated browser and sign in manually:

   ```powershell
   npm run audit:login
   ```

   Close the browser after Facebook is ready. The worker never reads or prints cookies, credentials, or the profile location.

6. Verify the controlled local browser path:

   ```powershell
   npm test
   npm run audit:smoke
   ```

7. Start the worker:

   ```powershell
   npm run audit:worker
   ```

   The terminal prints the local dashboard URL. The default is `http://127.0.0.1:4317/`.

## Real Facebook verification gate

Do not deploy the production queue changes until this manual check succeeds:

1. Use a Page whose owner has explicitly authorized the test.
2. Confirm the dedicated browser profile is logged in as the reviewed audit account and can open that Page. This identity check is manual evidence; selecting a configured profile path does not confirm it.
3. Submit one real audit from the local/public form.
4. Watch the local dashboard through Page open, Messenger reachability, single-send preparation, confirmed send, reply observation, result, evidence, and final Telegram notification.
5. Confirm the Page received exactly one message containing the audit ID and authorized-audit disclosure.
6. Confirm the public report shows the real timestamps and result.

If Facebook changes its UI, requires a checkpoint, blocks the account, removes Messenger, or the send cannot be confirmed, the audit must end as a real `error`. An ambiguous prepared send is never retried automatically.

## Operational notes

- Pause/resume controls exist only on the local dashboard.
- The worker processes one audit at a time.
- The local crash journal stores only audit/send identifiers and timestamps, never message text or credentials.
- Vercel Blob writes use ETag conditions so two worker instances cannot claim the same queued audit.
- Facebook selectors use visible accessibility roles and conservative fallbacks. There is no CAPTCHA bypass or anti-detection behavior.
- Reply classification is deterministic and conservative. The local dashboard can manually review a detected reply while the audit is still waiting.
