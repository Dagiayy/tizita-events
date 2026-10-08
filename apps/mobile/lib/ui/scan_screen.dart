import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../core/deep_links.dart';
import '../l10n/app_localizations.dart';
import 'common.dart';
import 'join_screen.dart';
import 'theme.dart';

/// QR scanner. Only payloads that parse as event links/codes are accepted; everything else is ignored silently.
class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key, this.pickOnly = false});

  /// When true the scanner returns the scanned [EventLocator] to the caller instead of opening the join screen.
  final bool pickOnly;
  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  final _controller = MobileScannerController(detectionSpeed: DetectionSpeed.noDuplicates, formats: const [BarcodeFormat.qrCode]);
  bool _handled = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture cap) {
    if (_handled) return;
    for (final b in cap.barcodes) {
      final raw = b.rawValue;
      if (raw == null) continue;
      final loc = parseEventLink(raw);
      if (loc == null) continue;
      _handled = true;
      if (widget.pickOnly) {
        Navigator.pop(context, loc);
        return;
      }
      Navigator.pushReplacement(context, MaterialPageRoute<void>(builder: (_) => JoinScreen(locator: loc)));
      return;
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L10n.of(context);
    return Scaffold(
      backgroundColor: Colors.black,
      extendBodyBehindAppBar: true,
      appBar: AppBar(backgroundColor: Colors.transparent, foregroundColor: Colors.white, titleTextStyle: const TextStyle(color: Colors.white, fontSize: 19, fontWeight: FontWeight.w700), title: Text(l.scanQr)),
      body: Stack(fit: StackFit.expand, children: [
        MobileScanner(
          controller: _controller,
          onDetect: _onDetect,
          errorBuilder: (c, e) => Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(l.cameraDenied, style: const TextStyle(color: Colors.white), textAlign: TextAlign.center))),
        ),
        const IgnorePointer(child: ColoredBox(color: Color(0x55000000))),
        Center(child: Container(width: 260, height: 260, decoration: BoxDecoration(borderRadius: BorderRadius.circular(32), border: Border.all(color: Brand.coral, width: 4)))),
      ]),
      floatingActionButtonLocation: FloatingActionButtonLocation.centerFloat,
      floatingActionButton: FloatingActionButton.extended(
        icon: const Icon(Icons.keyboard),
        label: Text(l.enterCode),
        onPressed: () => snack(context, l.codeOrLinkLabel),
      ),
    );
  }
}
