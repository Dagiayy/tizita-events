// Photo file access that works on Android (real files in the app-private directory) and in the browser (bytes held in memory,
// addressed by a `mem://` key). Callers never touch `dart:io` directly so the same UI and upload engine run on both.
export 'file_ops_io.dart' if (dart.library.js_interop) 'file_ops_web.dart';
