import 'package:workmanager/workmanager.dart';

import 'app_services.dart';

const _drainTask = 'event_photos.drain_uploads';

/// Entry point executed by Android WorkManager in a background isolate. WorkManager runs it when the OS allows
/// (battery/doze/network constraints apply) - uploads are therefore best-effort in the background and always resumable.
@pragma('vm:entry-point')
void callbackDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    try {
      final services = await AppServices.create();
      await services.engine.restore();
      await services.engine.idle(timeout: const Duration(minutes: 8));
      await services.syncStatuses();
      await services.engine.dispose();
      return true;
    } catch (_) {
      return false; // WorkManager retries with its own backoff
    }
  });
}

class BackgroundUploads {
  static Future<void> init() async {
    await Workmanager().initialize(callbackDispatcher);
    await Workmanager().registerPeriodicTask(
      'drain-periodic',
      _drainTask,
      frequency: const Duration(minutes: 15),
      constraints: Constraints(networkType: NetworkType.connected),
      existingWorkPolicy: ExistingPeriodicWorkPolicy.keep,
    );
  }

  /// Called whenever new photos are queued so unfinished uploads continue even if the app is swiped away.
  static Future<void> kick() => Workmanager().registerOneOffTask(
        'drain-now',
        _drainTask,
        constraints: Constraints(networkType: NetworkType.connected),
        existingWorkPolicy: ExistingWorkPolicy.replace,
      );
}
