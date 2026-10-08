import 'dart:typed_data';

import '../core/api_client.dart';
import 'models.dart';

/// Endpoints used by the guest experience (same API the web PWA uses: the browser remains a first-class alternative).
class GuestApi {
  GuestApi(this.client);
  final ApiClient client;

  Future<Map<String, dynamic>> context(String locator, {String? lang}) =>
      client.json('GET', '/events/${Uri.encodeComponent(locator)}/context', query: lang == null ? null : {'lang': lang});

  Future<Map<String, dynamic>> join(String locator, Map<String, dynamic> body, {String? bearer}) =>
      client.json('POST', '/events/${Uri.encodeComponent(locator)}/join', body: body, token: bearer);

  Future<Map<String, dynamic>> verify(String locator, Map<String, dynamic> body) =>
      client.json('POST', '/events/${Uri.encodeComponent(locator)}/verify', body: body);

  Future<Map<String, dynamic>> refresh(String token) => client.json('POST', '/guest/refresh', token: token, body: const {});

  Future<Map<String, dynamic>> me(String token) => client.json('GET', '/guest/me', token: token);

  Future<(List<GalleryItem>, String?)> gallery(String token, {String? cursor, bool highlights = false, String? folderId, String? sender, bool mine = false, int limit = 30}) async {
    final r = await client.json('GET', '/guest/media', token: token, query: {
      'limit': '$limit',
      'cursor': ?cursor,
      if (highlights) 'highlights': 'true',
      'folder_id': ?folderId,
      'sender': ?sender,
      if (mine) 'mine': 'true',
    });
    final items = ((r['items'] as List?) ?? const []).map((e) => GalleryItem.fromJson((e as Map).cast<String, dynamic>())).toList();
    return (items, r['next_cursor'] as String?);
  }

  /// "People" boards: approved photo count + covers per named sender, and how many photos have no name.
  Future<(List<SenderBoard>, int)> senders(String token) async {
    final r = await client.json('GET', '/guest/senders', token: token);
    final list = ((r['senders'] as List?) ?? const []).map((e) => SenderBoard.fromJson((e as Map).cast<String, dynamic>())).toList();
    return (list, (r['unnamed'] as num?)?.toInt() ?? 0);
  }

  Future<Map<String, dynamic>> downloadLink(String token, String mediaId, {bool original = false}) =>
      client.json('GET', '/guest/media/$mediaId/download-link', token: token, query: {'variant': original ? 'original' : 'viewer'});

  Future<void> report(String token, String mediaId, String reason, {String? details}) =>
      client.json('POST', '/media/$mediaId/report', token: token, body: {'reason': reason, if (details != null && details.isNotEmpty) 'details': details});

  Future<void> deleteMine(String token, String mediaId) => client.json('DELETE', '/guest/media/$mediaId', token: token);

  Future<void> analytics(String token, String metric) => client.json('POST', '/guest/analytics', token: token, body: {'metric': metric});
}

/// Result of an upload intent.
class Intent {
  const Intent(this.mediaId, this.target);
  final String mediaId;
  final UploadTarget target;
}

/// Upload gateway operations the engine needs. Abstracted so the engine is testable without a network.
abstract class UploadApi {
  Future<Intent> intent(String guestToken, {required String mime, required int size, String? caption, required String idempotencyKey});
  Future<List<int>> received(String mediaId, String uploadToken);
  Future<void> putChunk(String mediaId, int n, String uploadToken, Uint8List bytes);
  Future<void> complete(String mediaId, String uploadToken, String idempotencyKey);
  Future<void> cancel(String mediaId, String uploadToken);
}

class HttpUploadApi implements UploadApi {
  HttpUploadApi(this.client);
  final ApiClient client;

  @override
  Future<Intent> intent(String guestToken, {required String mime, required int size, String? caption, required String idempotencyKey}) async {
    final r = await client.json('POST', '/guest/uploads/intents',
        token: guestToken, headers: {'Idempotency-Key': idempotencyKey}, body: {'mime': mime, 'size': size, if (caption != null && caption.isNotEmpty) 'caption': caption});
    return Intent(r['media_id'] as String, UploadTarget.fromJson((r['upload'] as Map).cast<String, dynamic>()));
  }

  @override
  Future<List<int>> received(String mediaId, String uploadToken) async {
    final r = await client.json('GET', '/uploads/$mediaId', headers: {'X-Upload-Token': uploadToken});
    return ((r['received'] as List?) ?? const []).map((e) => (e as num).toInt()).toList();
  }

  @override
  Future<void> putChunk(String mediaId, int n, String uploadToken, Uint8List bytes) async {
    await client.putBytes('/uploads/$mediaId/chunks/$n', bytes, headers: {'X-Upload-Token': uploadToken});
  }

  @override
  Future<void> complete(String mediaId, String uploadToken, String idempotencyKey) async {
    await client.json('POST', '/media/$mediaId/complete', headers: {'X-Upload-Token': uploadToken, 'Idempotency-Key': idempotencyKey});
  }

  @override
  Future<void> cancel(String mediaId, String uploadToken) async {
    await client.json('DELETE', '/uploads/$mediaId', headers: {'X-Upload-Token': uploadToken});
  }
}
