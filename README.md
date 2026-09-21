# subfit

A Stremio subtitle addon that fits subtitles to the release you are actually playing.

Subtitles are timed to a *source*, not to a title. A subtitle made for a BluRay rip does not
fit a WEB-DL of the same episode — the recap, the intro and the credits are cut differently —
and a subtitle made for a PAL DVD runs 4% fast against everything else. Subtitle menus do not
tell you any of this, so you pick one, watch it drift, and nudge it by hand.

subfit wraps the subtitle addons you already use and, for each subtitle, says how it relates
to the file in front of you:

```
⭐ best · ✅ fits · BluRay CtrlHD
✅ fits · BluRay HALCYON
✅ likely · BluRay ESiR
⏱ fixed DVD→BluRay +0.4s · SAiNTS
⚠️ wrong release · HDTV LOL
❔ unchecked · Prison Break S01E06 [opensubtitles]
```

The verdict comes first, because it is the only part that decides anything. Your player
already shows the language above each entry, so the label does not repeat it.

- **`✅ fits`** — measured against a subtitle known to match your file.
- **`✅ likely`** — the release name says it fits and nothing contradicted it, but no
  measurement was possible.
- **`⏱ fixed`** — it did not fit, the correction was measured against a subtitle that does,
  and it has been applied. The shift is shown.
- **`⚠️ wrong release`** — nothing can make it fit. Still offered, because sometimes it is
  the only subtitle in your language that exists.
- **`❔ unchecked`** — nothing could be settled. A subtitle whose only claim to fit is its
  own filename, with nothing to corroborate it, lands here too: subtitle sites file the
  occasional entry under the wrong show, and one of those should not be presented as a
  match.
- **`⭐ best`** — the pick for each language, at the top of the list.

Duplicates are collapsed. One episode's Hebrew menu routinely carries the same file two or
three times under different names.

## How it decides

Two subtitles are compared by cross-correlating their cue times over a short list of
frame-rate ratios (25/23.976 and friends) and every plausible offset, scoring the fraction of
cues that land on each other. Measured on real files, two BluRay rips from different groups
agree at ~90%, a PAL DVD subtitle reaches 99.5% once stretched by 25/23.976, and an HDTV
subtitle against a BluRay one peaks at ~37% *at every ratio and offset* — the cut genuinely
differs, so no single correction exists. That gap is why the threshold sits in the middle of
it, and why subfit refuses to "fix" the last case instead of guessing.

Nothing is ever hidden. A subtitle that cannot be made to fit is labelled, not dropped, and
an upstream that fails appears in the list as an error entry rather than as a shorter menu.

## Running it

Requires Node 22 or newer.

```bash
npm ci
npm run build
node dist/server.mjs
```

On first run it writes `~/.config/subfit/config.json` with a generated token, then serves:

```
http://<host>:18702/<token>/manifest.json
```

Add that URL to your player, or to an aggregator as a custom addon.

### Configuration

`~/.config/subfit/config.json`, or set `SUBFIT_DIR` to keep it elsewhere. An invalid field
falls back to its default and says so in the log rather than stopping the service.

| Key | Default | What it does |
|---|---|---|
| `port` | `18702` | |
| `token` | generated | Path prefix for every route. |
| `languages` | `["en","he","ru"]` | Which languages to serve, in preference order. Each gets its own `⭐`. |
| `deadlineMs` | `9000` | Whole budget for answering a subtitle list, upstream lists and bodies together. |
| `sources.wizdom` | public instance | Any addon speaking the Stremio subtitle protocol. |
| `sources.ktuvit` | public instance | |
| `sources.opensubtitles` | public instance | |
| `logFile` | in the config dir | |

Upstreams are called as addons, not scraped, so no accounts or API keys are involved. Point
them at your own instances if you run any.

### Speed

The first request for an episode costs whatever the slowest upstream costs, up to
`deadlineMs`; everything after is served from a local SQLite cache in milliseconds. Subtitle
bodies and measurements are kept for 30 days, catalogues and rendered menus for 6 hours. The
cache lives beside the config and can be deleted at any time.

`GET /<token>/families/<type>/<id>` reports which timing families exist per language, which
is useful for showing whether a release has subtitles at all *before* one is played. It
**never waits on an upstream**: it answers from cache or returns `{}`, and a miss starts the
build in the background. That is deliberate — it is read while a list of streams is being
assembled, and one upstream has been measured at anything from 0.2 to 11 seconds for the same
request. Calling it when the stream list opens gives the subtitle menu a head start of
seconds before anyone presses play.

## Development

```bash
npm test          # vitest
npm run typecheck
npm run build     # tsdown → one self-contained dist/server.mjs
```

The alignment tests assert measurements taken from real subtitle files rather than invented
numbers, including the one that keeps the service honest: HDTV against BluRay must stay below
the confidence floor, and the selector must refuse to re-time it. Test fixtures are cue-time
vectors, not subtitle text.

## License

MIT
