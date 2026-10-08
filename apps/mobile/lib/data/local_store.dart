import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

import 'models.dart';

/// Local persistence for the upload queue, drafts, joined events and data-usage counters.
/// Everything is app-private; the queue survives process death and device restarts.
abstract class LocalStore {
  Future<void> putUpload(UploadItem item);
  Future<List<UploadItem>> uploads({String? eventLocator});
  Future<void> deleteUpload(String id);

  Future<void> putDraft(Draft d);
  Future<List<Draft>> drafts({String? eventLocator});
  Future<void> deleteDraft(String id);

  Future<void> putEvent(JoinedEvent e);
  Future<List<JoinedEvent>> events();
  Future<void> deleteEvent(String locator);

  Future<void> addUsage(NetType net, int bytes);
  Future<UsageTotals> usage();
  Future<void> resetUsage();
}

class SqliteStore implements LocalStore {
  SqliteStore._(this._db);
  final Database _db;

  static Future<SqliteStore> open({String? path}) async {
    final dir = path ?? p.join((await getApplicationSupportDirectory()).path, 'queue.db');
    final db = await openDatabase(dir, version: 1, onCreate: (db, v) async {
      await db.execute('''CREATE TABLE uploads (
        id TEXT PRIMARY KEY, event_locator TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, caption TEXT,
        state TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, attempt INTEGER NOT NULL DEFAULT 0, media_id TEXT, target TEXT, error TEXT,
        server_state TEXT, require_original INTEGER NOT NULL DEFAULT 0, sent_bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)''');
      await db.execute('CREATE INDEX uploads_event ON uploads(event_locator, created_at)');
      await db.execute('CREATE TABLE drafts (id TEXT PRIMARY KEY, event_locator TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL)');
      await db.execute('CREATE TABLE events (locator TEXT PRIMARY KEY, json TEXT NOT NULL)');
      await db.execute('CREATE TABLE usage (net TEXT PRIMARY KEY, bytes INTEGER NOT NULL)');
    });
    return SqliteStore._(db);
  }

  @override
  Future<void> putUpload(UploadItem i) => _db.insert('uploads', i.toRow(), conflictAlgorithm: ConflictAlgorithm.replace);
  @override
  Future<List<UploadItem>> uploads({String? eventLocator}) async =>
      (await _db.query('uploads', where: eventLocator == null ? null : 'event_locator = ?', whereArgs: eventLocator == null ? null : [eventLocator], orderBy: 'created_at ASC')).map(UploadItem.fromRow).toList();
  @override
  Future<void> deleteUpload(String id) => _db.delete('uploads', where: 'id = ?', whereArgs: [id]);

  @override
  Future<void> putDraft(Draft d) => _db.insert('drafts', d.toRow(), conflictAlgorithm: ConflictAlgorithm.replace);
  @override
  Future<List<Draft>> drafts({String? eventLocator}) async =>
      (await _db.query('drafts', where: eventLocator == null ? null : 'event_locator = ?', whereArgs: eventLocator == null ? null : [eventLocator], orderBy: 'created_at DESC')).map(Draft.fromRow).toList();
  @override
  Future<void> deleteDraft(String id) => _db.delete('drafts', where: 'id = ?', whereArgs: [id]);

  @override
  Future<void> putEvent(JoinedEvent e) => _db.insert('events', {'locator': e.locator, 'json': jsonEncode(e.toJson())}, conflictAlgorithm: ConflictAlgorithm.replace);
  @override
  Future<List<JoinedEvent>> events() async =>
      (await _db.query('events')).map((r) => JoinedEvent.fromJson(jsonDecode(r['json'] as String) as Map<String, dynamic>)).toList()..sort((a, b) => b.startsAt.compareTo(a.startsAt));
  @override
  Future<void> deleteEvent(String locator) async {
    await _db.delete('events', where: 'locator = ?', whereArgs: [locator]);
    await _db.delete('uploads', where: 'event_locator = ?', whereArgs: [locator]);
  }

  @override
  Future<void> addUsage(NetType net, int bytes) async {
    if (net == NetType.none) return;
    final k = net == NetType.wifi ? 'wifi' : 'mobile';
    await _db.rawInsert('INSERT INTO usage (net, bytes) VALUES (?, ?) ON CONFLICT(net) DO UPDATE SET bytes = bytes + excluded.bytes', [k, bytes]);
  }

  @override
  Future<UsageTotals> usage() async {
    final rows = await _db.query('usage');
    int m = 0, w = 0;
    for (final r in rows) {
      if (r['net'] == 'mobile') m = (r['bytes'] as num).toInt();
      if (r['net'] == 'wifi') w = (r['bytes'] as num).toInt();
    }
    return UsageTotals(mobileBytes: m, wifiBytes: w);
  }

  @override
  Future<void> resetUsage() => _db.delete('usage');
}

/// In-memory implementation used by unit tests.
class MemoryStore implements LocalStore {
  final _uploads = <String, UploadItem>{};
  final _drafts = <String, Draft>{};
  final _events = <String, JoinedEvent>{};
  int _mobile = 0, _wifi = 0;

  @override
  Future<void> putUpload(UploadItem i) async => _uploads[i.id] = UploadItem.fromRow(i.toRow());
  @override
  Future<List<UploadItem>> uploads({String? eventLocator}) async =>
      _uploads.values.where((u) => eventLocator == null || u.eventLocator == eventLocator).map((u) => UploadItem.fromRow(u.toRow())).toList()..sort((a, b) => a.createdAt.compareTo(b.createdAt));
  @override
  Future<void> deleteUpload(String id) async => _uploads.remove(id);
  @override
  Future<void> putDraft(Draft d) async => _drafts[d.id] = d;
  @override
  Future<List<Draft>> drafts({String? eventLocator}) async => _drafts.values.where((d) => eventLocator == null || d.eventLocator == eventLocator).toList();
  @override
  Future<void> deleteDraft(String id) async => _drafts.remove(id);
  @override
  Future<void> putEvent(JoinedEvent e) async => _events[e.locator] = e;
  @override
  Future<List<JoinedEvent>> events() async => _events.values.toList();
  @override
  Future<void> deleteEvent(String locator) async {
    _events.remove(locator);
    _uploads.removeWhere((_, u) => u.eventLocator == locator);
  }

  @override
  Future<void> addUsage(NetType net, int bytes) async {
    if (net == NetType.mobile) _mobile += bytes;
    if (net == NetType.wifi) _wifi += bytes;
  }

  @override
  Future<UsageTotals> usage() async => UsageTotals(mobileBytes: _mobile, wifiBytes: _wifi);
  @override
  Future<void> resetUsage() async {
    _mobile = 0;
    _wifi = 0;
  }
}

/// App-private directory for captured photos and drafts (not visible to other apps, not in the gallery).
Future<Directory> privatePhotoDir() async {
  final base = await getApplicationSupportDirectory();
  final d = Directory(p.join(base.path, 'photos'));
  if (!await d.exists()) await d.create(recursive: true);
  return d;
}
