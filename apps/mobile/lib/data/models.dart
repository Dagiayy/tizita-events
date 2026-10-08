import 'dart:convert';

enum NetType { none, wifi, mobile }

enum UploadState { preparing, queued, uploading, retrying, waitingNetwork, waitingWifi, processing, done, failed, cancelled }

UploadState uploadStateFrom(String s) => UploadState.values.firstWhere((e) => e.name == s, orElse: () => UploadState.queued);

class UploadTarget {
  const UploadTarget({required this.token, required this.chunkBytes, required this.totalChunks, required this.expiresAt});
  final String token;
  final int chunkBytes;
  final int totalChunks;
  final DateTime expiresAt;

  factory UploadTarget.fromJson(Map<String, dynamic> j) => UploadTarget(
        token: j['token'] as String,
        chunkBytes: (j['chunk_bytes'] as num).toInt(),
        totalChunks: (j['total_chunks'] as num).toInt(),
        expiresAt: DateTime.parse(j['expires_at'] as String),
      );

  Map<String, dynamic> toJson() => {'token': token, 'chunk_bytes': chunkBytes, 'total_chunks': totalChunks, 'expires_at': expiresAt.toUtc().toIso8601String()};
}

/// One photo in the persistent upload queue. The photo itself stays in app-private storage ([path]); only metadata is in SQLite.
class UploadItem {
  UploadItem({
    required this.id,
    required this.eventLocator,
    required this.path,
    required this.size,
    required this.mime,
    required this.createdAt,
    this.caption,
    this.state = UploadState.queued,
    this.progress = 0,
    this.attempt = 0,
    this.retryInMs,
    this.mediaId,
    this.target,
    this.error,
    this.serverState,
    this.requireOriginal = false,
    this.sentBytes = 0,
  });

  final String id;
  final String eventLocator;
  final String path;
  final int size;
  final String mime;
  final DateTime createdAt;
  String? caption;
  UploadState state;
  int progress;
  int attempt;
  int? retryInMs;
  String? mediaId;
  UploadTarget? target;
  String? error;

  /// pending | approved | rejected | hidden | duplicate | failed (as reported by the server after upload)
  String? serverState;

  /// User asked for the original quality: only sent on Wi-Fi when "Wi-Fi only originals" is on.
  bool requireOriginal;
  int sentBytes;

  bool get isActive => const {UploadState.preparing, UploadState.queued, UploadState.uploading, UploadState.retrying, UploadState.waitingNetwork, UploadState.waitingWifi}.contains(state);

  Map<String, dynamic> toRow() => {
        'id': id,
        'event_locator': eventLocator,
        'path': path,
        'size': size,
        'mime': mime,
        'caption': caption,
        'state': state.name,
        'progress': progress,
        'attempt': attempt,
        'media_id': mediaId,
        'target': target == null ? null : jsonEncode(target!.toJson()),
        'error': error,
        'server_state': serverState,
        'require_original': requireOriginal ? 1 : 0,
        'sent_bytes': sentBytes,
        'created_at': createdAt.millisecondsSinceEpoch,
      };

  factory UploadItem.fromRow(Map<String, Object?> r) => UploadItem(
        id: r['id'] as String,
        eventLocator: r['event_locator'] as String,
        path: r['path'] as String,
        size: (r['size'] as num).toInt(),
        mime: r['mime'] as String,
        createdAt: DateTime.fromMillisecondsSinceEpoch((r['created_at'] as num).toInt()),
        caption: r['caption'] as String?,
        state: uploadStateFrom(r['state'] as String),
        progress: (r['progress'] as num?)?.toInt() ?? 0,
        attempt: (r['attempt'] as num?)?.toInt() ?? 0,
        mediaId: r['media_id'] as String?,
        target: r['target'] == null ? null : UploadTarget.fromJson(jsonDecode(r['target'] as String) as Map<String, dynamic>),
        error: r['error'] as String?,
        serverState: r['server_state'] as String?,
        requireOriginal: ((r['require_original'] as num?) ?? 0) == 1,
        sentBytes: (r['sent_bytes'] as num?)?.toInt() ?? 0,
      );
}

/// A captured but not yet queued photo ("local drafts"). Deleting a draft deletes the file.
class Draft {
  const Draft({required this.id, required this.eventLocator, required this.path, required this.createdAt});
  final String id;
  final String eventLocator;
  final String path;
  final DateTime createdAt;

  Map<String, dynamic> toRow() => {'id': id, 'event_locator': eventLocator, 'path': path, 'created_at': createdAt.millisecondsSinceEpoch};
  factory Draft.fromRow(Map<String, Object?> r) => Draft(
        id: r['id'] as String,
        eventLocator: r['event_locator'] as String,
        path: r['path'] as String,
        createdAt: DateTime.fromMillisecondsSinceEpoch((r['created_at'] as num).toInt()),
      );
}

