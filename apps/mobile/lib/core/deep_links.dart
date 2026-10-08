import 'config.dart';

/// Result of parsing an event link, code or QR payload.
class EventLocator {
  const EventLocator(this.value, {this.code});

  /// Upload token (`u_…`), gallery token (`g_…`) or 6-9 char join code.
  final String value;

  /// Join code embedded in the link (`?c=`), if any.
  final String? code;

  bool get isToken => value.startsWith('u_') || value.startsWith('g_');

  @override
  bool operator ==(Object other) => other is EventLocator && other.value == value && other.code == code;
  @override
  int get hashCode => Object.hash(value, code);
}

final _token = RegExp(r'^[ug]_[A-Za-z0-9_-]{20,64}$');
final _joinCode = RegExp(r'^[A-HJKMNP-Z2-9]{6,9}$');

/// Secure deep-link handling: only links on the configured web host (https) or the app's custom scheme are accepted,
/// and the extracted value must match the exact token / join-code grammar. Anything else is ignored.
EventLocator? parseEventLink(String input, {String? webHost, String? scheme}) {
  final host = webHost ?? AppConfig.webHost;
  final sch = scheme ?? AppConfig.customScheme;
  final raw = input.trim();
  if (raw.isEmpty || raw.length > 400) return null;

  final direct = _classify(raw);
  if (direct != null) return EventLocator(direct);

  final uri = Uri.tryParse(raw);
  if (uri == null || !uri.hasScheme) return null;
  String? candidate;
  if (uri.scheme == 'https' || (uri.scheme == 'http' && host == 'localhost')) {
    if (uri.host != host) return null;
    final segs = uri.pathSegments;
    if (segs.length == 2 && segs[0] == 'j') candidate = segs[1];
  } else if (uri.scheme == sch) {
    // eventphotos://j/<token>  (host = "j")  or  eventphotos:///j/<token>
    final segs = [if (uri.host.isNotEmpty) uri.host, ...uri.pathSegments];
    if (segs.length == 2 && segs[0] == 'j') candidate = segs[1];
  }
  if (candidate == null) return null;
  final value = _classify(candidate);
  if (value == null) return null;
  final c = uri.queryParameters['c']?.toUpperCase();
  return EventLocator(value, code: c != null && _joinCode.hasMatch(c) ? c : null);
}

String? _classify(String s) {
  if (_token.hasMatch(s)) return s;
  final up = s.toUpperCase();
  if (_joinCode.hasMatch(up)) return up;
  return null;
}
