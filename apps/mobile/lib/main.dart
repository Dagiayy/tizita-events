import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';

import 'services/app_services.dart';
import 'services/background.dart';
import 'ui/app.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final services = await AppServices.create();
  if (!kIsWeb) await BackgroundUploads.init();
  runApp(EventPhotosApp(services: services));
}
