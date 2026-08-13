# AI CEOS Lost Customer Audit worker V1

## Architecture

The unified public form lets an authorized owner choose Website, Facebook, or Both. Each selected channel is queued independently with a private report token in the same Vercel Blob store. The Vercel Functions validate and queue the work, but never keep a browser or response timer alive.

Jonny's Windows worker polls that store and claims one queued audit with an optimistic-concurrency write. Facebook audits use the dedicated persistent Facebook profile, find Messenger, send one natural buyer question, and start the two-minute clock only after the sent message is visible. Website audits use a fresh isolated browser context, map the visible buyer contact paths, inspect contact forms without submitting them, and send at most one buyer question only when a usable live-chat composer is verified. Browser, network, login, and ambiguous-send failures remain real unscored errors.

After a real response, the worker sends a separate authorized-audit disclosure containing the audit ID. The initial buyer question remains natural so the response-time test is not influenced by advance disclosure.

Every action is appended to the audit record with an ISO timestamp. Screenshots are stored privately. The local dashboard binds to `127.0.0.1` and streams worker/store changes; it is not a public administration surface. Prospects use a separate token-protected report page.

Facebook lifecycle:

`queued → starting → message_sent → waiting → passed | failed | error`

Website lifecycle:

`queued → starting → mapping → testing → waiting | completed | error`

Detailed events such as `page_opening`, `website_opening`, `contact_paths_mapped`, `messenger_reachable`, `message_prepared`, `reply_detected`, and `evidence_captured` appear inside those lifecycles.

The shared prospect report shows a numeric score out of 100 for every verified selected channel. A combined score is shown only when every selected channel has a real verified score; an operational failure never becomes a fake zero or an F.

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
2. Double-click `Start Facebook Audit Agent.vbs`. The private dashboard opens and the agent begins watching both the Website and Facebook queues. The Facebook worker fails safely if its browser adapter does not report that the dedicated profile was selected; it never treats that signal as account-identity verification.
3. Leave the Windows machine signed in. New authorized Website, Facebook, or Both submissions are picked up automatically; no command needs to be run per audit.

The production workstation also uses the existing per-user scheduled task `Phone CEO Facebook Audit Worker`. Its name is kept for compatibility, but the process now handles both audit types. It starts at Windows login, runs hidden, and Task Scheduler restarts it after failures. The installer also adds a dashboard shortcut to the Windows desktop, so normal use requires no terminal or commands.

Before the production form is deployed, the same unified form and private report are available through the running local agent at `http://127.0.0.1:4317/facebook-audit.html`. This route is loopback-only, uses the same durable queue, and still requires the authorization checkbox.

The browser profile defaults to the git-ignored `data/facebook-audit-browser-profile` directory, so it is separate from the normal Facebook browser session without requiring configuration.

## Technical setup and troubleshooting

1. Install dependencies:

   ```powershell
   npm install
   ```

2. In the existing Vercel project, create one **private Vercel Blob** store and connect it to the project. Add its read-write token as `BLOB_READ_WRITE_TOKEN` in Vercel and in the worker's uncommitted `.env.local`.

3. Create an uncommitted `.env.local` with `BLOB_READ_WRITE_TOKEN`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID`. Optionally set `FACEBOOK_AUDIT_PROFILE_DIR`, `FACEBOOK_AUDIT_BROWSER_CHANNEL`, and `FACEBOOK_AUDIT_ALLOWED_ORIGIN`. Keep the existing Telegram token and chat ID; do not create or rotate them.

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
   npm run audit:website-smoke
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
4. Watch the local dashboard through Page open, Messenger reachability, buyer-question preparation, confirmed send, reply observation, disclosure, result, evidence, and final Telegram notification.
5. Confirm the Page received one natural buyer question and, only after a real response, one authorized-audit disclosure containing the audit ID.
6. Confirm the public report shows the real timestamps and result.

If Facebook changes its UI, requires a checkpoint, blocks the account, removes Messenger, or the send cannot be confirmed, the audit must end as a real `error`. An ambiguous prepared send is never retried automatically.

## Operational notes

- Pause/resume controls exist only on the local dashboard.
- The worker processes one selected-channel audit at a time and alternates fairly between Website and Facebook work.
- Website form fields are counted as friction evidence but are never filled or submitted.
- Website URLs are restricted to public HTTP(S) destinations and are checked again after DNS resolution and redirects.
- An F result is final at two minutes. The same browser continues monitoring for a useful late reply for ten minutes from send; late replies are labelled and notified separately without changing the grade.
- The local crash journal stores only audit/send identifiers and timestamps, never message text or credentials.
- Vercel Blob writes use ETag conditions so two worker instances cannot claim the same queued audit.
- Facebook selectors use visible accessibility roles and conservative fallbacks. There is no CAPTCHA bypass or anti-detection behavior.
- Reply classification is deterministic and conservative. The local dashboard can manually review a detected reply while the audit is still waiting.
