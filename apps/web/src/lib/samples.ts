/** Built-in sample cover pictures, one per event type (see tools/generate-samples.cjs). Used whenever the host has not uploaded a cover. */
const KNOWN = ['wedding', 'birthday', 'graduation', 'conference', 'corporate', 'party', 'family', 'cultural', 'other'];

export const sampleCover = (type?: string | null): string => `/samples/${type && KNOWN.includes(type) ? type : 'other'}.jpg`;

/** The picture to show for an event: its own cover when it has one, otherwise the sample for its type. */
export const eventCover = (e: { cover_url?: string | null; type?: string | null }): string => e.cover_url || sampleCover(e.type);
