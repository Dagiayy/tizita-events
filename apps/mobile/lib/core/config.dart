import 'package:flutter/foundation.dart' show kIsWeb;

/// Build-time configuration. No secrets live in the app: it only ever talks to the platform API with short-lived
/// guest tokens (no database, object-storage or payment credentials exist on the device).
///
///   flutter run --dart-define=API_BASE=https://api.example.et --dart-define=WEB_HOST=photos.example.et
class AppConfig {
  /// 10.0.2.2 is the host machine as seen from the Android emulator.
  static const String apiBase = String.fromEnvironment('API_BASE', defaultValue: kIsWeb ? 'http://localhost:4000' : 'http://10.0.2.2:4000');

  /// Hostname of the guest web app. Only links on this host (and the custom scheme) are accepted as event links.
  static const String webHost = String.fromEnvironment('WEB_HOST', defaultValue: 'localhost');

  static const String customScheme = 'eventphotos';
  static const int maxPhotoBytes = 15 * 1024 * 1024;

  static String get webOrigin => webHost == 'localhost' ? 'http://$webHost:3100' : 'https://$webHost';
}
