import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart' show Uint8List;
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../data/file_ops.dart';
import '../data/models.dart';
import '../l10n/app_localizations.dart';
import '../services/app_services.dart';
import 'common.dart';
import 'gallery_tab.dart';
import 'theme.dart';

/// "Mine": every photo this guest added to the event, with a thumbnail and its moderation status.
/// The list is cached on the device (per event) so it is still here after a reload/restart or while offline,
/// and is refreshed from the server (the source of truth) whenever the tab opens or is pulled down.
class MineTab extends StatefulWidget {
  const MineTab({super.key, required this.event});
  final JoinedEvent event;
  @override
  State<MineTab> createState() => _MineTabState();
}

class _Mine {
  _Mine({required this.id, required this.state, required this.createdAt, this.thumb, this.localThumb});
  final String id;
  String state;
  final DateTime createdAt;
  String? thumb;

  /// Small base64 PNG made on this device when the photo was added, so pending photos keep a preview after a reload.
  String? localThumb;

  Map<String, dynamic> toJson() => {'id': id, 'state': state, 'created_at': createdAt.toIso8601String(), 'thumb': thumb, 'local': localThumb};
  factory _Mine.fromJson(Map<String, dynamic> j) => _Mine(id: j['id'] as String, state: j['state'] as String, createdAt: DateTime.parse(j['created_at'] as String), thumb: j['thumb'] as String?, localThumb: j['local'] as String?);
}

class _MineTabState extends State<MineTab> {
  List<_Mine>? _list;
  final _approved = <String, GalleryItem>{}; // full gallery items of my approved photos (for the viewer)
  String? _token;
  Object? _error;
  bool _refreshing = false;

