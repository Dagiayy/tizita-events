import 'package:flutter/material.dart';

import '../core/deep_links.dart';
import '../core/ethiopian_calendar.dart';
import '../data/models.dart';
import '../l10n/app_localizations.dart';
import '../services/app_services.dart';
import 'common.dart';
import 'event_photo.dart';
import 'event_screen.dart';
import 'join_screen.dart';
import 'scan_screen.dart';
import 'settings_screen.dart';
import 'theme.dart';

/// Multi-event home: events the guest joined on this phone + a prominent "join" action.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  List<JoinedEvent> _events = const [];
  bool _loaded = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reload();
  }

  Future<void> _reload() async {
    final ev = await Services.of(context).store.events();
    if (mounted) {
      setState(() {
        _events = ev;
        _loaded = true;
      });
      _refreshCovers(ev);
    }
  }

  /// Cover links are signed and short-lived: renew them in the background so photos keep showing.
  Future<void> _refreshCovers(List<JoinedEvent> list) async {
    final s = Services.of(context);
    final lang = Localizations.localeOf(context).languageCode;
    for (final e in list) {
      await s.sessions.refreshMeta(e, lang: lang);
      if (!mounted) return;
      setState(() {});
    }
  }

  Future<void> _enterCode() async {
    final l = L10n.of(context);
    final ctrl = TextEditingController();
    final value = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(l.enterCode),
        content: TextField(controller: ctrl, autofocus: true, textCapitalization: TextCapitalization.characters, decoration: InputDecoration(labelText: l.codeOrLinkLabel, hintText: l.codeOrLinkHint)),
        actions: [TextButton(onPressed: () => Navigator.pop(c), child: Text(l.cancel)), FilledButton(onPressed: () => Navigator.pop(c, ctrl.text), child: Text(l.continueLabel))],
      ),
    );
    if (value == null || !mounted) return;
    final loc = parseEventLink(value);
    if (loc == null) {
      snack(context, l.invalidLink);
      return;
    }
    await Navigator.push(context, MaterialPageRoute<void>(builder: (_) => JoinScreen(locator: loc)));
    _reload();
  }

  @override
  Widget build(BuildContext context) {
    final l = L10n.of(context);
    final lang = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: _reload,
          child: ListView(padding: const EdgeInsets.fromLTRB(20, 12, 20, 32), children: [
            Row(children: [
              const LogoMark(size: 40),
              const SizedBox(width: 12),
              Expanded(child: Text(l.appName, style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800, letterSpacing: -.5))),
              IconButton.filledTonal(
                icon: const Icon(Icons.settings_outlined),
                tooltip: l.settings,
                onPressed: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => const SettingsScreen())),
              ),
            ]),
            const SizedBox(height: 22),
            _JoinCard(
              onScan: () async {
                await Navigator.push(context, MaterialPageRoute<void>(builder: (_) => const ScanScreen()));
                _reload();
              },
              onCode: _enterCode,
            ),
            const SizedBox(height: 26),
            Text(l.events, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
            const SizedBox(height: 12),
            if (!_loaded)
              const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator()))
            else if (_events.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 36, horizontal: 12),
                child: Column(children: [
                  Icon(Icons.photo_library_outlined, size: 56, color: Brand.muted.withValues(alpha: .6)),
                  const SizedBox(height: 12),
                  Text(l.noEvents, textAlign: TextAlign.center, style: theme.textTheme.bodyLarge?.copyWith(color: Brand.muted)),
                ]),
              )
            else
              for (final e in _events)
                Padding(
                  padding: const EdgeInsets.only(bottom: 14),
                  child: _EventCard(
                    event: e,
                    date: lang == 'am' ? EthiopianDate.fromInstant(e.startsAt).format('am') : '${e.startsAt.toLocal().day}/${e.startsAt.toLocal().month}/${e.startsAt.toLocal().year}',
                    onTap: () async {
                      await Navigator.push(context, MaterialPageRoute<void>(builder: (_) => EventScreen(event: e)));
                      _reload();
                    },
                  ),
                ),
          ]),
        ),
      ),
    );
  }
}

/// Dusk-gradient call to action: scan the host's QR, or type the code.
class _JoinCard extends StatelessWidget {
  const _JoinCard({required this.onScan, required this.onCode});
  final VoidCallback onScan, onCode;

  @override
  Widget build(BuildContext context) {
    final l = L10n.of(context);
    return Container(
      decoration: BoxDecoration(borderRadius: BorderRadius.circular(26), boxShadow: [BoxShadow(color: const Color(0xFF3B1D5A).withValues(alpha: .35), blurRadius: 24, offset: const Offset(0, 12))]),
      clipBehavior: Clip.antiAlias,
      child: EventPhoto(
        type: 'other',
        overlay: const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x66080A14), Color(0xCC080A14)]),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Icon(Icons.qr_code_scanner, color: Colors.white, size: 36),
            const SizedBox(height: 14),
            Text(l.joinEvent, style: const TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.w800, letterSpacing: -.5)),
            const SizedBox(height: 18),
            FilledButton.icon(style: const ButtonStyle(minimumSize: WidgetStatePropertyAll(Size.fromHeight(54))), onPressed: onScan, icon: const Icon(Icons.qr_code_scanner), label: Text(l.scanQr)),
            const SizedBox(height: 10),
            OutlinedButton.icon(
              style: OutlinedButton.styleFrom(foregroundColor: Colors.white, side: const BorderSide(color: Colors.white54), minimumSize: const Size.fromHeight(54)),
              onPressed: onCode,
              icon: const Icon(Icons.keyboard_alt_outlined),
              label: Text(l.enterCode),
            ),
          ]),
        ),
      ),
    );
  }
}

class _EventCard extends StatelessWidget {
  const _EventCard({required this.event, required this.date, required this.onTap});
  final JoinedEvent event;
  final String date;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final l = L10n.of(context);
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(22),
      child: InkWell(
        borderRadius: BorderRadius.circular(22),
        onTap: onTap,
        child: Container(
          height: 160,
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(22), boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: .14), blurRadius: 16, offset: const Offset(0, 6))]),
          clipBehavior: Clip.antiAlias,
          child: EventPhoto(
            type: event.type,
            coverUrl: event.coverUrl,
            overlay: const LinearGradient(begin: Alignment.center, end: Alignment.bottomCenter, colors: [Color(0x00080A14), Color(0xD9080A14)]),
            child: Padding(
              padding: const EdgeInsets.all(18),
              child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                Expanded(
                  child: Column(mainAxisAlignment: MainAxisAlignment.end, crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(event.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontSize: 21, fontWeight: FontWeight.w800, letterSpacing: -.4, height: 1.15)),
                    const SizedBox(height: 4),
                    Text('${event.hostName != null ? '${l.hostedBy(event.hostName!)} · ' : ''}$date', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white70, fontSize: 13, fontWeight: FontWeight.w500)),
                  ]),
                ),
                const Icon(Icons.arrow_forward_rounded, color: Colors.white),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}
