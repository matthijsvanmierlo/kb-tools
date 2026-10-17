/**
 * Verified demo video sources for the Video Assessment module.
 *
 * Each entry was checked to load and allow embedding (NASA media is public domain and served
 * with HTTP range support so seeking works; YouTube/Vimeo IDs verified via their oEmbed APIs).
 * Keep timestamps in seeded checkpoints aligned with the narration of these specific videos.
 */
const NASA = 'https://images-assets.nasa.gov/video';

export const SAMPLE_VIDEOS = [
  {
    key: 'nasa-solar-edge',
    label: 'Where Is the Edge of the Solar System? (NASA, 0:57)',
    subject: 'Earth & Space Science',
    provider: 'html5',
    source: `${NASA}/GSFC_20170905_Solar_m12639_System/GSFC_20170905_Solar_m12639_System~medium.mp4`,
    credit: 'NASA Goddard Space Flight Center (public domain)'
  },
  {
    key: 'nasa-raindrop',
    label: 'Anatomy of a Raindrop (NASA, 2:50)',
    subject: 'Earth Science',
    provider: 'html5',
    source: `${NASA}/GSFC_20130531_GPM_m11288_Raindrop/GSFC_20130531_GPM_m11288_Raindrop~medium.mp4`,
    credit: 'NASA Goddard Space Flight Center (public domain)'
  },
  {
    key: 'yt-crashcourse-entropy',
    label: 'Entropy: Embrace the Chaos! (CrashCourse Chemistry #20)',
    subject: 'Chemistry',
    provider: 'youtube',
    source: 'https://www.youtube.com/watch?v=ZsY4WcQOrfk',
    credit: 'CrashCourse on YouTube'
  },
  {
    key: 'yt-crashcourse-enthalpy',
    label: 'Enthalpy (CrashCourse Chemistry #18)',
    subject: 'Chemistry',
    provider: 'youtube',
    source: 'https://www.youtube.com/watch?v=SV7U4yAXL5I',
    credit: 'CrashCourse on YouTube'
  },
  {
    key: 'vimeo-big-buck-bunny',
    label: 'Big Buck Bunny (Blender Foundation on Vimeo)',
    subject: 'Media literacy / provider test',
    provider: 'vimeo',
    source: 'https://vimeo.com/1084537',
    credit: 'Blender Foundation (CC BY 3.0)'
  }
];

export const DEFAULT_SAMPLE_VIDEO = SAMPLE_VIDEOS[0];

export function getSampleVideo(key) {
  return SAMPLE_VIDEOS.find(v => v.key === key) || null;
}

/**
 * Infer the provider for a pasted URL or ID so authors don't have to pick it manually.
 * Returns null when the input gives no clear signal (e.g. a bare ID).
 */
export function detectVideoProvider(source) {
  const s = String(source || '').trim().toLowerCase();
  if (!s) return null;
  if (/(^|\.)youtube\.com\/|youtu\.be\//.test(s)) return 'youtube';
  if (/(^|\.)vimeo\.com\//.test(s)) return 'vimeo';
  if (/^https?:\/\//.test(s) || /\.(mp4|webm|ogv|ogg|m4v|mov)(\?|#|$)/.test(s)) return 'html5';
  return null;
}

/**
 * Sources that shipped in earlier seed data and no longer work, mapped to working replacements.
 */
export const RETIRED_SOURCES = {
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4': SAMPLE_VIDEOS[0],
  'https://www.youtube.com/watch?v=8m6VtLXF5kg': SAMPLE_VIDEOS[2]
};
