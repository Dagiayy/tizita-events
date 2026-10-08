import 'package:flutter/material.dart';

import '../core/deep_links.dart';
import '../data/models.dart';
import '../data/save_file.dart';
import '../l10n/app_localizations.dart';
import '../services/app_services.dart';
import 'common.dart';
import 'scan_screen.dart';
import 'theme.dart';

enum _View { all, highlights, people, yours }

enum _Layout { grid, masonry, list, bySender }

/// Event gallery: approved photos only (the server never returns anything else), newest first, cursor pagination.
/// Browse everything at once, filter to highlights / your own photos / one person, or open the People view (one board per sender),
/// and switch between grid, collage, large and grouped-by-sender layouts.
class GalleryTab extends StatefulWidget {
  const GalleryTab({super.key, required this.event, this.onUnlocked});
  final JoinedEvent event;
  final VoidCallback? onUnlocked;
  @override
  State<GalleryTab> createState() => _GalleryTabState();
}

class _GalleryTabState extends State<GalleryTab> {
  final _items = <GalleryItem>[];
  final _scroll = ScrollController();
  String? _cursor;
  bool _loading = false, _done = false;
  Object? _error;
  String? _token;

  _View _view = _View.all;
  _Layout _layout = _Layout.grid;
  SenderBoard? _sender; // set while looking at one person's photos
  List<SenderBoard>? _senders;
  int _unnamed = 0;

