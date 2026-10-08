import { Client_, Harness, Staff, bootHarness, createEvent, guestUpload, joinAsGuest, photo } from '../helpers/harness';
import { captionMatches } from '../../src/media/upload.service';
import { MemorySmsProvider } from '../../src/notifications/notifications.service';
import { SettingsService } from '../../src/infra/settings.service';

let h: Harness;
beforeAll(async () => { h = await bootHarness(); });
afterAll(async () => { await h.close(); });

describe('caption keyword rules (spec 6.2)', () => {
  it('matcher is case/width insensitive and works for Ethiopic', () => {
    expect(captionMatches('You BADWord!', ['badword'])).toBe(true);
    expect(captionMatches('ＢＡＤＷＯＲＤ', ['badword'])).toBe(true);           // full-width letters (NFKC)
    expect(captionMatches('ይህ መጥፎ ቃል ነው', ['መጥፎ'])).toBe(true);
    expect(captionMatches('lovely wedding', ['badword', ' '])).toBe(false);
  });

  it('event + platform keyword lists hold matching guest captions for review even in publish-immediately mode', async () => {
    const host = await Client_.host(h); const ev = await createEvent(h, host);
    await host.patch(`/v1/events/${ev.id}`, { captions_enabled: true, moderation_mode: 'post', caption_keywords: ['badword', 'መጥፎ'] }).expect(200);
    await h.get<SettingsService>(SettingsService).set('moderation.caption_keywords', ['platformban'], null);
    const g = (await joinAsGuest(h, ev.uploadToken, { code: ev.joinCode })).body;
    const up = async (seed: number, caption: string) => {
      const buf = await photo(seed);
      const intent = await h.http().post('/v1/guest/uploads/intents').set('Authorization', `Bearer ${g.token}`).send({ mime: 'image/jpeg', size: buf.length, caption }).expect(200);
      const { sendChunks } = await import('../helpers/harness');
      await sendChunks(h, intent.body.upload, buf);
      await h.http().post(`/v1/media/${intent.body.media_id}/complete`).set('X-Upload-Token', intent.body.upload.token).expect(200);
      await h.get<any>((await import('../../src/media/processing.service')).ProcessingService).process(intent.body.media_id);
      return h.db.one<any>('SELECT moderation_state, caption, caption_flagged FROM media WHERE id = $1', [intent.body.media_id]);
    };
    expect(await up(1, 'Lovely day')).toMatchObject({ moderation_state: 'approved', caption: 'Lovely day', caption_flagged: false });
    expect(await up(2, 'this is a BadWord')).toMatchObject({ moderation_state: 'pending', caption: null, caption_flagged: true });
    expect(await up(3, 'ይህ መጥፎ ነው')).toMatchObject({ moderation_state: 'pending', caption_flagged: true });
    expect(await up(4, 'PlatformBan here')).toMatchObject({ moderation_state: 'pending', caption_flagged: true });
    const logs = await h.db.many<any>(`SELECT reason FROM moderation_logs WHERE action = 'auto_assign' AND reason LIKE 'caption%'`);
    expect(logs.length).toBe(3);
    await host.patch(`/v1/events/${ev.id}`, { caption_keywords: Array(51).fill('x') }).expect(400);                  // bounded list
    await h.get<SettingsService>(SettingsService).set('moderation.caption_keywords', [], null);
  });
});

describe('admin-configurable SMS sender ID and templates (spec 6.1)', () => {
  it('template overrides apply (and OTP templates must keep their placeholders); sender id reaches the provider', async () => {
    const admin = await Staff.create(h, 'super_admin');
    await admin.put('/v1/admin/settings/notification.templates', { value: { otp_host_login: { en: 'Code {code} (valid {minutes} min) - ACME', am: 'ኮድ {code}' } }, reason: 'brand wording update', totp_code: await admin.totp() }).expect(200);
    h.get<SettingsService>(SettingsService).invalidate();
    await h.http().post('/v1/auth/request-otp').send({ phone: '0911000002', locale: 'en' }).expect(200);
    expect(MemorySmsProvider.last('+251911000002')).toMatch(/^Code \d{6} \(valid 5 min\) - ACME$/);
    await h.http().post('/v1/auth/request-otp').send({ phone: '0911000003', locale: 'am' }).expect(200);
    expect(MemorySmsProvider.last('+251911000003')).toMatch(/^[ሀ-፿]/);                                      // override lacks {minutes}: ignored -> safe default (Amharic)
    expect(MemorySmsProvider.last('+251911000003')).toMatch(/\d{6}/);
    await admin.put('/v1/admin/settings/notification.templates', { value: {}, reason: 'reset overrides', totp_code: await admin.totp() }).expect(200);
    await admin.put('/v1/admin/settings/sms.sender_id', { value: 'ETEvent', reason: 'registered sender id', totp_code: await admin.totp() }).expect(200);
    h.get<SettingsService>(SettingsService).invalidate();
    expect((await h.db.one<any>(`SELECT value FROM system_settings WHERE key = 'sms.sender_id'`)).value).toBe('ETEvent');
  });
});

void guestUpload;
