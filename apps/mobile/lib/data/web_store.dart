import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'local_store.dart';
import 'models.dart';

/// Browser store: the upload queue and drafts are in memory (photos are too), the joined-events list survives reloads in localStorage.
class WebStore extends MemoryStore {
  WebStore._(this._prefs, this._events);
  final SharedPreferences _prefs;
  final Map<String, JoinedEvent> _events;
  static const _key = 'web.events';

  static Future<WebStore> open() async {
    final prefs = await SharedPreferences.getInstance();
    final events = <String, JoinedEvent>{};
    try {
      for (final j in (jsonDecode(prefs.getString(_key) ?? '[]') as List).cast<Map<String, dynamic>>()) {
        final e = JoinedEvent.fromJson(j);
        events[e.locator] = e;
      }
    } catch (_) {/* corrupt entry: start empty */}
    return WebStore._(prefs, events);
  }

  Future<void> _persist() => _prefs.setString(_key, jsonEncode([for (final e in _events.values) e.toJson()]));

  @override
  Future<void> putEvent(JoinedEvent e) async {
    _events[e.locator] = e;
    await _persist();
  }

  @override
  Future<List<JoinedEvent>> events() async => _events.values.toList()..sort((a, b) => b.startsAt.compareTo(a.startsAt));

  @override
  Future<void> deleteEvent(String locator) async {
    _events.remove(locator);
    await _persist();
    await super.deleteEvent(locator);
  }
}
