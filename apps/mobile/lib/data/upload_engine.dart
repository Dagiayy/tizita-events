import 'dart:async';
import 'dart:math';

import 'package:uuid/uuid.dart';

import '../core/api_client.dart';
import '../core/config.dart';
import 'guest_api.dart';
import 'local_store.dart';
import 'file_ops.dart';
import 'models.dart';
import 'settings.dart';

/// Where we are on the network right now. Implemented with connectivity_plus on device, faked in tests.
abstract class NetworkInfo {
  Future<NetType> current();
  Stream<NetType> get changes;
}

/// Produces the file that is actually uploaded (resized/recompressed with EXIF stripped, or the original).
abstract class ImagePreparer {
  Future<PreparedFile> prepare(String path, {required bool original, required bool dataSaver});
}

class PreparedFile {
  const PreparedFile(this.path, this.mime, {this.temporary = false});
  final String path;
  final String mime;
  final bool temporary;
}

/// 1 s, 2 s, 4 s ... capped at 30 s, +/-25% jitter so a venue full of phones does not retry in lock-step.
int backoffMs(int attempt, [double? rnd]) {
  final base = min(30000, 1000 * pow(2, max(0, attempt - 1)).toInt());
  final r = rnd ?? Random().nextDouble();
  return (base * (0.75 + r * 0.5)).round();
}

/// Errors that retrying cannot fix.
const _permanent = {
  'file_too_large', 'unsupported_type', 'event_storage_full', 'event_media_limit', 'session_blocked', 'upload_closed', 'event_not_accepting_uploads',
  'outside_upload_window', 'event_state_forbids', 'scope_not_granted', 'session_upload_cap', 'consent_required', 'uploads_disabled', 'invalid_chunk_size',
  'size_mismatch', 'media_not_found', 'guest_session_expired',
};

/// Persistent, resumable, rate-friendly upload queue (spec 6.4, 11).
///  * survives process death and reboot (SQLite) and resumes from the chunks the server already holds;
///  * exponential backoff with jitter; waits for connectivity instead of burning battery;
///  * "Wi-Fi only originals": on mobile data a smaller version is sent, the original only on Wi-Fi;
///  * counts bytes per network type (data-usage visibility);
///  * concurrency 2 (1 in data-saver mode) to be gentle on congested venue networks.
class UploadEngine {
  UploadEngine({
    required this.api,
    required this.store,
    required this.network,
    required this.preparer,
    required this.settings,
    required this.tokenFor,
    Future<void> Function(Duration)? sleep,
    DateTime Function()? now,
    double Function()? random,
    this.maxChunkAttempts = 8,
    this.maxBytes = AppConfig.maxPhotoBytes,
  })  : sleep = sleep ?? Future.delayed,
        now = now ?? DateTime.now,
        random = random ?? Random().nextDouble;

  final UploadApi api;
  final LocalStore store;
  final NetworkInfo network;
  final ImagePreparer preparer;
  final AppSettings settings;

  /// Returns the current guest session token for an event (refreshing it if needed).
  final Future<String?> Function(String eventLocator) tokenFor;
  final Future<void> Function(Duration) sleep;
  final DateTime Function() now;
  final double Function() random;
  final int maxChunkAttempts;
  final int maxBytes;

  final _items = <String, UploadItem>{};
  final _running = <String>{};
  final _cancelled = <String>{};
  final _ctrl = StreamController<List<UploadItem>>.broadcast();
  bool _paused = false;
  Completer<void>? _netWake;
  StreamSubscription<NetType>? _netSub;

  Stream<List<UploadItem>> get stream => _ctrl.stream;
  List<UploadItem> get items => (_items.values.toList()..sort((a, b) => a.createdAt.compareTo(b.createdAt)));
  List<UploadItem> forEvent(String locator) => items.where((i) => i.eventLocator == locator).toList();

  void _emit() {
    if (!_ctrl.isClosed) _ctrl.add(items);
  }

  Future<void> _save(UploadItem it) async {
    _items[it.id] = it;
    _emit();
    await store.putUpload(it);
  }

  /// Reload the queue after an app restart / background wake-up and resume unfinished work.
  Future<void> restore() async {
    for (final it in await store.uploads()) {
      if (it.state == UploadState.done || it.state == UploadState.cancelled) {
        await store.deleteUpload(it.id);
        continue;
      }
      if (const {UploadState.uploading, UploadState.retrying, UploadState.waitingNetwork, UploadState.waitingWifi, UploadState.preparing}.contains(it.state)) {
        it.state = UploadState.queued;
      }
      _items[it.id] = it;
    }
    _netSub ??= network.changes.listen((_) {
      _netWake?.complete();
      pump();
    });
    _emit();
    pump();
  }

