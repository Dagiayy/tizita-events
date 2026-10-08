import 'dart:io';
import 'dart:typed_data';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

Future<String> saveBytes(String filename, Uint8List bytes) async {
  final dir = await getApplicationDocumentsDirectory();
  final f = File(p.join(dir.path, filename));
  await f.writeAsBytes(bytes);
  return f.path;
}
