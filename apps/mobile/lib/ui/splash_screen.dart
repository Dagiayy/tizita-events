import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../l10n/app_localizations.dart';
import 'event_photo.dart';
import 'theme.dart';

/// First launch only: a full-screen photo, the brand and a "Get started" button. After that the app opens straight on the home screen.
class SplashGate extends StatefulWidget {
  const SplashGate({super.key, required this.child});
  final Widget child;
  @override
  State<SplashGate> createState() => _SplashGateState();
}

class _SplashGateState extends State<SplashGate> {
  bool? _seen;

  @override
  void initState() {
    super.initState();
    SharedPreferences.getInstance().then((p) {
      if (mounted) setState(() => _seen = p.getBool('splash.seen') ?? false);
    }).catchError((_) {
      if (mounted) setState(() => _seen = true);
    });
  }

  Future<void> _start() async {
    setState(() => _seen = true);
    try {
      await (await SharedPreferences.getInstance()).setBool('splash.seen', true);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final seen = _seen;
    if (seen == null) return const Scaffold(backgroundColor: Brand.navy);
    if (seen) return widget.child;
    final l = L10n.of(context);
    return Scaffold(
      backgroundColor: Brand.navy,
      body: EventPhoto(
        type: 'other',
        overlay: const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x66080A14), Color(0x00080A14), Color(0xE6080A14)], stops: [0, .4, 1]),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(28, 24, 28, 28),
            child: Column(children: [
              const Spacer(flex: 2),
              const LogoMark(size: 72),
              const SizedBox(height: 18),
              Text(l.appName, style: const TextStyle(color: Colors.white, fontSize: 40, fontWeight: FontWeight.w800, letterSpacing: -1)),
              const SizedBox(height: 6),
              Text(l.tagline, style: TextStyle(color: Colors.white70, fontSize: 16, fontWeight: FontWeight.w500, letterSpacing: .4)),
              const Spacer(flex: 3),
              Align(alignment: Alignment.centerLeft, child: Text(l.splashPromise, style: TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w800, height: 1.15, letterSpacing: -.5))),
              const SizedBox(height: 22),
              FilledButton(style: const ButtonStyle(minimumSize: WidgetStatePropertyAll(Size.fromHeight(58))), onPressed: _start, child: Text(l.getStarted)),
            ]),
          ),
        ),
      ),
    );
  }
}