  Future<String> add(String eventLocator, String path, {String? caption, bool requireOriginal = false}) async {
    final size = await fileLength(path);
    final lower = path.toLowerCase();
    final mime = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.webp') ? 'image/webp' : (lower.endsWith('.heic') || lower.endsWith('.heif')) ? 'image/heic' : 'image/jpeg';
    final it = UploadItem(id: const Uuid().v4(), eventLocator: eventLocator, path: path, size: size, mime: mime, createdAt: now(), caption: caption, requireOriginal: requireOriginal);
    await _save(it);
    pump();
    return it.id;
  }

  void pause() => _paused = true;
  void resume() {
    _paused = false;
    pump();
  }

  Future<void> retry(String id) async {
    final it = _items[id];
    if (it == null || !const {UploadState.failed, UploadState.cancelled}.contains(it.state)) return;
    it.state = UploadState.queued;
    it.error = null;
    it.attempt = 0;
    _cancelled.remove(id);
    await _save(it);
    pump();
  }

  Future<void> cancel(String id) async {
    final it = _items[id];
    if (it == null) return;
    _cancelled.add(id);
    final tok = it.target?.token;
    if (it.mediaId != null && tok != null && it.state != UploadState.done) {
      unawaited(api.cancel(it.mediaId!, tok).catchError((_) {}));
    }
    it.state = UploadState.cancelled;
    await _save(it);
  }

  /// Removes the item from the queue (and its private copy of the photo if the upload never completed).
  Future<void> remove(String id, {bool deleteFile = false}) async {
    _cancelled.add(id);
    final it = _items.remove(id);
    _emit();
    await store.deleteUpload(id);
    if (deleteFile && it != null) {
      try {
        await fileDelete(it.path);
      } catch (_) {}
    }
  }

  void setServerState(String id, String? s) {
    final it = _items[id];
    if (it != null && it.serverState != s) {
      it.serverState = s;
      unawaited(_save(it));
    }
  }

  int get concurrency => settings.dataSaver ? 1 : 2;

  void pump() {
    if (_paused) return;
    for (final it in items) {
      if (_running.length >= concurrency) break;
      if (it.state == UploadState.queued && !_running.contains(it.id)) {
        _running.add(it.id);
        unawaited(_run(it).whenComplete(() {
          _running.remove(it.id);
          pump();
        }));
      }
    }
  }

