import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:uuid/uuid.dart';

/// Browser photos live in memory for the life of the tab (there is no private file system to copy them into).
final _mem = <String, Uint8List>{};

Future<int> fileLength(String path) async => (_mem[path] ?? (throw StateError('missing photo'))).length;

Future<void> fileDelete(String path) async {
  _mem.remove(path);
}

bool fileExistsSync(String path) => _mem.containsKey(path);

Future<Uint8List> fileReadRange(String path, int start, int count) async {
  final b = _mem[path] ?? (throw StateError('missing photo'));
  final end = (start + count) > b.length ? b.length : start + count;
  return Uint8List.sublistView(b, start, end);
}

Future<String> importPhoto(XFile f) async {
  final name = f.name.toLowerCase();
  final ext = name.contains('.') ? name.substring(name.lastIndexOf('.')) : '.jpg';
  final key = 'mem://${const Uuid().v4()}$ext';
  _mem[key] = await f.readAsBytes();
  return key;
}

Widget photoImage(String path, {double? width, double? height, int? cacheWidth}) {
  final b = _mem[path];
  if (b == null) return SizedBox(width: width, height: height, child: const Icon(Icons.image_not_supported));
  return Image.memory(b, width: width, height: height, fit: BoxFit.cover, cacheWidth: cacheWidth);
}
