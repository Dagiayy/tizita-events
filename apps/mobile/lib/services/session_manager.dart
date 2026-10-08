import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/api_client.dart';
import '../core/deep_links.dart';
import '../data/guest_api.dart';
import '../data/local_store.dart';
import '../data/models.dart';

/// Abstraction over the OS keystore so tests can run without a device.
abstract class TokenVault {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

/// Guest session tokens are stored in the Android Keystore-backed encrypted storage (secure mobile local storage, spec 18).
class KeystoreVault implements TokenVault {
  KeystoreVault([FlutterSecureStorage? s]) : _s = s ?? const FlutterSecureStorage();
  final FlutterSecureStorage _s;
  @override
  Future<String?> read(String key) => _s.read(key: key);
  @override
  Future<void> write(String key, String value) => _s.write(key: key, value: value);
  @override
  Future<void> delete(String key) => _s.delete(key: key);
}

class MemoryVault implements TokenVault {
  final map = <String, String>{};
  @override
  Future<String?> read(String key) async => map[key];
  @override
  Future<void> write(String key, String value) async => map[key] = value;
  @override
  Future<void> delete(String key) async => map.remove(key);
}

/// Joins events (no account), keeps short-lived signed guest sessions, and refreshes them before they expire.
class SessionManager {
  SessionManager({required this.api, required this.store, required this.vault, DateTime Function()? now}) : now = now ?? DateTime.now;
  final GuestApi api;
  final LocalStore store;
  final TokenVault vault;
  final DateTime Function() now;

  String _key(String locator) => 'guest.$locator';

  /// Context shown before joining (name, host, date, access requirements, notice).
  Future<Map<String, dynamic>> context(String locator, {String? lang}) => api.context(locator, lang: lang);

  Future<JoinedEvent> join(EventLocator loc, Map<String, dynamic> context, Map<String, dynamic> credentials) async {
    final existing = await vault.read(_key(loc.value));
    final res = await api.join(loc.value, credentials, bearer: existing);
    final ev = (context['event'] as Map).cast<String, dynamic>();
    final joined = JoinedEvent(
      locator: loc.value,
      name: ev['name'] as String,
      hostName: ev['host_name'] as String?,
      venue: ev['venue'] as String?,
      city: ev['city'] as String?,
      startsAt: DateTime.parse(ev['starts_at'] as String),
      language: (ev['language'] as String?) ?? 'en',
      coverUrl: ev['cover_url'] as String?,
      scopes: ((res['scopes'] as List).cast<String>()),
      tokenExpiresAt: now().add(Duration(seconds: (res['expires_in'] as num).toInt())),
      canUpload: (context['can_upload'] as bool?) ?? true,
      downloadsEnabled: (context['downloads_enabled'] as bool?) ?? true,
      captionsEnabled: (context['captions_enabled'] as bool?) ?? false,
      status: (context['status'] as String?) ?? 'open',
      displayName: res['display_name'] as String?,
      type: (ev['type'] as String?) ?? 'other',
    );
    await vault.write(_key(loc.value), res['token'] as String);
    await store.putEvent(joined);
    return joined;
  }

  /// Re-reads the public event info (cover link, type, name). Cover links are short-lived signed URLs, so they are refreshed
  /// whenever the home screen opens. Failures (offline, event gone) are ignored: the stored values keep working.
  Future<JoinedEvent> refreshMeta(JoinedEvent e, {String? lang}) async {
    try {
      final c = await api.context(e.locator, lang: lang);
      final ev = (c['event'] as Map).cast<String, dynamic>();
      e.coverUrl = ev['cover_url'] as String?;
      e.type = (ev['type'] as String?) ?? e.type;
      e.name = (ev['name'] as String?) ?? e.name;
      e.status = (c['status'] as String?) ?? e.status;
      await store.putEvent(e);
    } catch (_) {/* keep what we have */}
    return e;
  }

  /// Adds gallery access to an event the guest already joined (e.g. joined with the upload code, now entering the gallery link/code).
  /// The same session is upgraded, so the event keeps a single entry on the home screen.
  Future<JoinedEvent> unlockGallery(EventLocator galleryLocator, JoinedEvent current, Map<String, dynamic> credentials) async {
    final bearer = await vault.read(_key(current.locator));
    final res = await api.join(galleryLocator.value, credentials, bearer: bearer);
    current.scopes = ((res['scopes'] as List).cast<String>());
    current.tokenExpiresAt = now().add(Duration(seconds: (res['expires_in'] as num).toInt()));
    await vault.write(_key(current.locator), res['token'] as String);
    await store.putEvent(current);
    return current;
  }

  /// Valid token for an event, refreshing it when it expires within an hour. Null when the session is gone (blocked/expired).
  Future<String?> tokenFor(String locator) async {
    final token = await vault.read(_key(locator));
    if (token == null) return null;
    final ev = (await store.events()).where((e) => e.locator == locator).firstOrNull;
    if (ev != null && ev.tokenExpiresAt.difference(now()).inMinutes < 60) {
      try {
        final r = await api.refresh(token);
        await vault.write(_key(locator), r['token'] as String);
        ev.tokenExpiresAt = now().add(Duration(seconds: (r['expires_in'] as num).toInt()));
        ev.scopes = ((r['scopes'] as List).cast<String>());
        await store.putEvent(ev);
        return r['token'] as String;
      } on ApiException catch (e) {
        if (e.status == 401 || e.status == 403) {
          await vault.delete(_key(locator));
          return null;
        }
        // transient: keep using the current token, it may still be valid
      }
    }
    return token;
  }

  Future<void> leave(String locator) async {
    await vault.delete(_key(locator));
    await store.deleteEvent(locator);
    try {
      await (await SharedPreferences.getInstance()).remove('mine.$locator'); // the "Mine" list is local data of this event
    } catch (_) {/* no preferences available (tests) */}
  }
}
