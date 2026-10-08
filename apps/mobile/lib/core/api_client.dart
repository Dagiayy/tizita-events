import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'config.dart';

/// Error returned by the platform API. [status] is 0 for connectivity problems (no response).
class ApiException implements Exception {
  ApiException(this.status, this.code, [this.message = '', this.details]);
  final int status;
  final String code;
  final String message;
  final Object? details;

  bool get isNetwork => status == 0;

  /// Failures that may succeed if retried later (network, timeouts, throttling, server errors).
  bool get isTransient => status == 0 || status == 408 || status == 425 || status == 429 || status >= 500;

  @override
  String toString() => 'ApiException($status, $code)';
}

/// Thin typed wrapper over package:http. Every request has a timeout; low-end devices on weak links must never hang.
class ApiClient {
  ApiClient({http.Client? client, String? base, this.timeout = const Duration(seconds: 25)})
      : _http = client ?? http.Client(),
        base = (base ?? AppConfig.apiBase).replaceAll(RegExp(r'/+$'), '');

  final http.Client _http;
  final String base;
  final Duration timeout;

  Uri _uri(String path, [Map<String, String>? query]) => Uri.parse('$base/v1$path').replace(queryParameters: query);

  Future<Map<String, dynamic>> json(
    String method,
    String path, {
    String? token,
    Object? body,
    Map<String, String>? headers,
    Map<String, String>? query,
  }) async {
    final req = http.Request(method, _uri(path, query));
    req.headers['Accept'] = 'application/json';
    if (token != null) req.headers['Authorization'] = 'Bearer $token';
    if (headers != null) req.headers.addAll(headers);
    if (body != null) {
      req.headers['Content-Type'] = 'application/json';
      req.body = jsonEncode(body);
    }
    final res = await _send(req);
    return _decode(res);
  }

  /// Raw binary PUT used by the chunk upload gateway.
  Future<Map<String, dynamic>> putBytes(String path, Uint8List bytes, {required Map<String, String> headers}) async {
    final req = http.Request('PUT', _uri(path));
    req.headers.addAll({'Content-Type': 'application/octet-stream', ...headers});
    req.bodyBytes = bytes;
    return _decode(await _send(req));
  }

  Future<http.Response> _send(http.Request req) async {
    try {
      final streamed = await _http.send(req).timeout(timeout);
      return await http.Response.fromStream(streamed).timeout(timeout);
    } on TimeoutException {
      throw ApiException(0, 'timeout');
    } on SocketException {
      throw ApiException(0, 'network');
    } on http.ClientException {
      throw ApiException(0, 'network');
    } on HandshakeException {
      throw ApiException(0, 'tls');
    }
  }

  Map<String, dynamic> _decode(http.Response res) {
    Map<String, dynamic> body = {};
    if (res.body.isNotEmpty && (res.headers['content-type'] ?? '').contains('json')) {
      try {
        final d = jsonDecode(utf8.decode(res.bodyBytes));
        if (d is Map<String, dynamic>) body = d;
      } catch (_) {/* non-JSON error pages from proxies */}
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return body;
    final e = (body['error'] as Map?)?.cast<String, dynamic>() ?? const {};
    throw ApiException(res.statusCode, (e['code'] as String?) ?? 'http_error', (e['message'] as String?) ?? '', e['details']);
  }

  /// Downloads a (signed, short-lived) URL into memory. Used for saving photos.
  Future<Uint8List> download(String url) async {
    try {
      final res = await _http.get(Uri.parse(url)).timeout(const Duration(seconds: 60));
      if (res.statusCode != 200) throw ApiException(res.statusCode, 'download_failed');
      return res.bodyBytes;
    } on TimeoutException {
      throw ApiException(0, 'timeout');
    } on SocketException {
      throw ApiException(0, 'network');
    }
  }

  void close() => _http.close();
}