  final _link = TextEditingController(), _code = TextEditingController();
  bool _unlocking = false;
  Object? _unlockError;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (_scroll.hasClients && _scroll.position.pixels > _scroll.position.maxScrollExtent - 600) _load();
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_items.isEmpty && !_loading && _error == null && widget.event.hasGallery) _load(reset: true);
  }

  @override
  void dispose() {
    _link.dispose();
    _code.dispose();
    _scroll.dispose();
    super.dispose();
  }

  bool get _peopleBoards => _view == _View.people && _sender == null;

  Future<void> _load({bool reset = false}) async {
    if (_loading || (_done && !reset) || _peopleBoards) return;
    final s = Services.of(context);
    setState(() {
      _loading = true;
      _error = null;
      if (reset) {
        _items.clear();
        _cursor = null;
        _done = false;
      }
    });
    try {
      _token ??= await s.sessions.tokenFor(widget.event.locator);
      if (_token == null) throw 'guest_session_expired';
      final (items, next) = await s.guestApi.gallery(_token!, cursor: _cursor, highlights: _view == _View.highlights, mine: _view == _View.yours, sender: _sender?.key);
      if (!mounted) return;
      setState(() {
        _items.addAll(items.where((n) => !_items.any((e) => e.id == n.id)));
        _cursor = next;
        _done = next == null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadSenders() async {
    final s = Services.of(context);
    try {
      _token ??= await s.sessions.tokenFor(widget.event.locator);
      if (_token == null) throw 'guest_session_expired';
      final (list, unnamed) = await s.guestApi.senders(_token!);
      if (mounted) {
        setState(() {
          _senders = list;
          _unnamed = unnamed;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  void _setView(_View v) {
    if (_view == v && _sender == null) return;
    setState(() {
      _view = v;
      _sender = null;
      _items.clear();
      _error = null;
    });
    if (v == _View.people) {
      _loadSenders();
    } else {
      _load(reset: true);
    }
  }

  void _openSender(SenderBoard b) {
    setState(() {
      _view = _View.people;
      _sender = b;
    });
    _load(reset: true);
  }

  Future<void> _refresh() async {
    if (_peopleBoards) return _loadSenders();
    await _load(reset: true);
  }

  void _openViewer(int i) => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ViewerScreen(items: List.of(_items), index: i, event: widget.event, token: _token!)));

  // ---------------------------------------------------------------- unlock (gallery link / code)
  Future<void> _scanGallery() async {
    final loc = await Navigator.push<EventLocator>(context, MaterialPageRoute(builder: (_) => const ScanScreen(pickOnly: true)));
    if (loc != null && mounted) {
      _link.text = loc.value;
      await _unlock(loc);
    }
  }

  Future<void> _unlock([EventLocator? scanned]) async {
    final l = L10n.of(context);
    final loc = scanned ?? parseEventLink(_link.text);
    if (loc == null) {
      setState(() => _unlockError = 'invalid');
      return;
    }
    final extra = _code.text.trim();
    final body = <String, dynamic>{
      if (!loc.isToken) 'code': loc.value,
      if (extra.isNotEmpty) ...{'code': extra, 'passcode': extra},
    };
    setState(() {
      _unlocking = true;
      _unlockError = null;
    });
    try {
      final s = Services.of(context);
      await s.sessions.unlockGallery(loc, widget.event, body);
      if (!widget.event.hasGallery) throw 'credential_required'; // that link/code did not grant the gallery
      _token = null;
      widget.onUnlocked?.call();
      if (mounted) {
        setState(() {});
        _load(reset: true);
      }
    } catch (e) {
      if (mounted) setState(() => _unlockError = e);
    } finally {
      if (mounted) setState(() => _unlocking = false);
    }
    if (mounted && _unlockError != null) snack(context, _unlockError == 'invalid' ? l.invalidLink : errorText(l, _unlockError));
  }

  // ---------------------------------------------------------------- build
  @override
  Widget build(BuildContext context) {
    final l = L10n.of(context);
    if (!widget.event.hasGallery) return _locked(l);
    return Column(children: [
      _controls(l),
      Expanded(child: RefreshIndicator(onRefresh: _refresh, child: _body(l))),
    ]);
  }

  Widget _locked(L10n l) => ListView(padding: const EdgeInsets.all(16), children: [
        Icon(Icons.lock_outline, size: 48, color: Theme.of(context).colorScheme.primary),
        const SizedBox(height: 12),
        Text(l.galleryLocked, textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 20),
        FilledButton.icon(onPressed: _unlocking ? null : _scanGallery, icon: const Icon(Icons.qr_code_scanner), label: Text(l.scanQr)),
        const SizedBox(height: 16),
        TextField(controller: _link, decoration: InputDecoration(labelText: l.codeOrLinkLabel, hintText: l.codeOrLinkHint)),
        const SizedBox(height: 12),
        TextField(controller: _code, decoration: InputDecoration(labelText: '${l.joinCodeLabel} / ${l.passcodeLabel}')),
        const SizedBox(height: 12),
        OutlinedButton(onPressed: _unlocking ? null : _unlock, child: Text(_unlocking ? l.joining : l.continueLabel)),
      ]);

  /// Filter chips + layout switcher (+ a "back to all people" row while looking at one person).
  Widget _controls(L10n l) {
    Widget chip(String label, _View v, {IconData? icon}) {
      final on = _view == v;
      return Padding(
        padding: const EdgeInsets.only(right: 8),
        child: ChoiceChip(
          avatar: icon == null ? null : Icon(icon, size: 16, color: on ? Colors.white : const Color(0xFFF79009)),
          label: Text(label, style: TextStyle(color: on ? Colors.white : null)),
          selected: on,
          onSelected: (_) => _setView(v),
        ),
      );
    }

    final layoutIcons = <_Layout, (IconData, String)>{
      _Layout.grid: (Icons.grid_view_rounded, l.layoutGrid),
      _Layout.masonry: (Icons.dashboard_rounded, l.layoutMasonry),
      _Layout.list: (Icons.view_agenda_rounded, l.layoutList),
      _Layout.bySender: (Icons.people_alt_rounded, l.layoutBySender),
    };
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(14, 8, 6, 2),
        child: Row(children: [chip(l.all, _View.all), chip(l.highlights, _View.highlights, icon: Icons.star_rounded), chip(l.people, _View.people), chip(l.yours, _View.yours)]),
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(8, 0, 8, 0),
        child: Row(children: [
          if (_sender != null)
            Expanded(
              child: TextButton.icon(
                style: TextButton.styleFrom(alignment: Alignment.centerLeft),
                onPressed: () => _setView(_View.people),
                icon: const Icon(Icons.arrow_back_rounded, size: 18),
                label: Text('${_sender!.mine ? l.you : (_sender!.name ?? l.guestUnnamed)} · ${l.photosCount(_sender!.count)}', overflow: TextOverflow.ellipsis),
              ),
            )
          else
            Expanded(child: Padding(padding: const EdgeInsets.only(left: 8), child: Text(_peopleBoards ? '' : l.photosCount(_items.length) + (_done ? '' : '+'), style: Theme.of(context).textTheme.bodySmall?.copyWith(color: Brand.muted)))),
          if (!_peopleBoards)
            for (final e in layoutIcons.entries)
              IconButton(
                tooltip: e.value.$2,
                visualDensity: VisualDensity.compact,
                isSelected: _layout == e.key,
                color: _layout == e.key ? Theme.of(context).colorScheme.primary : Brand.muted,
                icon: Icon(e.value.$1),
                onPressed: () => setState(() => _layout = e.key),
              ),
        ]),
      ),
    ]);
  }

  Widget _body(L10n l) {
    if (_peopleBoards) return _peopleView(l);
    if (_items.isEmpty) {
      return ListView(children: [
        Padding(padding: const EdgeInsets.all(32), child: Center(child: _loading ? const CircularProgressIndicator() : Text(_error != null ? errorText(l, _error) : l.galleryEmpty, textAlign: TextAlign.center))),
      ]);
    }
    const pad = EdgeInsets.fromLTRB(10, 6, 10, 16);
    final spinner = SliverToBoxAdapter(child: _loading ? const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator())) : const SizedBox(height: 8));
    const grid = SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 130, mainAxisSpacing: 8, crossAxisSpacing: 8);

    final slivers = <Widget>[];
    switch (_layout) {
      case _Layout.grid:
        slivers.add(SliverPadding(
          padding: pad,
          sliver: SliverGrid(gridDelegate: grid, delegate: SliverChildBuilderDelegate((c, i) => _Tile(item: _items[i], onTap: () => _openViewer(i)), childCount: _items.length)),
        ));
      case _Layout.masonry:
        slivers.add(SliverPadding(padding: pad, sliver: SliverToBoxAdapter(child: _Masonry(items: _items, onOpen: _openViewer))));
      case _Layout.list:
        slivers.add(SliverPadding(
          padding: pad,
          sliver: SliverList.separated(itemCount: _items.length, separatorBuilder: (_, _) => const SizedBox(height: 16), itemBuilder: (c, i) => _LargeCard(item: _items[i], onTap: () => _openViewer(i))),
        ));
      case _Layout.bySender:
        final groups = <String, List<GalleryItem>>{};
        for (final it in _items) {
          (groups[it.senderKey ?? (it.mine ? 'me' : '_')] ??= []).add(it);
        }
        for (final g in groups.values) {
          final first = g.first;
          final name = first.mine ? l.you : (first.senderName ?? l.guestUnnamed);
          slivers.add(SliverPadding(
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 8),
            sliver: SliverToBoxAdapter(child: Row(children: [
              _Avatar(name: name, size: 30),
              const SizedBox(width: 10),
              Expanded(child: Text(name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16), overflow: TextOverflow.ellipsis)),
              Text(l.photosCount(g.length), style: const TextStyle(color: Brand.muted, fontSize: 13)),
            ])),
          ));
          slivers.add(SliverPadding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            sliver: SliverGrid(gridDelegate: grid, delegate: SliverChildBuilderDelegate((c, i) => _Tile(item: g[i], showName: false, onTap: () => _openViewer(_items.indexOf(g[i]))), childCount: g.length)),
          ));
        }
    }
    slivers.add(spinner);
    return CustomScrollView(controller: _scroll, physics: const AlwaysScrollableScrollPhysics(), slivers: slivers);
  }

  Widget _peopleView(L10n l) {
    if (_senders == null) {
      if (_error == null) _loadSenders();
      return ListView(children: [Padding(padding: const EdgeInsets.all(32), child: Center(child: _error != null ? Text(errorText(l, _error)) : const CircularProgressIndicator()))]);
    }
    if (_senders!.isEmpty) return ListView(children: [Padding(padding: const EdgeInsets.all(32), child: Text(l.noPeople, textAlign: TextAlign.center))]);
    return GridView.builder(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 20),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 220, mainAxisSpacing: 16, crossAxisSpacing: 14, childAspectRatio: .82),
      itemCount: _senders!.length + (_unnamed > 0 ? 1 : 0),
      itemBuilder: (c, i) {
        if (i >= _senders!.length) return _PersonCard(name: l.guestUnnamed, count: _unnamed, covers: const [], onTap: null);
        final b = _senders![i];
        return _PersonCard(name: b.mine ? '${b.name ?? l.guestUnnamed} · ${l.you}' : (b.name ?? l.guestUnnamed), count: b.count, covers: b.covers, onTap: () => _openSender(b));
      },
    );
  }
}

