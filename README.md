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

**Subtitles are compared against each other, never against the video.** Every other tool in
this space aligns a subtitle to the film's audio, which means downloading the film first —
impossible when you are about to stream it. But subtitles for the same source share a
timeline, so they can be used as each other's reference: the ones that agree with each other
describe the same cut, and a file's release name says which cut it is.

Two subtitles are compared by cross-correlating their cue times over a short list of
frame-rate ratios (25/23.976 and friends) and every plausible offset, scoring the fraction of
cues that land on each other. Measured on real files:

| | Match | What it means |
|---|---|---|
| Two BluRay rips, different groups | **90%** at ratio 1 | same cut — interchangeable |
| PAL DVD → BluRay | **99.5%** stretched by 25/23.976 | same cut, different frame rate — correctable |
| HDTV → BluRay | **37%** at *every* ratio and offset | genuinely different cut — no correction exists |

That gap is why the confidence threshold sits at 0.70, in the empty middle, and why subfit
labels the last case rather than "fixing" it.

Two promises hold everywhere:

- **Nothing is reported that was not established.** A subtitle nobody could measure says
  `unchecked`; it is never condemned as the wrong release, and never starred.
- **Nothing that exists is hidden.** A subtitle that cannot be made to fit is still offered,
  labelled. An upstream that fails appears as an error entry, not as a shorter menu.

## When it cannot help

| Situation | What you see | Why |
|---|---|---|
| No subtitle was ever made for your release's source | everything `⚠️ wrong release`, no star | The catalogue for pre-2010 titles predates streaming releases entirely; a 2005 episode may have BluRay, HDTV and DVD subtitles and **no** WEB ones. Play a release the card marks `✅`. |
| An upstream is slow or down | an `❌` entry naming it, plus everything that did arrive | One public source measures 3–11 s for the same request. A budget protects the response. |
| A subtitle file will not download | still offered, `✅ likely`, judged by its name | The download failing is this service's problem, not evidence against the subtitle. |
| A subtitle has a handful of cues (forced subtitles) | `❔ unchecked` | Too little signal to tell alignment from coincidence. |
| A subtitle is filed under the wrong show | `❔ unchecked`, never starred | Its timings line up with nothing else for the episode, which is what gives it away. |
| Your player sends no filename | everything listed, all `❔ unchecked`, nothing starred | Nothing is known about the file, so nothing may be recommended for it. |
| A very large old catalogue, first view | ~20 s once, then milliseconds | 126 subtitles to fetch and measure. Cached afterwards. |

## How this differs from the alternatives

Subtitle synchronisation is a well-served problem **for files you already have**:

- **[alass](https://github.com/kaegi/alass)** and **[ffsubsync](https://github.com/smacke/ffsubsync)**
  align a subtitle against a video's audio. Excellent, and both need the video.
- **[Bazarr](https://www.bazarr.media/)** scores subtitles by release name and can then sync
  them with alass or ffsubsync. It is built around a Sonarr/Radarr library on disk.
  ([Sub-Zero](https://github.com/pannal/sub-zero.bundle), the Plex equivalent, was archived
  in 2024 in favour of it.)
- **Stremio subtitle addons** fetch and list; the closest relatives are
  [StremioSubtitlesSync](https://github.com/rples/StremioSubtitlesSync) (OpenSubtitles only,
  needs a hash or a debrid account) and
  [subtrans-stremio](https://github.com/hcdbp24c3/subtrans-stremio) (aligns by video
  *duration*, which cannot fix a recap offset).

subfit sits in the gap: **the file is a stream you have not downloaded**, so there is no
audio to align against and no hash to look up. Using subtitles as each other's reference is
what makes a verdict possible at all, and it is also why subfit can answer *before* playback
begins — which no player or addon seems to do today.

**What it deliberately does not do:** align against audio (the one thing that would rescue a
release nobody subtitled), translate, or edit subtitle text.

**One signal it cannot use:** OpenSubtitles' movie-hash matching, which would identify a
subtitle made for the exact file. Players do send the hash, and subfit forwards it upstream,
but the public OpenSubtitles addon ignores it for episodes — verified by requesting the same
episode with and without a hash and receiving byte-identical answers.

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
| `languages` | `["en"]` | Which languages to serve, in preference order. Each gets its own `⭐`. |
| `deadlineMs` | `9000` | Whole budget for answering a subtitle list, upstream lists and bodies together. |
| `sources` | one public OpenSubtitles instance | The addons to ask. Any number, in any order. |
| `logFile` | in the config dir | |

### Sources

`sources` is a list, not a fixed set: which subtitle addons are worth asking depends entirely
on what you watch. Each entry is a name and the base URL of anything speaking the Stremio
subtitle protocol.

```json
{
  "languages": ["en", "he", "ru"],
  "sources": [
    { "name": "wizdom", "url": "https://4b139a4b7f94-wizdom-stremio-v2.baby-beamup.club" },
    { "name": "ktuvit", "url": "https://4b139a4b7f94-ktuvit-stremio.baby-beamup.club" },
    { "name": "opensubtitles", "url": "https://opensubtitles.stremio.homes/en%7Che%7Cru/ai-translated=false%7Cfrom=all" }
  ]
}
```

The name is what appears beside a subtitle that could not be settled, so you know who
supplied it. Upstreams are called as addons, not scraped, so no accounts or API keys are
involved — point them at your own instances if you run any.

More sources means better coverage and slower first builds; measurements only get better
with more subtitles to compare against, since a subtitle is judged by how it lines up with
the others.

### Speed

The first request for an episode costs whatever the slowest upstream costs, up to
`deadlineMs`; everything after is served from a local SQLite cache in milliseconds. Subtitle
bodies and measurements are kept for 30 days, catalogues and rendered menus for 6 hours. The
cache lives beside the config and can be deleted at any time.

`GET /<token>/fit/<type>/<id>` reports what the menu would offer per language for each
release family — `fits`, `fixed` or `wrong` — which is what lets a stream list say whether a
release has working subtitles *before* one is played. It
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
