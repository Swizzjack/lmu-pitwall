export const VOICES = [
  {
    id: 'cori-gb-high',
    displayName: 'Cori',
    languageTag: 'en-GB',
    description: 'British female, clear and calm',
    approxSizeMB: 110,
    sampleFile: '/samples/race-engineer/cori-gb-high.mp3',
  },
  {
    id: 'danny-us-low',
    displayName: 'Danny',
    languageTag: 'en-US',
    description: 'US male, deep and grounded',
    approxSizeMB: 25,
    sampleFile: '/samples/race-engineer/danny-us-low.mp3',
  },
  {
    id: 'northern-male-gb-medium',
    displayName: 'Northern English',
    languageTag: 'en-GB',
    description: 'British male, classic race engineer vibe',
    approxSizeMB: 60,
    sampleFile: '/samples/race-engineer/northern-male-gb-high.mp3',
  },
  {
    id: 'joe-us-medium',
    displayName: 'Joe',
    languageTag: 'en-US',
    description: 'US male, neutral and professional',
    approxSizeMB: 60,
    sampleFile: '/samples/race-engineer/joe-us-medium.mp3',
  },
] as const

export type VoiceId = (typeof VOICES)[number]['id']

export const RADIO_CHECK_PHRASE =
  'Radio check, radio check. Box this lap, box this lap. Push now, you have good pace.'

export const LANGUAGE_FLAG: Record<string, string> = {
  'en-GB': '🇬🇧',
  'en-US': '🇺🇸',
}
