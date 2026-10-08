import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/widgets.dart';

import '../core/api_client.dart';
import '../data/guest_api.dart';
import '../data/local_store.dart';
import '../data/models.dart';
import '../data/settings.dart';
import '../data/upload_engine.dart';
import '../data/web_store.dart';
import 'notifications.dart';
import 'platform_adapters.dart';
import 'session_manager.dart';

/// Composition root: one instance per process (UI isolate or background worker isolate).
class AppServices {
  AppServices({required this.client, required this.guestApi, required this.store, required this.settings, required this.sessions, required this.engine, required this.notifier});

  final ApiClient client;
  final GuestApi guestApi;
  final LocalStore store;
  final AppSettings settings;
  final SessionManager sessions;
  final UploadEngine engine;
  final LocalNotifier notifier;

  static Future<AppServices> create() async {
    final client = ApiClient();
    final api = GuestApi(client);
    final LocalStore store = kIsWeb ? await WebStore.open() : await SqliteStore.open();
    final settings = await AppSettings.load();
    final sessions = SessionManager(api: api, store: store, vault: KeystoreVault());
    final engine = UploadEngine(
      api: HttpUploadApi(client),
      store: store,
      network: ConnectivityNetworkInfo(),
      preparer: NativeImagePreparer(),
      settings: settings,
      tokenFor: sessions.tokenFor,
    );
    return AppServices(client: client, guestApi: api, store: store, settings: settings, sessions: sessions, engine: engine, notifier: LocalNotifier(settings));
  }

  /// Learns the moderation outcome of uploaded photos (pending/approved/rejected) and raises local notifications.
  Future<void> syncStatuses() async {
    final before = {for (final i in engine.items) i.id: i.serverState};
    final byEvent = <String, List<UploadItem>>{};
    for (final i in engine.items.where((i) => i.mediaId != null && i.state == UploadState.done)) {
      (byEvent[i.eventLocator] ??= []).add(i);
    }
    for (final entry in byEvent.entries) {
      final token = await sessions.tokenFor(entry.key);
      if (token == null) continue;
      try {
        final me = await guestApi.me(token);
        final uploads = ((me['uploads'] as List?) ?? const []).cast<Map>();
        for (final it in entry.value) {
          final u = uploads.where((x) => x['id'] == it.mediaId).firstOrNull;
          if (u != null) engine.setServerState(it.id, u['state'] as String?);
        }
      } on ApiException {
        continue; // offline or session gone - try again on the next tick
      }
    }
    for (final a in newlyApproved(before, engine.items)) {
      await notifier.show(a.id.hashCode & 0x7fffffff, 'Event Photos', '✓');
    }
  }
}

/// Makes [AppServices] available to the widget tree.
class Services extends InheritedWidget {
  const Services({super.key, required this.services, required super.child});
  final AppServices services;

  static AppServices of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<Services>()!.services;

  @override
  bool updateShouldNotify(Services old) => old.services != services;
}
