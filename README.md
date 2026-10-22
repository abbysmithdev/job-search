# Job Watch

A single-page job tracker. `job_watch.html` shows listings from `jobs.json`, and a free GitHub Action refreshes `jobs.json` every day.

## Files

- `job_watch.html`: the app (rename it `index.html` on GitHub). Reads `jobs.json` and `descriptions.json`. Saves, hidden roles and your theme stay in your browser.
- `sources.json`: your companies and job boards. This is the file you edit.
- `jobs.json`: the listings. Written by the Action, never by hand.
- `descriptions.json`: full job descriptions for the roles kept, shown when you open a role. Written by the Action.
- `skip.json`: a cache of Greenhouse roles dropped for pay, so they are not re-fetched every day. Written by the Action.
- `scripts/fetch-jobs.mjs`: pulls listings from every source that has a feed.
- `scripts/probe.mjs`: checks whether a company posts on Greenhouse, Lever or Ashby.
- `.github/workflows/refresh.yml`: runs the fetch daily around 7am Central.

## Using the page

Two tabs: **Listings** and **Saved**. Select any role to open its full description, with buttons to open the real listing, save it, or hide it. The **Menu** in the top right holds **Settings** (location, salary, job types, match, display), **Config** (sources, company pool, Refresh now token) and a Light or Dark switch.

## Setup

1. Create a new GitHub repository (for example `job-watch`) and upload everything in this folder, including the `.github` folder.
2. In the repository, open Settings, then Pages. Set the source to Deploy from a branch, branch `main`, folder `/ (root)`.
3. Open the Actions tab. If GitHub asks, enable workflows. Pick Refresh job listings and press Run workflow. This fills `jobs.json` the first time.
4. Visit `https://YOUR-USERNAME.github.io/job-watch/`.

After that the list refreshes by itself. You can press Run workflow again any time you want a fresh pull.

## Refresh now button

The Refresh now button asks GitHub to run the daily workflow early. It takes a one-time setup:

1. On GitHub, open Settings, Developer settings, Personal access tokens, Fine-grained tokens, and generate a new token.
2. Under Repository access, choose Only select repositories and pick this repository.
3. Under Permissions, set Actions to Read and write. Leave everything else alone. Choose an expiry date.
4. On the Job Watch page, open Menu, then Config, and scroll to Refresh now, check the repository name (it is filled in for you on GitHub Pages), paste the token, and press Save settings.

Press Refresh now and the page starts the workflow, then checks for new listings every 15 seconds for up to 4 minutes and updates itself when they arrive. The token and repository name are saved only in that browser, never in the repository. Do this on each device you use. Forget token removes it.

If the token expires, the button shows a message saying GitHub did not accept it. Make a new one and save it again.

## Company pool

`scripts/discover.mjs` builds a larger pool of companies beyond your handpicked favorites. Every Monday (and whenever you run **Discover companies** from the Actions tab) it:

1. Collects company names from `pool-seed.txt`, The Muse's public API, and the first pages of the Tech Jobs for Good job list.
2. Looks for each company's board on Greenhouse, Ashby and Lever and records the result in `pool.json`: **matched** (read by the daily refresh), **unsure** (waiting for your yes or no), or **not found**.
3. Skips anything already in `sources.json` or on the blocklist in `pool-rules.json`.

Pool companies appear only in the Full feed on the Listings page. Config has a Company pool section with the unsure and not-found lists. Your choices (Same company, Different company, Dismiss) are queued in the page and sent to GitHub when you press Apply choices. That uses the same token as Refresh now.

`pool-rules.json` holds the blocklist, how many companies are looked up per run, and which boards are scraped. Built In NYC and Wellfound are switched off there. Not-found companies are tried again after 28 days.

## Trimming what is kept

`filters.json` tells the refresh which roles to keep. Roles outside it are never saved or scored.

- `locations`: `["nyc", "remote"]`. Use `["nyc"]` or `["remote"]` for one, or `[]` to keep every location.
- `minSalary`: `85000`. A role is dropped when the top of its pay range is below this. Roles with no listed pay are kept.

Edit the file on GitHub and the next refresh applies it. Widening it later only brings in roles from that refresh on, so the page's own filters cannot show anything the refresh has already dropped. Delete the file to keep everything.

## Match scores (optional)

After each refresh, `scripts/score-jobs.mjs` asks Claude to rate every open role from 1 to 5 against a skills profile and write a one-line reason. The page shows the score under each role, can sort by it, and Settings has an Only show best matches switch (3 and up).

It needs two repository secrets (Settings, Secrets and variables, Actions, New repository secret):

- `ANTHROPIC_API_KEY`: an API key from the Anthropic Console. API use is billed separately from a Claude subscription.
- `RESUME_PROFILE`: your skills profile as plain text. It lives only in the secret, never in the repository.

Without the secrets, scoring is skipped and everything else works as before.

To change your profile, edit the `RESUME_PROFILE` secret. Every score remembers which profile made it, so the next refreshes re-score all open roles with the new text. At most 150 roles are scored per run, newest first, and the rest follow on later runs. Old scores stay visible until each role gets its new one. Pressing Refresh now runs another batch.

Roles that vanish from the feed are not scored. Workday (Rocky Mountain Institute) gives no description, so those roles are scored from the title alone.

## What is connected

Live feeds: Duolingo, Mindbody (Playlist) and Watershed. Rocky Mountain Institute is set up through Workday, which has not been tested against the real site, so check its status under Sources in Config after the first run. A source whose last check failed shows an Error pill and keeps its last good list.

Everything else is a link-only entry. It shows under Sources in Config with a careers link, but no listings load for it yet.

## Connecting another company

1. Run `node scripts/probe.mjs "Hinge"` on your computer (needs Node 18 or newer). It tries common spellings on Greenhouse, Lever and Ashby and prints an example role for each match.
2. Check that the example role really belongs to your company. Some board names are shared by unrelated companies.
3. In `sources.json`, change that company's `method` to `greenhouse`, `lever` or `ashby` and add `"slug": "the-name-that-matched"`.

Green River Data Group has no careers address yet. Add one as `"url"` in `sources.json` and it will get a link under Sources.

## Things to know

- Dates: for Greenhouse the posting date is the last update, which can change when a company edits a role. New is based on the day the tracker first saw the role. On the first run for a source, each role is dated by its posting date so old roles do not all show as new. Workday gives no date, so all of Rocky Mountain Institute's roles show as new on the first run.
- GitHub turns off scheduled workflows in public repositories after 60 days with no repository activity. If listings stop updating, open the Actions tab and re-enable the workflow.
- GitHub Pages sites are public, so anyone with the address can see `sources.json`, which lists the companies you follow.
- Browser storage is shared by every page on the same GitHub Pages address, so your other apps under that address can read the saved token. Fine if they are all yours. The token only has permission to run this one workflow.
- Opening `job_watch.html` straight from your computer will not load `jobs.json`, because browsers block that. Use GitHub Pages, or run `python3 -m http.server` in the folder and open `http://localhost:8000`.