// -------------------------------------------------------------------------------------------------- widgets

Widget _net(String url, {BoxFit fit = BoxFit.cover, int? cacheWidth}) => Image.network(
      url,
      webHtmlElementStrategy: WebHtmlElementStrategy.prefer,
      fit: fit,
      cacheWidth: cacheWidth,
      gaplessPlayback: true,
      errorBuilder: (_, _, _) => const ColoredBox(color: Colors.black12, child: Center(child: Icon(Icons.broken_image))),
    );

class _Avatar extends StatelessWidget {
  const _Avatar({required this.name, this.size = 36});
  final String name;
  final double size;
  @override
  Widget build(BuildContext context) {
    final initial = name.trim().isEmpty ? '?' : String.fromCharCode(name.trim().runes.first).toUpperCase();
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(shape: BoxShape.circle, gradient: Brand.cover(name)),
      child: Text(initial, style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: size * .45)),
    );
  }
}

/// Square thumbnail with the sender's name along the bottom edge.
class _Tile extends StatelessWidget {
  const _Tile({required this.item, required this.onTap, this.showName = true});
  final GalleryItem item;
  final VoidCallback onTap;
  final bool showName;
  @override
  Widget build(BuildContext context) {
    final l = L10n.of(context);
    final name = item.mine ? l.you : item.senderName;
    return GestureDetector(
      onTap: onTap,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: Stack(fit: StackFit.expand, children: [
          _net(item.thumb, cacheWidth: 320),
          if (item.isHighlight) const Positioned(top: 6, right: 8, child: Text('★', style: TextStyle(color: Color(0xFFFFD24D), fontSize: 18, shadows: [Shadow(blurRadius: 3)]))),
          if (showName && name != null)
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: Container(
                padding: const EdgeInsets.fromLTRB(8, 18, 8, 6),
                decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Colors.transparent, Color(0xB3080A14)])),
                child: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w600)),
              ),
            ),
        ]),
      ),
    );
  }
}

