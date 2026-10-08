import 'dart:io';

import 'package:event_photos/core/api_client.dart';
import 'package:event_photos/data/local_store.dart';
import 'package:event_photos/data/models.dart';
import 'package:event_photos/data/settings.dart';
import 'package:event_photos/data/upload_engine.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'helpers.dart';

Future<UploadEngine> engineWith(FakeUploadApi api, MemoryStore store, FakeNetwork net, FakePreparer prep, {Map<String, Object> prefs = const {}, List<Duration>? sleeps, String? token = 'guest-token', Future<void> Function(Duration)? sleep}) async {
  SharedPreferences.setMockInitialValues(prefs);
  final settings = await AppSettings.load();
  return UploadEngine(
    api: api, store: store, network: net, preparer: prep, settings: settings, tokenFor: (_) async => token,
    sleep: sleep ?? (d) async => sleeps?.add(d), random: () => 0.5,
  );
}

void main() {
  late Directory dir;
  setUp(() async => dir = await Directory.systemTemp.createTemp('up'));
  tearDown(() async => dir.delete(recursive: true));

  test('uploads in chunks, byte-exact, with monotonic per-item progress and a single completion', () async {
    final api = FakeUploadApi(); final store = MemoryStore();
    final e = await engineWith(api, store, FakeNetwork(), FakePreparer());
    final progress = <int>[];
    e.stream.listen((l) { if (l.isNotEmpty) progress.add(l.first.progress); });
    final path = await tempPhoto(dir, 3500);
    await e.add('ev1', path);
    await e.idle();
    final it = e.items.single;
    expect(it.state, UploadState.done);
    expect(api.log.where((l) => l.startsWith('chunk')).toList(), ['chunk0', 'chunk1', 'chunk2', 'chunk3']);
    expect(api.log.where((l) => l == 'complete').length, 1);
    expect(api.assembled('m1'), await File(path).readAsBytes());
    expect([...progress]..sort(), progress);
    expect(it.progress, 100);
    expect((await store.usage()).wifiBytes, 3500);                         // data-usage visibility
  });

  test('#7/#8 transient failures retry with exponential backoff and never re-send stored chunks', () async {
    final api = FakeUploadApi()..failures[1] = [ApiException(0, 'network'), ApiException(503, 'x'), ApiException(0, 'timeout')]..failures[2] = [ApiException(429, 'rate_limited')];
    final sleeps = <Duration>[];
    final e = await engineWith(api, MemoryStore(), FakeNetwork(), FakePreparer(), sleeps: sleeps);
    await e.add('ev1', await tempPhoto(dir, 3500));
    await e.idle();
    expect(e.items.single.state, UploadState.done);
    expect(sleeps.map((d) => d.inMilliseconds).toList(), [1000, 2000, 4000, 1000]);
    expect(api.log.where((l) => l == 'chunk0').length, 1);
    expect(api.log.where((l) => l == 'intent').length, 1);
  });

  test('permanent errors fail immediately with a reason; retry works after the cause is fixed', () async {
    final api = FakeUploadApi()..intentFailure = ApiException(409, 'event_storage_full');
    final sleeps = <Duration>[];
    final e = await engineWith(api, MemoryStore(), FakeNetwork(), FakePreparer(), sleeps: sleeps);
    final id = await e.add('ev1', await tempPhoto(dir, 100));
    await e.idle();
    expect(e.items.single.state, UploadState.failed);
    expect(e.items.single.error, 'event_storage_full');
    expect(sleeps, isEmpty);
    api.intentFailure = null;
    await e.retry(id);
    await e.idle();
    expect(e.items.single.state, UploadState.done);
  });

  test('a dead network exhausts the retry budget and surfaces a failure instead of looping forever', () async {
    final api = FakeUploadApi()..failures[0] = List.generate(50, (_) => ApiException(0, 'network'));
    final e = await engineWith(api, MemoryStore(), FakeNetwork(), FakePreparer());
    await e.add('ev1', await tempPhoto(dir, 2000));
    await e.idle();
    expect(e.items.single.state, UploadState.failed);
    expect(e.items.single.error, 'network');
  });

  test('offline: shows "waiting for connection" and resumes when connectivity returns', () async {
    final api = FakeUploadApi(); final net = FakeNetwork(NetType.none);
    final e = await engineWith(api, MemoryStore(), net, FakePreparer(), sleep: (d) => Future<void>.delayed(const Duration(milliseconds: 5)));
    final states = <UploadState>[];
    e.stream.listen((l) { if (l.isNotEmpty) states.add(l.first.state); });
    await e.add('ev1', await tempPhoto(dir, 2500));
    await Future<void>.delayed(const Duration(milliseconds: 60));
    expect(e.items.single.state, UploadState.waitingNetwork);
    expect(api.log, isEmpty);
    net.set(NetType.mobile);
    await e.idle();
    expect(e.items.single.state, UploadState.done);
    expect(states, contains(UploadState.waitingNetwork));
  });

  test('queue persists across app restarts and resumes from the chunks the server already has', () async {
    final api = FakeUploadApi(); final store = MemoryStore();
    final e1 = await engineWith(api, store, FakeNetwork(), FakePreparer(), sleep: (d) async { throw StateError('process killed'); });
    api.failures[2] = [ApiException(0, 'network')];
    await e1.add('ev1', await tempPhoto(dir, 4000));
    await e1.idle();
    expect(e1.items.single.state, UploadState.failed);                        // "killed" mid-way: chunks 0 and 1 are stored
    expect(api.stored['m1']!.keys.toSet(), {0, 1});
    final persisted = (await store.uploads()).single;
    persisted.state = UploadState.uploading;                                  // what a crash leaves behind
    await store.putUpload(persisted);

    final e2 = await engineWith(api, store, FakeNetwork(), FakePreparer());   // new process
    await e2.restore();
    await e2.idle();
    expect(e2.items.single.state, UploadState.done);
    expect(api.log.where((l) => l == 'chunk0').length, 1);
    expect(api.log.where((l) => l == 'chunk1').length, 1);
    expect(api.assembled('m1').length, 4000);
  });

  test('upload token expiry mid-way triggers a fresh intent', () async {
    final api = FakeUploadApi()..expireTokenOnce = true;
    final e = await engineWith(api, MemoryStore(), FakeNetwork(), FakePreparer());
    await e.add('ev1', await tempPhoto(dir, 2500));
    await e.idle();
    expect(e.items.single.state, UploadState.done);
    expect(api.log.where((l) => l == 'intent').length, 2);
  });

  test('Wi-Fi-only originals: mobile data sends the smaller version, Wi-Fi sends the original; "require original" waits for Wi-Fi', () async {
    final prep = FakePreparer(); final net = FakeNetwork(NetType.mobile);
    final e = await engineWith(FakeUploadApi(), MemoryStore(), net, prep, sleep: (d) => Future<void>.delayed(const Duration(milliseconds: 3)));
    await e.add('ev1', await tempPhoto(dir, 1500, name: 'a.jpg'));
    await e.idle();
    expect(prep.calls.single.original, false);                                 // mobile data -> derivative-size file

    net.set(NetType.wifi);
    await e.add('ev1', await tempPhoto(dir, 1500, name: 'b.jpg'));
    await e.idle();
    expect(prep.calls.last.original, true);                                    // Wi-Fi -> original

    net.set(NetType.mobile);
    await e.add('ev1', await tempPhoto(dir, 1500, name: 'c.jpg'), requireOriginal: true);
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(e.items.last.state, UploadState.waitingWifi);
    net.set(NetType.wifi);
    await e.idle();
    expect(e.items.last.state, UploadState.done);
    expect(prep.calls.last.original, true);
  });

  test('data saver always compresses and limits concurrency to 1; usage is counted per network', () async {
    final prep = FakePreparer(); final api = FakeUploadApi(); final store = MemoryStore();
    final e = await engineWith(api, store, FakeNetwork(NetType.mobile), prep, prefs: {'dataSaver': true, 'wifiOnlyOriginals': false});
    expect(e.concurrency, 1);
    await e.add('ev1', await tempPhoto(dir, 2000));
    await e.idle();
    expect(prep.calls.single.original, false); expect(prep.calls.single.dataSaver, true);
    final u = await store.usage();
    expect(u.mobileBytes, 2000); expect(u.wifiBytes, 0);
    await store.resetUsage();
    expect((await store.usage()).mobileBytes, 0);
  });

  test('cancel stops sending and tells the server; a missing guest session fails with a clear reason', () async {
    final api = FakeUploadApi();
    final e = await engineWith(api, MemoryStore(), FakeNetwork(), FakePreparer());
    e.pause();
    final id = await e.add('ev1', await tempPhoto(dir, 3000));
    await e.cancel(id);
    e.resume(); await e.idle();
    expect(e.items.single.state, UploadState.cancelled);
    expect(api.log, isEmpty);
    final e2 = await engineWith(FakeUploadApi(), MemoryStore(), FakeNetwork(), FakePreparer(), token: null);
    await e2.add('ev1', await tempPhoto(dir, 100));
    await e2.idle();
    expect(e2.items.single.error, 'guest_session_expired');
  });

  test('backoff: 1,2,4,8,16,30 s cap with +-25% jitter', () {
    expect([1, 2, 3, 4, 5, 6, 7].map((a) => backoffMs(a, 0.5)).toList(), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(backoffMs(3, 0), 3000);
    expect(backoffMs(3, 1), 5000);
  });

  test('drafts are explicit: deleting a draft removes the record', () async {
    final store = MemoryStore();
    await store.putDraft(Draft(id: 'd1', eventLocator: 'ev1', path: '/x', createdAt: DateTime.now()));
    expect((await store.drafts(eventLocator: 'ev1')).length, 1);
    await store.deleteDraft('d1');
    expect(await store.drafts(), isEmpty);
  });
}