/// What the app remembers about an event the guest joined (multi-event support). The session token is NOT stored here
/// (it lives in the OS keystore via flutter_secure_storage).
class JoinedEvent {
  JoinedEvent({
    required this.locator,
    required this.name,
    required this.startsAt,
    required this.language,
    required this.scopes,
    required this.tokenExpiresAt,
    this.hostName,
    this.venue,
    this.city,
    this.coverUrl,
    this.canUpload = true,
    this.downloadsEnabled = true,
    this.captionsEnabled = false,
    this.status = 'open',
    this.displayName,
    this.type = 'other',
  });

  final String locator;
  String name;
  String? hostName;
  String? venue;
  String? city;
  DateTime startsAt;
  String language;
  String? coverUrl;
  List<String> scopes;
  DateTime tokenExpiresAt;
  bool canUpload;
  bool downloadsEnabled;
  bool captionsEnabled;
  String status;
  String? displayName;

  /// Event type (wedding, graduation, ...): picks the sample picture when the host has not uploaded a cover.
  String type;

  bool get hasUpload => scopes.contains('upload');
  bool get hasGallery => scopes.contains('gallery');

  Map<String, dynamic> toJson() => {
        'locator': locator, 'name': name, 'host_name': hostName, 'venue': venue, 'city': city, 'starts_at': startsAt.toUtc().toIso8601String(),
        'language': language, 'cover_url': coverUrl, 'scopes': scopes, 'token_expires_at': tokenExpiresAt.millisecondsSinceEpoch, 'can_upload': canUpload,
        'downloads_enabled': downloadsEnabled, 'captions_enabled': captionsEnabled, 'status': status, 'display_name': displayName, 'type': type,
      };

  factory JoinedEvent.fromJson(Map<String, dynamic> j) => JoinedEvent(
        locator: j['locator'] as String,
        name: j['name'] as String,
        hostName: j['host_name'] as String?,
        venue: j['venue'] as String?,
        city: j['city'] as String?,
        startsAt: DateTime.parse(j['starts_at'] as String),
        language: (j['language'] as String?) ?? 'en',
        coverUrl: j['cover_url'] as String?,
        scopes: ((j['scopes'] as List?) ?? const []).cast<String>(),
        tokenExpiresAt: DateTime.fromMillisecondsSinceEpoch((j['token_expires_at'] as num).toInt()),
        canUpload: (j['can_upload'] as bool?) ?? true,
        downloadsEnabled: (j['downloads_enabled'] as bool?) ?? true,
        captionsEnabled: (j['captions_enabled'] as bool?) ?? false,
        status: (j['status'] as String?) ?? 'open',
        displayName: j['display_name'] as String?,
        type: (j['type'] as String?) ?? 'other',
      );
}

class GalleryItem {
  const GalleryItem({required this.id, required this.width, required this.height, required this.thumb, required this.gallery, required this.viewer, required this.mine, required this.canDownload, this.caption, this.isHighlight = false, this.senderKey, this.senderName});
  final String id;
  final int width, height;
  final String thumb, gallery, viewer;
  final bool mine, canDownload, isHighlight;
  final String? caption;

  /// Opaque per-sender key and display name (null when the host hides uploader names or the guest gave no name).
  final String? senderKey, senderName;

  factory GalleryItem.fromJson(Map<String, dynamic> j) {
    final u = (j['urls'] as Map).cast<String, dynamic>();
    return GalleryItem(
      id: j['id'] as String,
      width: (j['width'] as num?)?.toInt() ?? 1,
      height: (j['height'] as num?)?.toInt() ?? 1,
      thumb: u['thumb'] as String,
      gallery: u['gallery'] as String,
      viewer: u['viewer'] as String,
      mine: (j['mine'] as bool?) ?? false,
      canDownload: (j['can_download'] as bool?) ?? false,
      caption: j['caption'] as String?,
      isHighlight: (j['is_highlight'] as bool?) ?? false,
      senderKey: (j['sender'] as Map?)?['key'] as String?,
      senderName: (j['sender'] as Map?)?['name'] as String?,
    );
  }
}

/// One "person" board in the gallery: a sender, how many approved photos they have, and a few cover thumbnails.
class SenderBoard {
  const SenderBoard({required this.key, required this.name, required this.count, required this.mine, required this.covers});
  final String key;
  final String? name;
  final int count;
  final bool mine;
  final List<String> covers;

  factory SenderBoard.fromJson(Map<String, dynamic> j) => SenderBoard(
        key: j['key'] as String,
        name: j['name'] as String?,
        count: (j['count'] as num?)?.toInt() ?? 0,
        mine: (j['mine'] as bool?) ?? false,
        covers: ((j['covers'] as List?) ?? const []).cast<String>(),
      );
}

class UsageTotals {
  const UsageTotals({this.mobileBytes = 0, this.wifiBytes = 0});
  final int mobileBytes, wifiBytes;
}
