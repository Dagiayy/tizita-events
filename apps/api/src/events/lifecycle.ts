import { E } from '../common/errors';

/** Event state model from spec section 7. */
export const EVENT_STATES = ['draft', 'scheduled', 'live', 'closing', 'read_only', 'archived', 'deletion_pending', 'deleted', 'suspended'] as const;
export type EventState = (typeof EVENT_STATES)[number];

/** Operations whose availability depends on the lifecycle state. Enforced on the server for every request. */
export type EventAction =
  | 'configure_core'      // name/date/venue/window
  | 'configure_access'    // access modes, secrets, moderation mode, downloads, watermark
  | 'pay'                 // package purchase / add-ons / upgrades
  | 'member_upload'       // host/moderator/photographer uploads
  | 'guest_upload'        // guest uploads (also gated by window + uploads_enabled)
  | 'upload_continue'     // finishing an upload whose intent was created while live
  | 'moderate'
  | 'guest_view'          // guest gallery browsing
  | 'guest_download'
  | 'export'
  | 'close' | 'extend' | 'archive' | 'restore'
  | 'request_deletion' | 'cancel_deletion'
  | 'share'               // QR/links
  | 'suspend' | 'unsuspend';

const ALLOWED: Record<EventAction, EventState[]> = {
  configure_core:   ['draft', 'scheduled', 'live'],
  configure_access: ['draft', 'scheduled', 'live', 'closing', 'read_only', 'archived'],
  pay:              ['draft', 'scheduled', 'live', 'closing', 'read_only', 'archived'],
  member_upload:    ['scheduled', 'live'],
  guest_upload:     ['live'],
  upload_continue:  ['scheduled', 'live', 'closing'],
  moderate:         ['live', 'closing', 'read_only', 'archived'],
  guest_view:       ['live', 'closing', 'read_only'],
  guest_download:   ['live', 'closing', 'read_only'],
  export:           ['live', 'closing', 'read_only', 'archived', 'deletion_pending'],
  close:            ['live'],
  extend:           ['scheduled', 'live', 'closing'],
  archive:          ['read_only'],
  restore:          ['archived'],
  request_deletion: ['draft', 'scheduled', 'live', 'closing', 'read_only', 'archived'],
  cancel_deletion:  ['deletion_pending'],
  share:            ['scheduled', 'live', 'closing', 'read_only'],
  suspend:          ['draft', 'scheduled', 'live', 'closing', 'read_only', 'archived', 'deletion_pending'],
  unsuspend:        ['suspended'],
};

export function stateAllows(state: EventState, action: EventAction): boolean {
  return ALLOWED[action].includes(state);
}

export function assertAllowed(state: EventState, action: EventAction): void {
  if (!stateAllows(state, action)) {
    throw E.conflict('event_state_forbids', `This action is not available while the event is "${state}".`, { state, action });
  }
}

/** Legal state transitions. Anything not listed is rejected, so the lifecycle cannot be skipped. */
const TRANSITIONS: Record<EventState, EventState[]> = {
  draft:            ['scheduled', 'live', 'deletion_pending', 'suspended'],
  scheduled:        ['live', 'deletion_pending', 'suspended'],
  live:             ['closing', 'deletion_pending', 'suspended'],
  closing:          ['read_only', 'live', 'deletion_pending', 'suspended'],
  read_only:        ['archived', 'deletion_pending', 'suspended'],
  archived:         ['read_only', 'deletion_pending', 'suspended'],
  deletion_pending: ['deleted', 'draft', 'scheduled', 'live', 'closing', 'read_only', 'archived', 'suspended'],
  deleted:          [],
  suspended:        ['draft', 'scheduled', 'live', 'closing', 'read_only', 'archived', 'deletion_pending'],
};

export function canTransition(from: EventState, to: EventState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedActions(state: EventState): EventAction[] {
  return (Object.keys(ALLOWED) as EventAction[]).filter((a) => ALLOWED[a].includes(state));
}

/** Where the event should be, given the clock, when it is activated or restored from suspension. */
export function stateFromClock(now: Date, e: { upload_opens_at: Date | string; upload_closes_at: Date | string; closed_at?: Date | string | null; archived_at?: Date | string | null }): EventState {
  if (e.archived_at) return 'archived';
  if (e.closed_at) return 'read_only';
  if (now < new Date(e.upload_opens_at)) return 'scheduled';
  if (now < new Date(e.upload_closes_at)) return 'live';
  return 'closing';
}