/// Pinterest-style collage: photos keep their own aspect ratio and flow into the shortest column.
class _Masonry extends StatelessWidget {
  const _Masonry({required this.items, required this.onOpen});
  final List<GalleryItem> items;
  final void Function(int index) onOpen;
  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final cols = width > 900 ? 4 : (width > 560 ? 3 : 2);
    final cells = List.generate(cols, (_) => <int>[]);
    final heights = List.filled(cols, 0.0);
    for (var i = 0; i < items.length; i++) {
      var best = 0;
      for (var c = 1; c < cols; c++) {
        if (heights[c] < heights[best]) best = c;
      }
      cells[best].add(i);
      heights[best] += items[i].height / (items[i].width == 0 ? 1 : items[i].width);
    }
    return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      for (var c = 0; c < cols; c++)
        Expanded(
          child: Padding(
            padding: EdgeInsets.only(left: c == 0 ? 0 : 4, right: c == cols - 1 ? 0 : 4),
            child: Column(children: [
              for (final i in cells[c])
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: GestureDetector(
                    onTap: () => onOpen(i),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(14),
                      child: AspectRatio(aspectRatio: items[i].width / (items[i].height == 0 ? 1 : items[i].height), child: _net(items[i].thumb, cacheWidth: 480)),
                    ),
                  ),
                ),
            ]),
          ),
        ),
    ]);
  }
}

/// One big photo per row, with who shared it (and the caption) underneath.
class _LargeCard extends StatelessWidget {
  const _LargeCard({required this.item, required this.onTap});
  final GalleryItem item;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final l = L10n.of(context);
    final name = item.mine ? l.you : item.senderName;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      GestureDetector(
        onTap: onTap,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(20),
          child: AspectRatio(aspectRatio: (item.width / (item.height == 0 ? 1 : item.height)).clamp(.6, 1.8), child: _net(item.viewer)),
        ),
      ),
      if (name != null || (item.caption ?? '').isNotEmpty)
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 8, 4, 0),
          child: Row(children: [
            if (name != null) ...[_Avatar(name: name, size: 26), const SizedBox(width: 8)],
            Expanded(child: Text([?name, if ((item.caption ?? '').isNotEmpty) item.caption!].join(' · '), maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600))),
          ]),
        ),
    ]);
  }
}

