import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../data/models.dart';
import '../data/settings.dart';

/// Optional LOCAL notifications (approved photo, event closing). Deliberately no FCM/third-party push: device-token
/// processing by a push vendor needs a documented data-flow assessment first (decision D43).
class LocalNotifier {
  LocalNotifier(this.settings);
  final AppSettings settings;
  final _plugin = FlutterLocalNotificationsPlugin();
  bool _ready = false;

  Future<void> init() async {
    if (_ready || kIsWeb) return;
    await _plugin.initialize(const InitializationSettings(android: AndroidInitializationSettings('@mipmap/ic_launcher')));
    _ready = true;
  }

  Future<void> show(int id, String title, String body) async {
    if (!settings.notifications || kIsWeb) return;
    await init();
    await _plugin.show(
      id,
      title,
      body,
      const NotificationDetails(android: AndroidNotificationDetails('event_updates', 'Event updates', channelDescription: 'Photo approvals and event closure', importance: Importance.defaultImportance)),
    );
  }
}

/// Compares the server-side state of queued uploads with what we last saw and returns the ones that just became approved.
List<UploadItem> newlyApproved(Map<String, String?> before, List<UploadItem> after) =>
    after.where((i) => i.serverState == 'approved' && before[i.id] != 'approved').toList();
