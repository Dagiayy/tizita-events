import 'package:flutter/material.dart';

import '../core/ethiopian_calendar.dart';
import '../data/models.dart';
import '../l10n/app_localizations.dart';
import '../services/app_services.dart';
import 'capture_tab.dart';
import 'gallery_tab.dart';
import 'mine_tab.dart';
import 'queue_tab.dart';

/// Event context stays locked to the selected event across capture, queue, gallery and "mine" (spec 6.4).
class EventScreen extends StatefulWidget {
  const EventScreen({super.key, required this.event});
  final JoinedEvent event;
  @override
  State<EventScreen> createState() => _EventScreenState();
}

class _EventScreenState extends State<EventScreen> with WidgetsBindingObserver {
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) Services.of(context).syncStatuses();
  }

  @override
  Widget build(BuildContext context) {
    final l = L10n.of(context);
    final e = widget.event;
    final lang = Localizations.localeOf(context).languageCode;
    final tabs = <_Tab>[
      if (e.hasUpload) _Tab(Icons.photo_camera, l.tabCapture, CaptureTab(event: e)),
      if (e.hasUpload) _Tab(Icons.cloud_upload, l.tabQueue, QueueTab(event: e)),
      _Tab(Icons.photo_library, l.tabGallery, GalleryTab(event: e, onUnlocked: () => setState(() {}))),
      if (e.hasUpload) _Tab(Icons.history, l.tabMine, MineTab(event: e)),
    ];
    if (_tab >= tabs.length) _tab = 0;
    return Scaffold(
      appBar: AppBar(
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(e.name, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w800, letterSpacing: -.3)),
          if (lang == 'am') Text(EthiopianDate.fromInstant(e.startsAt).format('am'), style: Theme.of(context).textTheme.bodySmall),
        ]),
        actions: [
          PopupMenuButton<String>(
            onSelected: (v) async {
              if (v == 'leave') {
                final ok = await showDialog<bool>(context: context, builder: (c) => AlertDialog(content: Text(l.leaveEventConfirm), actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: Text(l.cancel)), FilledButton(onPressed: () => Navigator.pop(c, true), child: Text(l.leaveEvent))]));
                if (ok == true && context.mounted) {
                  await Services.of(context).sessions.leave(e.locator);
                  if (context.mounted) Navigator.pop(context);
                }
              }
            },
            itemBuilder: (c) => [PopupMenuItem(value: 'leave', child: Text(l.leaveEvent))],
          ),
        ],
      ),
      body: SafeArea(child: tabs[_tab].body),
      bottomNavigationBar: tabs.length > 1
          ? NavigationBar(selectedIndex: _tab, onDestinationSelected: (i) => setState(() => _tab = i), destinations: [for (final t in tabs) NavigationDestination(icon: Icon(t.icon), label: t.label)])
          : null,
    );
  }
}

class _Tab {
  const _Tab(this.icon, this.label, this.body);
  final IconData icon;
  final String label;
  final Widget body;
}
