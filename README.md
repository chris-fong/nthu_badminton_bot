# NTHU badminton booking bot (macOS · Google Chrome)

Reserves **one Main Campus Alumni Hall badminton court for eight students**, using the normal booking flow in Google Chrome. It chooses any court that is available for the entire requested playing time. You log in and solve the CAPTCHA yourself.

This is an unofficial local assistant for **macOS**, not a service run by NTHU. It is a port of [JasonNababan/nthu-badminton-bot](https://github.com/JasonNababan/nthu-badminton-bot) (Windows · Edge). Booking logic is unchanged. Each person runs it on their own computer with their own account.

## Download and install

1. Install [Node.js LTS](https://nodejs.org/en/download) (version 22 or newer; the macOS installer or `brew install node`) and [Google Chrome](https://www.google.com/chrome/) in `/Applications`.
2. Put this folder somewhere regular, e.g. `~/Documents/nthu_badminton_bot`.
3. Make the launcher executable (once):

   ```sh
   chmod +x "Start Bot.command"
   ```

4. Double-click **Start Bot.command**. On the first run it downloads the required packages; then it opens the Chrome dashboard. Keep the Terminal window open while the bot is running.

   If macOS says the file cannot be opened because it is from an unidentified developer, right-click it → **Open** → **Open**, or run `xattr -d com.apple.quarantine "Start Bot.command"`.

Alternative from Terminal: `npm ci --ignore-scripts` then `npm start`.

## Start

1. Double-click **Start Bot.command**.
2. In the Chrome dashboard, click **Open booking / log in**. Log in in the booking tab and dismiss any login notice.
3. Return to the dashboard and click **Check connection**. This selects Main Campus / Alumni Hall and shows the site's time-slot labels.
4. Choose the playing date, start, and end. Use the exact slot boundaries the site offers. The bot supports one or two consecutive slots on the **same court**.
5. To try filling without automatic submission, choose **No — fill only; I can submit manually** under **Should the bot submit?**, then press **Fill form only**. The bot selects the court and fills eight students. After it finishes, you can click the site's Submit button yourself.
6. For automatic reservation, choose **Yes — Live: book automatically**, set the desired booking start date/time, and press **Start automatic booking**. This arms automatic submission; no further confirmation is required.

All booking start dates and times mean **Taiwan time (UTC+8)**, regardless of the Mac's timezone. The default scheduled time is 00:01.

The booking grid currently shows **today through four days ahead**. For example, Thursday becomes visible on Sunday.

## Timing and repetition

The bot loads the venue form before the target time and checks login again roughly 15 seconds beforehand. At the target time it refreshes availability, selects a matching court, fills the form, verifies the outgoing request, and submits once. Availability polling, when enabled, waits at least one second between completed checks.

Choose once, daily or weekly, with 1–12 runs. Repeats advance both dates while preserving times. A failed or uncertain result stops the series. A rehearsal always stops after its first filled form.

## macOS notes

- While the bot runs it starts `caffeinate -i` to stop **idle** sleep. It cannot prevent sleep when the lid is closed (unless an external display and power are connected). Keep the lid open and the Mac plugged in for scheduled runs.
- Keep the clock synchronized: System Settings → General → Date & Time → **Set time and date automatically**.
- The bot uses its own Chrome profile in `.runtime/chrome-profile`, separate from your normal Chrome. Logins in your ordinary Chrome are not shared with it. The bot's Chrome window appears as a separate Chrome instance in the Dock.
- Closing all the bot's tabs, pressing **Cmd+Q** in the bot's Chrome, clicking **Close bot**, or pressing **Ctrl+C** in Terminal stops the bot.
- `.runtime/dashboard.webloc` reopens the current dashboard while the bot is running (the token changes each launch).

## Results and duplicate prevention

- **Rehearsal complete:** the booking form is filled; no reservation was sent.
- **Submitted:** the server responded successfully and the site navigated to its application list. Check the site's status for final approval.
- **Needs review:** a request may have reached the server, but the outcome is uncertain. Check the site's application list before doing anything else.
- **Error:** read the dashboard message and booking tab.

Before sending, the bot checks the venue ID, date, time-slot IDs, court number and exactly eight students. It writes a local attempt record before allowing one submission. Overlapping time ranges are blocked after an attempt. It never automatically retries a reservation submission.

If an attempt definitely failed and the site's application list confirms no reservation exists, close the bot and remove only the corresponding entry from `.runtime/attempts.json` before trying again. The log is `.runtime/bot.log`.

## Local files

`.runtime/` contains the browser login session, saved settings, activity log and attempt history. Keep it private. The dashboard only listens on `127.0.0.1` and its API requires the per-launch token. When sharing the folder, exclude `.runtime` and `node_modules`.

## Troubleshooting

- **"Could not start Google Chrome":** install Chrome in `/Applications`, and make sure no other bot instance is running.
- **Node.js is not found:** install Node.js LTS, then reopen Start Bot.command.
- **Login or connection check fails:** complete the CAPTCHA in the bot's Chrome window, dismiss any login notice, and click Check connection again.
- **No court is available:** check the exact playing date and the time-slot labels shown after Check connection.
- **"The bot is already running":** use the open dashboard, or quit the other instance.

## Verification

Run `npm ci --ignore-scripts` and then `npm test`. Tests use local fixtures in headless Chrome and never make real reservations. Run a fill-only check on your own account before scheduling an unattended live booking.
