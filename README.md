# Job Watch

A single-page job tracker. `index.html` shows listings from `jobs.json`, and a free GitHub Action refreshes `jobs.json` every day.

## Files

- `index.html`: the app. Reads `jobs.json`. Saves and hidden roles stay in your browser.
- `sources.json`: your companies and job boards. This is the file you edit.
- `jobs.json`: the listings. Written by the Action, never by hand.
- `scripts/fetch-jobs.mjs`: pulls listings from every source that has a feed.
- `scripts/probe.mjs`: checks whether a company posts on Greenhouse, Lever or Ashby.
- `.github/workflows/refresh.yml`: runs the fetch daily around 7am Central.

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
4. On the Job Watch page, open Refresh settings, check the repository name (it is filled in for you on GitHub Pages), paste the token, and press Save settings.

Press Refresh now and the page starts the workflow, then checks for new listings every 15 seconds for up to 4 minutes and updates itself when they arrive. The token and repository name are saved only in that browser, never in the repository. Do this on each device you use. Forget token removes it.

If the token expires, the button shows a message saying GitHub did not accept it. Make a new one and save it again.

## What is connected

Live feeds: Duolingo, Mindbody (Playlist) and Watershed. Rocky Mountain Institute is set up through Workday, which has not been tested against the real site, so check its status in the Sources panel after the first run. A source whose last check failed shows an Error pill and keeps its last good list.

Everything else is a link-only entry. It shows in the Sources panel with a careers link, but no listings load for it yet.

## Connecting another company

1. Run `node scripts/probe.mjs "Hinge"` on your computer (needs Node 18 or newer). It tries common spellings on Greenhouse, Lever and Ashby and prints an example role for each match.
2. Check that the example role really belongs to your company. Some board names are shared by unrelated companies.
3. In `sources.json`, change that company's `method` to `greenhouse`, `lever` or `ashby` and add `"slug": "the-name-that-matched"`.

Green River Data Group has no careers address yet. Add one as `"url"` in `sources.json` and it will get a link in the panel.

## Things to know

- Dates: for Greenhouse the posting date is the last update, which can change when a company edits a role. New is based on the day the tracker first saw the role. On the first run for a source, each role is dated by its posting date so old roles do not all show as new. Workday gives no date, so all of Rocky Mountain Institute's roles show as new on the first run.
- GitHub turns off scheduled workflows in public repositories after 60 days with no repository activity. If listings stop updating, open the Actions tab and re-enable the workflow.
- GitHub Pages sites are public, so anyone with the address can see `sources.json`, which lists the companies you follow.
- Browser storage is shared by every page on the same GitHub Pages address, so your other apps under that address can read the saved token. Fine if they are all yours. The token only has permission to run this one workflow.
- Opening `index.html` straight from your computer will not load `jobs.json`, because browsers block that. Use GitHub Pages, or run `python3 -m http.server` in the folder and open `http://localhost:8000`.
