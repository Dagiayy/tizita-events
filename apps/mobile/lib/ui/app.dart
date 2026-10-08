import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import '../core/deep_links.dart';
import '../l10n/app_localizations.dart';
import '../services/app_services.dart';
import 'home_screen.dart';
import 'join_screen.dart';
import 'splash_screen.dart';
import 'theme.dart';

class EventPhotosApp extends StatefulWidget {
  const EventPhotosApp({super.key, required this.services});
  final AppServices services;

  @override
  State<EventPhotosApp> createState() => _EventPhotosAppState();
}

class _EventPhotosAppState extends State<EventPhotosApp> {
  final _nav = GlobalKey<NavigatorState>();
  StreamSubscription<Uri>? _links;

  @override
  void initState() {
    super.initState();
    widget.services.settings.addListener(_onSettings);
    unawaited(widget.services.engine.restore());
    _initLinks();
  }

  Future<void> _initLinks() async {
    final al = AppLinks();
    try {
      final initial = await al.getInitialLink();
      if (initial != null) _open(initial.toString());
    } catch (_) {/* no initial link */}
    _links = al.uriLinkStream.listen((u) => _open(u.toString()));
  }

  /// Secure deep-link handling: only recognised event links (https host allow-list or the app scheme) are acted upon.
  void _open(String raw) {
    final loc = parseEventLink(raw);
    if (loc == null) return;
    _nav.currentState?.push(MaterialPageRoute<void>(builder: (_) => JoinScreen(locator: loc)));
  }

  void _onSettings() => setState(() {});

  @override
  void dispose() {
    widget.services.settings.removeListener(_onSettings);
    _links?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final lang = widget.services.settings.languageCode;
    return Services(
      services: widget.services,
      child: MaterialApp(
        navigatorKey: _nav,
        onGenerateTitle: (c) => L10n.of(c).appName,
        debugShowCheckedModeBanner: false,
        locale: lang == null ? null : Locale(lang),
        supportedLocales: L10n.supportedLocales,
        localizationsDelegates: const [L10n.delegate, GlobalMaterialLocalizations.delegate, GlobalWidgetsLocalizations.delegate, GlobalCupertinoLocalizations.delegate],
        theme: buildTheme(Brightness.light),
        darkTheme: buildTheme(Brightness.dark),
        home: const SplashGate(child: HomeScreen()),
      ),
    );
  }
}