  /// Completes when nothing is active any more (used by the background worker and tests).
  Future<void> idle({Duration timeout = const Duration(minutes: 9)}) async {
    final end = now().add(timeout);
    while (items.any((i) => i.isActive) || _running.isNotEmpty) {
      if (now().isAfter(end)) return;
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
  }

  // ------------------------------------------------------------------------------------------------ internals
  Future<void> _waitOnline(UploadItem it) async {
    while ((await network.current()) == NetType.none && !_cancelled.contains(it.id)) {
      it.state = UploadState.waitingNetwork;
      await _save(it);
      _netWake = Completer<void>();
      await Future.any([_netWake!.future, sleep(const Duration(seconds: 5))]);
    }
  }

  Future<T?> _withRetry<T>(UploadItem it, Future<T> Function() fn) async {
    for (var attempt = 1;; attempt++) {
      if (_cancelled.contains(it.id)) return null;
      await _waitOnline(it);
      try {
        final r = await fn();
        if (it.state != UploadState.uploading) {
          it.state = UploadState.uploading;
          it.retryInMs = null;
          await _save(it);
        }
        return r;
      } on ApiException catch (e) {
        if (_permanent.contains(e.code) || !e.isTransient || attempt >= maxChunkAttempts) rethrow;
        it.attempt = attempt;
        it.state = UploadState.retrying;
        it.retryInMs = backoffMs(attempt, random());
        await _save(it);
        await sleep(Duration(milliseconds: it.retryInMs!));
      }
    }
  }

  Future<void> _run(UploadItem it) async {
    PreparedFile? prepared;
    try {
      it.state = UploadState.uploading;
      it.error = null;
      await _save(it);
      final token = await tokenFor(it.eventLocator);
      if (token == null) throw ApiException(401, 'guest_session_expired');

      // Decide which version to send for the CURRENT network (spec 6.4: Wi-Fi-only originals, derivatives on mobile data).
      var net = await network.current();
      if (it.requireOriginal && settings.wifiOnlyOriginals && net == NetType.mobile) {
        it.state = UploadState.waitingWifi;
        await _save(it);
        while ((await network.current()) != NetType.wifi && !_cancelled.contains(it.id)) {
          _netWake = Completer<void>();
          await Future.any([_netWake!.future, sleep(const Duration(seconds: 10))]);
        }
        if (_cancelled.contains(it.id)) return;
        it.state = UploadState.uploading;
        await _save(it);
        net = NetType.wifi;
      }
      final wantOriginal = !settings.dataSaver && ((net == NetType.wifi) || !settings.wifiOnlyOriginals) && it.size <= maxBytes;
      prepared = await preparer.prepare(it.path, original: wantOriginal, dataSaver: settings.dataSaver);

      for (var guard = 0; guard < 6; guard++) {
        await _ensureIntent(it, token, prepared);
        final out = await _sendChunks(it, prepared);
        if (out == _Out.cancelled) return;
        if (out == _Out.reintent) {
          it.target = null;
          it.mediaId = null;
          continue;
        }
        final done = await _withRetry(it, () async {
          await api.complete(it.mediaId!, it.target!.token, 'complete-${it.id}');
          return true;
        });
        if (done == null) return;
        it.progress = 100;
        it.state = UploadState.processing;
        await _save(it);
        it.state = UploadState.done;
        await _save(it);
        return;
      }
      throw ApiException(409, 'upload_closed');
    } on ApiException catch (e) {
      if (_cancelled.contains(it.id)) return;
      it.state = UploadState.failed;
      it.error = e.isNetwork ? 'network' : e.code;
      await _save(it);
    } catch (e) {
      if (_cancelled.contains(it.id)) return;
      it.state = UploadState.failed;
      it.error = 'generic';
      await _save(it);
    } finally {
      if (prepared != null && prepared.temporary) {
        try {
          await fileDelete(prepared.path);
        } catch (_) {}
      }
    }
  }

  Future<void> _ensureIntent(UploadItem it, String token, PreparedFile file) async {
    final t = it.target;
    if (t != null && it.mediaId != null && t.expiresAt.difference(now()).inSeconds > 60) return;
    final size = await fileLength(file.path);
    // One key per hour bucket: replays of a lost response return the same intent, while a new bucket (after token expiry) creates a fresh one.
    final key = 'intent-${it.id}-${now().millisecondsSinceEpoch ~/ 3600000}';
    final r = await _withRetry(it, () => api.intent(token, mime: file.mime, size: size, caption: it.caption, idempotencyKey: key));
    if (r == null) throw ApiException(0, 'cancelled');
    it.mediaId = r.mediaId;
    it.target = r.target;
    await _save(it);
  }

  /// Sends only the chunks the server does not have yet.
  Future<_Out> _sendChunks(UploadItem it, PreparedFile file) async {
    final t = it.target!;
    Set<int> have;
    try {
      final rec = await _withRetry(it, () => api.received(it.mediaId!, t.token));
      if (rec == null) return _Out.cancelled;
      have = rec.toSet();
    } on ApiException catch (e) {
      if (e.code == 'upload_token_expired' || e.code == 'invalid_upload_token' || e.status == 404) return _Out.reintent;
      rethrow;
    }
    final length = await fileLength(file.path);
    for (var n = 0; n < t.totalChunks; n++) {
      if (_cancelled.contains(it.id)) return _Out.cancelled;
      if (have.contains(n)) continue;
      final bytes = await fileReadRange(file.path, n * t.chunkBytes, min(t.chunkBytes, length - n * t.chunkBytes));
      final net = await network.current();
      try {
        final r = await _withRetry(it, () async {
          await api.putChunk(it.mediaId!, n, t.token, bytes);
          return true;
        });
        if (r == null && _cancelled.contains(it.id)) return _Out.cancelled;
      } on ApiException catch (e) {
        if (e.code == 'upload_token_expired') return _Out.reintent;
        rethrow;
      }
      have.add(n);
      it.sentBytes += bytes.length;
      await store.addUsage(net, bytes.length);
      it.progress = ((have.length / t.totalChunks) * 100).round();
      it.state = UploadState.uploading;
      await _save(it);
    }
    return _Out.ok;
  }

  Future<void> dispose() async {
    await _netSub?.cancel();
    await _ctrl.close();
  }
}

enum _Out { ok, cancelled, reintent }
