import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

Future<String> saveBytes(String filename, Uint8List bytes) async {
  final blob = web.Blob([bytes.toJS].toJS, web.BlobPropertyBag(type: 'image/jpeg'));
  final url = web.URL.createObjectURL(blob);
  final a = web.HTMLAnchorElement()
    ..href = url
    ..download = filename;
  a.click();
  web.URL.revokeObjectURL(url);
  return filename;
}
