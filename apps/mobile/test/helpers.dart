import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:event_photos/core/api_client.dart';
import 'package:event_photos/data/guest_api.dart';
import 'package:event_photos/data/models.dart';
import 'package:event_photos/data/upload_engine.dart';

/// In-memory upload gateway with fault injection.
class FakeUploadApi implements UploadApi {
  FakeUploadApi({this.chunkBytes = 1000});
  final int chunkBytes;
  final stored = <String, Map<int, Uint8List>>{};
  final log = <String>[];
  final failures = <int, List<ApiException>>{}; // chunk -> queued failures
  ApiException? intentFailure;
  int intents = 0;
  bool expireTokenOnce = false;
  final sizes = <String, int>{};

  @override
  Future<Intent> intent(String guestToken, {required String mime, required int size, String? caption, required String idempotencyKey}) async {
    log.add('intent');
    if (intentFailure != null) throw intentFailure!;
    final id = 'm${++intents}';
    stored[id] = {};
    sizes[id] = size;
    return Intent(id, UploadTarget(token: 't$intents', chunkBytes: chunkBytes, totalChunks: (size / chunkBytes).ceil(), expiresAt: DateTime.now().add(const Duration(hours: 1))));
  }

  @override
  Future<List<int>> received(String mediaId, String uploadToken) async => stored[mediaId]!.keys.toList()..sort();

  @override
  Future<void> putChunk(String mediaId, int n, String uploadToken, Uint8List bytes) async {
    log.add('chunk$n');
    if (expireTokenOnce) {
      expireTokenOnce = false;
      throw ApiException(401, 'upload_token_expired');
    }
    final q = failures[n];
    if (q != null && q.isNotEmpty) throw q.removeAt(0);
    stored[mediaId]![n] = bytes;
  }

  @override
  Future<void> complete(String mediaId, String uploadToken, String idempotencyKey) async => log.add('complete');
  @override
  Future<void> cancel(String mediaId, String uploadToken) async => log.add('cancel:$mediaId');

  Uint8List assembled(String id) => Uint8List.fromList([for (final k in (stored[id]!.keys.toList()..sort())) ...stored[id]![k]!]);
}

class FakeNetwork implements NetworkInfo {
  FakeNetwork([this.type = NetType.wifi]);
  NetType type;
  final _c = StreamController<NetType>.broadcast();
  @override
  Future<NetType> current() async => type;
  @override
  Stream<NetType> get changes => _c.stream;
  void set(NetType t) {
    type = t;
    _c.add(t);
  }
}

/// Records the decision the engine made (original vs compressed) without touching image codecs.
class FakePreparer implements ImagePreparer {
  final calls = <({bool original, bool dataSaver})>[];
  @override
  Future<PreparedFile> prepare(String path, {required bool original, required bool dataSaver}) async {
    calls.add((original: original, dataSaver: dataSaver));
    return PreparedFile(path, 'image/jpeg');
  }
}

Future<String> tempPhoto(Directory dir, int bytes, {String name = 'p.jpg'}) async {
  final f = File('${dir.path}/$name');
  await f.writeAsBytes(Uint8List.fromList(List.generate(bytes, (i) => (i * 31 + 7) % 251)));
  return f.path;
}
