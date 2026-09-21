/**
 * A subtitle is timed to a *source*, not to a file. Two rips of the same BluRay share their
 * timing even when the groups, resolutions and codecs differ; a WEB release of the same
 * episode usually does not, because the recap, the intro and the credits are cut
 * differently. So the family below is the unit everything else reasons about.
 */
export type Family = 'WEB' | 'BluRay' | 'HDTV' | 'DVD' | 'unknown';

export interface Release {
  family: Family;
  /** The streaming service, where the name states one: DSNP, AMZN, NF, ATVP, HMAX, HULU. */
  service?: string;
  group?: string;
  resolution?: string;
}

const SERVICE = /\b(DSNP|AMZN|NF|ATVP|HMAX|HULU|iP|PCOK|STAN|CR)\b/i;
const RESOLUTION = /\b(2160p|1080p|720p|576p|480p)\b/i;
// Release groups sit at the end after a hyphen, optionally before a container extension.
const GROUP = /-([A-Za-z0-9_]+?)(?:\[[^\]]*\])?(?:\.(?:mkv|mp4|avi|srt|vtt|sub))?$/;

/**
 * Ordered, and the order is the point. A WEB release may name a disc source in passing
 * ("WEB-DL.BDRip"), so WEB is decided first; otherwise the disc pattern would claim a file
 * whose timing came from a stream. Nothing infers a family it cannot see - an unrecognised
 * name stays `unknown` and is labelled as such, rather than being quietly assumed to match.
 */
const PATTERNS: [Family, RegExp][] = [
  ['WEB', /\b(WEB-?DL|WEB-?Rip|WEB|AMZN|DSNP|NF|HMAX|ATVP|HULU|PCOK|playWEB)\b/i],
  ['BluRay', /\b(BluRay|Blu-Ray|BDRip|BRRip|BDRemux|REMUX|BD25|BD50)\b/i],
  ['HDTV', /\b(HDTV|PDTV|DSR|TVRip)\b/i],
  ['DVD', /\b(DVDRip|DVDR|DVD5|DVD9|DVD|NTSC|PAL)\b/i],
];

export function classify(name: string): Release {
  // Separators vary (dots, underscores, spaces) and the patterns are written with word
  // boundaries, so normalise once rather than complicating every pattern.
  const normalised = name.replace(/[._]/g, ' ');

  let family: Family = 'unknown';
  for (const [candidate, pattern] of PATTERNS) {
    if (pattern.test(normalised)) {
      family = candidate;
      break;
    }
  }

  const release: Release = { family };

  const service = SERVICE.exec(normalised);
  if (service?.[1]) release.service = service[1].toUpperCase();

  const resolution = RESOLUTION.exec(normalised);
  if (resolution?.[1]) release.resolution = resolution[1].toLowerCase();

  // The group is read from the original string: normalising turns "x264-HALCYON" into
  // "x264-HALCYON" unchanged, but stripping dots would swallow a ".mkv" boundary.
  const group = GROUP.exec(name.trim());
  if (group?.[1]) release.group = group[1];

  return release;
}
