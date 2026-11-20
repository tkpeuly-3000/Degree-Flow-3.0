# Degree Flow

**Turn a degree flowchart into a semester plan you can drag around, with every prerequisite checked.**

Students upload screenshots of their degree flowchart. An AI reader (Claude) pulls out every class, its prerequisites and whether it's done. Degree Flow then builds a semester by semester plan that mixes hard and easy classes, follows the student's own requests, and never lets a class land before what it needs.

![Degree Flow plan board](docs/screenshot.png)

## Features

**Read the flowchart**
- Upload the flowchart as a PDF, or up to 6 screenshots or photos (or paste them). PDF pages are turned into compressed images in the browser, so uploads stay small. Describe how to read the chart, for example "yellow is taken, orange is in progress, bold is hard."
- Claude reads each class: code, name, credit hours, prerequisites, classes allowed in the same semester, status, hard or easy, and fall only or spring only.
- A second pass rereads the chart and fixes mistakes, and lists what it changed.
- Anything the AI isn't sure about is flagged in red for the student to check.
- No AI available? Students can type their classes in instead.

**Check the classes**
- Editable table for every class. Prerequisites that aren't on the list get flagged, and prerequisite loops are caught before planning.

**Plan automatically**
- Prerequisites always come first. Long prerequisite chains start early so nothing spills past graduation.
- Each semester mixes at least one easy class with hard classes spread evenly, up to the student's limit.
- Works toward the yearly credit target (for example 30 per academic year), with summers used for electives and easy classes.
- Fall only and spring only classes stay in their season.

**Follow the student's requests first**
- Plain English requests such as "Material Science in Spring 2027", "don't put Dynamics, Fluids and Thermo II together" or "only 3 classes in my last semester" become rules the planner follows before anything else.
- Every rule shows as a chip that can be removed.

**Drag and drop**
- Drag a class to another semester (on phones, hold the grip). Columns turn green where the class is allowed and red where it would break a prerequisite. Bad drops are blocked with the reason.
- Moved classes are pinned so "Auto suggest again" keeps them. Tap the pin to release one.
- Tap a class to light up its whole prerequisite chain. Keyboard users move classes with Shift and the arrow keys.

**Track and save**
- Credit totals per academic year, plus hours, hard class count and easy class check per semester, with warnings.
- Add a semester, start over, save the plan as a file and open it again. Plans are kept in the browser automatically.

## Run it on your computer

Needs [Node.js](https://nodejs.org) 20 or newer. No packages to install.

```bash
npm start
```

Open http://localhost:3000. The planner works right away. To turn on the AI reader, copy `.env.example` to `.env`, add your `ANTHROPIC_API_KEY`, and restart.

Run the tests:

```bash
npm test
```

## Publish it

### Netlify (recommended, includes the AI reader)

The AI reader needs an API key, and that key must stay on a server, never inside the web page. The function in `netlify/functions/claude.mjs` does that.

1. Create an API key at [console.anthropic.com](https://console.anthropic.com) and set a monthly spend limit.
2. Push this repository to GitHub.
3. On [Netlify](https://app.netlify.com) choose **Add new project → Import an existing project → GitHub** and pick the repository. `netlify.toml` already sets everything; leave the build command empty.
4. In **Project configuration → Environment variables**, add `ANTHROPIC_API_KEY`.
5. **Deploys → Trigger deploy.** Every later push to GitHub redeploys automatically.

Optional variables: `CLAUDE_MODEL` (default `claude-sonnet-5-5`) and `HOURLY_LIMIT` (AI calls per visitor per hour, default 20; reading one chart uses 2).

### GitHub Pages (free demo without the AI reader)

GitHub Pages only hosts static files, so it can't keep a key secret. The planner, typing classes, drag and drop and saving all still work there.

1. **Settings → Pages → Source: GitHub Actions.**
2. **Actions → Deploy demo to GitHub Pages → Run workflow.**

## How it works

```
public/
  index.html        page markup
  styles.css        design tokens, light and dark themes
  js/planner.js     the planning engine: terms, prerequisite graph, auto mode, move checks, totals
  js/prompts.js     the prompts sent to Claude and how its answers become rules
  js/ai.js          connects to Claude (claude.ai or the /api/claude endpoint)
  js/app.js         the three steps and the drag and drop board
netlify/functions/
  claude.mjs        server endpoint: validates uploads, rate limits, calls Claude, streams the answer
server.mjs          local server for `npm start`
tests/              unit tests for the planner and the endpoint (node:test, no dependencies)
```

**Auto mode** works in two passes. First it works backward from the last semester to find the latest semester each class can take and still leave room for every class after it. Then it fills semesters in order, placing urgent classes first, then one easy class, then hard classes up to an even share, then everything else, while respecting prerequisites, hour caps, season limits, pins and "keep apart" rules.

**Accuracy safeguards**: a row by row reading prompt, a second checking pass against the images, flags on uncertain boxes, checks for unknown prerequisites and loops, and a review step before any plan is built.

**Privacy**: plans stay in the student's browser. Images go to Claude only when the student presses "Read my flowchart".

## License

MIT © Tabassum Peuly
