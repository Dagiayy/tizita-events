import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path/path.dart' as p;
import 'package:uuid/uuid.dart';

import 'local_store.dart';

Future<int> fileLength(String path) => File(path).length();

Future<void> fileDelete(String path) async {
  await File(path).delete();
}

bool fileExistsSync(String path) => File(path).existsSync();

/// Reads [count] bytes starting at [start] (one upload chunk).
Future<Uint8List> fileReadRange(String path, int start, int count) async {
  final raf = await File(path).open();
  try {
    await raf.setPosition(start);
    return Uint8List.fromList(await raf.read(count));
  } finally {
    await raf.close();
  }
}

/// Moves a picked/captured photo into the app-private directory (the camera/cache copy is not kept outside the app).
Future<String> importPhoto(XFile f) async {
  final dir = await privatePhotoDir();
  final ext = p.extension(f.path).isEmpty ? '.jpg' : p.extension(f.path);
  final dest = p.join(dir.path, '${const Uuid().v4()}$ext');
  await File(f.path).copy(dest);
  try {
    await File(f.path).delete();
  } catch (_) {}
  return dest;
}

Widget photoImage(String path, {double? width, double? height, int? cacheWidth}) => Image.file(File(path), width: width, height: height, fit: BoxFit.cover, cacheWidth: cacheWidth);