/// A person board: cover collage + name + photo count.
class _PersonCard extends StatelessWidget {
  const _PersonCard({required this.name, required this.count, required this.covers, required this.onTap});
  final String name;
  final int count;
  final List<String> covers;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final l = L10n.of(context);
    return GestureDetector(
      onTap: onTap,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(22),
            child: covers.isEmpty
                ? Container(decoration: BoxDecoration(gradient: Brand.cover(name)), alignment: Alignment.center, child: _Avatar(name: name, size: 56))
                : Row(children: [
                    Expanded(flex: 2, child: SizedBox.expand(child: _net(covers.first, cacheWidth: 360))),
                    if (covers.length > 1) ...[
                      const SizedBox(width: 2),
                      Expanded(child: Column(children: [for (final c in covers.skip(1).take(2)) ...[Expanded(child: SizedBox.expand(child: _net(c, cacheWidth: 200))), if (c != covers.last) const SizedBox(height: 2)]])),
                    ],
                  ]),
          ),
        ),
        const SizedBox(height: 8),
        Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
        Text(l.photosCount(count), style: const TextStyle(color: Brand.muted, fontSize: 12.5)),
      ]),
    );
  }
}

// -------------------------------------------------------------------------------------------------- viewer

class ViewerScreen extends StatefulWidget {
  const ViewerScreen({super.key, required this.items, required this.index, required this.event, required this.token});
  final List<GalleryItem> items;
  final int index;
  final JoinedEvent event;
  final String token;
  @override
  State<ViewerScreen> createState() => _ViewerScreenState();
}

class _ViewerScreenState extends State<ViewerScreen> {
  late final PageController _page = PageController(initialPage: widget.index);
  late int _i = widget.index;

  Future<void> _save() async {
    final l = L10n.of(context);
    final s = Services.of(context);
    try {
      final r = await s.guestApi.downloadLink(widget.token, widget.items[_i].id);
      final bytes = await s.client.download(r['url'] as String);
      final where = await saveBytes(r['filename'] as String, bytes);
      if (mounted) snack(context, '${l.saved}: $where');
    } catch (e) {
      if (mounted) snack(context, errorText(l, e));
    }
  }

  Future<void> _report() async {
    final l = L10n.of(context);
    final reasons = {'inappropriate': l.reasonInappropriate, 'privacy_concern': l.reasonPrivacy, 'impersonation': l.reasonImpersonation, 'copyright': l.reasonCopyright, 'other': l.reasonOther};
    final choice = await showDialog<String>(
      context: context,
      builder: (c) => SimpleDialog(title: Text(l.reportTitle), children: [for (final e in reasons.entries) SimpleDialogOption(onPressed: () => Navigator.pop(c, e.key), child: Text(e.value))]),
    );
    if (choice == null || !mounted) return;
    try {
      await Services.of(context).guestApi.report(widget.token, widget.items[_i].id, choice);
      if (mounted) snack(context, l.reportThanks);
    } catch (e) {
      if (mounted) snack(context, errorText(l, e));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L10n.of(context);
    final cur = widget.items[_i];
    final who = cur.mine ? l.you : cur.senderName;
    final caption = cur.caption ?? '';
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(backgroundColor: Colors.black, foregroundColor: Colors.white, titleTextStyle: const TextStyle(color: Colors.white, fontSize: 19, fontWeight: FontWeight.w700), centerTitle: true, title: Text('${_i + 1} / ${widget.items.length}'), actions: [
        if (widget.event.downloadsEnabled && cur.canDownload) IconButton(icon: const Icon(Icons.download), tooltip: l.saveToDevice, onPressed: _save),
        IconButton(icon: const Icon(Icons.flag_outlined), tooltip: l.report, onPressed: _report),
      ]),
      body: PageView.builder(
        controller: _page,
        itemCount: widget.items.length,
        onPageChanged: (i) => setState(() => _i = i),
        itemBuilder: (c, i) => InteractiveViewer(
          maxScale: 5,
          // limited preloading: the grid thumbnail is shown instantly, the full image replaces it when decoded
          child: Image.network(
            widget.items[i].viewer,
            webHtmlElementStrategy: WebHtmlElementStrategy.prefer,
            fit: BoxFit.contain,
            loadingBuilder: (c, child, prog) => prog == null ? child : Image.network(widget.items[i].thumb, webHtmlElementStrategy: WebHtmlElementStrategy.prefer, fit: BoxFit.contain),
            errorBuilder: (_, _, _) => const Icon(Icons.broken_image, color: Colors.white54, size: 64),
          ),
        ),
      ),
      bottomNavigationBar: who == null && caption.isEmpty
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: Row(children: [
                  if (who != null) ...[_Avatar(name: who, size: 32), const SizedBox(width: 10)],
                  Expanded(child: Text([?who, if (caption.isNotEmpty) caption].join(' · '), maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600))),
                ]),
              ),
            ),
    );
  }
}
