import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_image_compress/flutter_image_compress.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:uuid/uuid.dart';

import '../data/models.dart';
import '../data/upload_engine.dart';

/// connectivity_plus -> NetType. VPN/other transports are treated as mobile (conservative for data usage).
class ConnectivityNetworkInfo implements NetworkInfo {
  ConnectivityNetworkInfo([Connectivity? c]) : _c = c ?? Connectivity();
  final Connectivity _c;

  static NetType map(List<ConnectivityResult> r) {
    if (r.isEmpty || r.every((x) => x == ConnectivityResult.none)) return NetType.none;
    if (r.contains(ConnectivityResult.wifi) || r.contains(ConnectivityResult.ethernet)) return NetType.wifi;
    return NetType.mobile;
  }

  @override
  Future<NetType> current() async => map(await _c.checkConnectivity());
  @override
  Stream<NetType> get changes => _c.onConnectivityChanged.map(map).distinct();
}

/// Native (libjpeg-turbo) resize/recompress. Output has no EXIF/GPS and is far smaller than the camera original.
/// Originals are sent byte-for-byte when allowed (they stay protected on the server and are never public).
class NativeImagePreparer implements ImagePreparer {
  @override
  Future<PreparedFile> prepare(String path, {required bool original, required bool dataSaver}) async {
    final mime = path.toLowerCase().endsWith('.png') ? 'image/png' : path.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    if (original || kIsWeb) return PreparedFile(path, mime);
    final dir = await getTemporaryDirectory();
    final out = p.join(dir.path, 'up-${const Uuid().v4()}.jpg');
    final edge = dataSaver ? 1600 : 2560;
    final q = dataSaver ? 70 : 82;
    try {
      final r = await FlutterImageCompress.compressAndGetFile(path, out, minWidth: edge, minHeight: edge, quality: q, keepExif: false, format: CompressFormat.jpeg);
      if (r == null) return PreparedFile(path, mime);
      final smaller = await File(r.path).length() < await File(path).length();
      if (!smaller) {
        try {
          await File(r.path).delete();
        } catch (_) {}
        return PreparedFile(path, mime);
      }
      return PreparedFile(r.path, 'image/jpeg', temporary: true);
    } catch (_) {
      return PreparedFile(path, mime); // HEIC or decoder problem on a low-end device: send as-is, the server converts
    }
  }
}
