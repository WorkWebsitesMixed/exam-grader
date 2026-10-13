# loadtest -- pre-migration checks (throwaway tooling)

Two cheap checks before rewriting the exam backend on Cloudflare. Nothing here
touches production; `main` and the Apps Script deployment are unchanged.

## Check 1: 60 simultaneous requests (`worker/` + `loadtest.mjs`)
One-time setup (wrangler is already installed in `worker/node_modules`):

    cd worker
    npx wrangler login
    npx wrangler d1 create examgrader-loadtest     # copy the database_id into wrangler.toml
    npx wrangler d1 execute examgrader-loadtest --remote --file=schema.sql
    npx wrangler deploy                             # prints https://examgrader-loadtest.<you>.workers.dev

Run from this folder:

    node loadtest.mjs --url https://examgrader-loadtest.<you>.workers.dev
    # optional, outside class hours only (reads the live Apps Script):
    node loadtest.mjs --url <worker> --baseline <apps script /exec url>

Then read CPU time p50/p99 in the dashboard (Workers & Pages > Metrics). The
free plan allows 10 ms per request; that figure cannot be measured from outside.
A local dry run already passed (60/60 ok), but local D1 is simulated.

## Check 2: school lab network (`labcheck.html`)
Copy it to the repo root temporarily (it must share github.io with the real
exam), open it on a lab PC as
`.../labcheck.html?src=<apps script /exec url>&worker=<worker url>`, copy the
report. Repeat on a phone hotspot and on a PC from another course. Delete the
file afterwards.

Reading the verdicts: OK = reachable; UNREACHABLE = nothing answered (blocked or
timeout); NOCORS = something answered without CORS headers, which is EITHER an
Apps Script error page under overload OR a filter's block page. The browser
cannot tell them apart: use the "open in new tab" link and read the page.

## Cleanup
`npx wrangler delete` and `npx wrangler d1 delete examgrader-loadtest`.