  String get _cacheKey => 'mine.${widget.event.locator}';

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_list == null && !_refreshing) _init();
  }

  Future<void> _init() async {
    await _loadCache();
    await _load();
  }

  Future<void> _loadCache() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_cacheKey);
      if (raw != null && mounted) setState(() => _list = (jsonDecode(raw) as List).cast<Map<String, dynamic>>().map(_Mine.fromJson).toList());
    } catch (_) {/* unreadable cache: just start from the server */}
  }

  Future<void> _saveCache() async {
    try {
      await (await SharedPreferences.getInstance()).setString(_cacheKey, jsonEncode([for (final m in _list ?? const <_Mine>[]) m.toJson()]));
    } catch (_) {}
  }

  Future<void> _load() async {
    final s = Services.of(context);
    setState(() => _refreshing = true);
    try {
      _token = await s.sessions.tokenFor(widget.event.locator);
      if (_token == null) throw 'guest_session_expired';
      final me = await s.guestApi.me(_token!);
      final uploads = ((me['uploads'] as List?) ?? const []).cast<Map>().map((m) => m.cast<String, dynamic>()).toList();

      // Thumbnails of my approved photos (needs the gallery permission; without it the list still shows, just without previews).
      final thumbs = <String, String>{};
      _approved.clear();
      if (widget.event.hasGallery) {
        try {
          String? cursor;
          for (var page = 0; page < 6; page++) {
            final (items, next) = await s.guestApi.gallery(_token!, cursor: cursor, mine: true, limit: 50);
            for (final it in items) {
              thumbs[it.id] = it.thumb;
              _approved[it.id] = it;
            }
            if (next == null) break;
            cursor = next;
          }
        } catch (_) {/* previews are best-effort */}
      }
      // The server only knows photos of the *current* guest session; a re-join starts a new one. So the local record is merged with
      // the server's answer instead of being replaced by it: photos stay listed, and the server wins for any photo it still reports.
      final byId = <String, _Mine>{for (final m in _list ?? const <_Mine>[]) m.id: m};
      for (final i in s.engine.items.where((i) => i.eventLocator == widget.event.locator && i.mediaId != null && i.state == UploadState.done)) {
        byId.putIfAbsent(i.mediaId!, () => _Mine(id: i.mediaId!, state: i.serverState ?? 'processing', createdAt: i.createdAt));
      }
      for (final u in uploads) {
        final id = u['id'] as String;
        byId[id] = _Mine(id: id, state: u['state'] as String, createdAt: DateTime.parse(u['created_at'] as String), thumb: thumbs[id] ?? byId[id]?.thumb, localThumb: byId[id]?.localThumb);
      }
      final merged = byId.values.toList()..sort((a, b) => b.createdAt.compareTo(a.createdAt));
      for (final m in merged.take(60).where((m) => m.localThumb == null)) {
        final local = s.engine.items.where((i) => i.mediaId == m.id && fileExistsSync(i.path)).firstOrNull;
        if (local != null) m.localThumb = await _makeThumb(local.path);
      }
      if (!mounted) return;
      setState(() {
        _list = merged;
        _error = null;
      });
      await _saveCache();
    } catch (e) {
      if (mounted) setState(() => _error = e); // keep showing the cached list
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  /// 160px-wide PNG of a local photo, base64-encoded (null if it cannot be decoded).
  Future<String?> _makeThumb(String path) async {
    try {
      final bytes = await fileReadRange(path, 0, await fileLength(path));
      final codec = await ui.instantiateImageCodec(bytes, targetWidth: 160);
      final frame = await codec.getNextFrame();
      final png = await frame.image.toByteData(format: ui.ImageByteFormat.png);
      return png == null ? null : base64Encode(Uint8List.sublistView(png));
    } catch (_) {
      return null;
    }
  }

  (String, Color, IconData) _status(L10n l, String s) => switch (s) {
        'approved' => (l.approved, const Color(0xFF12B76A), Icons.check_circle_rounded),
        'pending' => (l.pendingApproval, const Color(0xFFF79009), Icons.schedule_rounded),
        'rejected' || 'hidden' || 'deleted' || 'flagged' => (l.rejected, const Color(0xFFD92D3F), Icons.block_rounded),
        'duplicate' => (l.duplicate, Brand.muted, Icons.copy_rounded),
        'failed' => (l.failedLabel, const Color(0xFFD92D3F), Icons.error_rounded),
        _ => (l.processing, Brand.muted, Icons.hourglass_top_rounded),
      };

  Future<void> _delete(_Mine m) async {
    final l = L10n.of(context);
    final s = Services.of(context);
    final tok = await s.sessions.tokenFor(widget.event.locator);
    if (tok == null) return;
    try {
      await s.guestApi.deleteMine(tok, m.id);
      setState(() => _list = _list!.where((x) => x.id != m.id).toList());
      await _saveCache();
    } catch (e) {
      if (mounted) snack(context, errorText(l, e));
    }
  }

  Widget _preview(_Mine m) {
    final engine = Services.of(context).engine;
    final local = engine.items.where((i) => i.mediaId == m.id && fileExistsSync(i.path)).firstOrNull;
    if (m.thumb != null) {
      return Image.network(m.thumb!, webHtmlElementStrategy: WebHtmlElementStrategy.prefer, fit: BoxFit.cover, cacheWidth: 320, gaplessPlayback: true, errorBuilder: (_, _, _) => const ColoredBox(color: Colors.black12, child: Icon(Icons.broken_image)));
    }
    if (local != null) return photoImage(local.path, cacheWidth: 320);
    if (m.localThumb != null) return Image.memory(base64Decode(m.localThumb!), fit: BoxFit.cover, gaplessPlayback: true);
    return ColoredBox(color: Theme.of(context).colorScheme.surfaceContainerHighest, child: const Center(child: Icon(Icons.image_outlined, color: Brand.muted, size: 32)));
  }

  @override
  Widget build(BuildContext context) {
    final l = L10n.of(context);
    final list = _list;
    if (list == null) return Center(child: _error != null ? Text(errorText(l, _error)) : const CircularProgressIndicator());
    final approvedItems = list.where((m) => _approved.containsKey(m.id)).map((m) => _approved[m.id]!).toList();
    return RefreshIndicator(
      onRefresh: _load,
      child: list.isEmpty
          ? ListView(children: [Padding(padding: const EdgeInsets.all(32), child: Center(child: Text(_error != null ? errorText(l, _error) : l.minePhotosEmpty, textAlign: TextAlign.center)))])
          : CustomScrollView(physics: const AlwaysScrollableScrollPhysics(), slivers: [
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 6),
                  child: Row(children: [
                    Text(l.photosCount(list.length), style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                    const Spacer(),
                    if (_refreshing) const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                    if (_error != null && !_refreshing) const Icon(Icons.cloud_off_rounded, size: 18, color: Brand.muted),
                  ]),
                ),
              ),
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(10, 4, 10, 16),
                sliver: SliverGrid(
                  gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 130, mainAxisSpacing: 8, crossAxisSpacing: 8),
                  delegate: SliverChildBuilderDelegate(
                    (c, i) {
                      final m = list[i];
                      final (label, color, icon) = _status(l, m.state);
                      final openable = _approved.containsKey(m.id) && _token != null;
                      return GestureDetector(
                        onTap: openable ? () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ViewerScreen(items: approvedItems, index: approvedItems.indexWhere((x) => x.id == m.id), event: widget.event, token: _token!))) : null,
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(14),
                          child: Stack(fit: StackFit.expand, children: [
                            _preview(m),
                            Positioned(
                              left: 0,
                              right: 0,
                              bottom: 0,
                              child: Container(
                                padding: const EdgeInsets.fromLTRB(6, 16, 6, 5),
                                decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Colors.transparent, Color(0xCC080A14)])),
                                child: Row(children: [
                                  Icon(icon, size: 13, color: color),
                                  const SizedBox(width: 4),
                                  Expanded(child: Text(label, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontSize: 10.5, fontWeight: FontWeight.w600, height: 1.15))),
                                ]),
                              ),
                            ),
                            if (['pending', 'approved'].contains(m.state))
                              Positioned(
                                top: 4,
                                right: 4,
                                child: InkWell(
                                  onTap: () => _delete(m),
                                  child: Container(width: 28, height: 28, decoration: const BoxDecoration(shape: BoxShape.circle, color: Color(0x99000000)), child: const Icon(Icons.delete_outline, size: 16, color: Colors.white)),
                                ),
                              ),
                          ]),
                        ),
                      );
                    },
                    childCount: list.length,
                  ),
                ),
              ),
            ]),
    );
  }
}
