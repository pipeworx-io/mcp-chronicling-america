# @pipeworx/chronicling-america

Full-text search of digitized historical U.S. newspapers from the Library of
Congress's Chronicling America collection — the newspaper, date, place, page
link and an excerpt of the page's OCR text for any person, event or topic.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1866+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `search_newspapers({ query, state?, date_from?, date_to?, limit? })` — pages
  whose OCR text matches `query`, ranked by relevance, `total_matches` first.
  Filter by U.S. state (name or postal code) and by year or exact date.
  Every response carries `data_as_of` and `served_from`:
  - `pipeworx_search` — states in Pipeworx search coverage, and national
    (no-state) questions once the whole collection is covered. Each answer
    carries an `excerpt` of every matching page and a `coverage` block
    (years, pages searched, batches). Coverage grows state by state: a state
    answers here once every Library of Congress batch carrying its papers is
    in. Montana is covered today; the rest of the collection is being added.
    National answers are bounded at about seven seconds; if some partitions
    have not answered by then, `coverage.partial` says how many did.
  - `loc_search` — everything else goes to the Library of Congress search,
    retried a few times because it answers only a fraction of requests. A
    failure there is reported as `upstream_down`, never as "no matches".

## Auth

Keyless.

## Data sources

- Library of Congress, Chronicling America (National Digital Newspaper
  Program) — page OCR text and newspaper title records. US public domain.

Notes for the next person:

- The Library of Congress keyword search is the unreliable part: on
  2026-10-18 a fresh keyword query timed out from every network we tried,
  about 9 times in 10.
- Results from `pipeworx_search` link to the same loc.gov page viewer
  (`page_url`) as the LoC search does; `excerpt` is the page's raw OCR, which
  is noisy for 19th- and early-20th-century type.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "chronicling-america": {
      "url": "https://gateway.pipeworx.io/chronicling-america/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/chronicling-america/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1866+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/search_newspapers \
  -H 'Content-Type: application/json' \
  -d '{"query":"flood","state":"montana","date_from":"1922","date_to":"1922"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/search_newspapers`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "chronicling-america": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-chronicling-america"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-chronicling-america
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Chronicling America data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
