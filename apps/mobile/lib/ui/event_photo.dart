import 'package:flutter/material.dart';

/// Event types that have a built-in sample picture in `assets/samples/` (see tools/generate-samples.cjs).
const _knownTypes = {'wedding', 'birthday', 'graduation', 'conference', 'corporate', 'party', 'family', 'cultural', 'other'};

String sampleAsset(String? type) => 'assets/samples/${_knownTypes.contains(type) ? type : 'other'}.jpg';

/// The picture for an event: the host's own cover when there is one, otherwise the sample for the event type.
/// The sample is always painted underneath, so there is never an empty box while the cover loads or if it fails (expired link, offline).
class EventPhoto extends StatelessWidget {
  const EventPhoto({super.key, required this.type, this.coverUrl, this.fit = BoxFit.cover, this.overlay, this.child});
  final String? type;
  final String? coverUrl;
  final BoxFit fit;

  /// Optional darkening gradient over the photo so text stays readable.
  final Gradient? overlay;
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    // The photo layers fill whatever size the content (or the parent) gives; they never drive the size themselves,
    // so this also works inside scrolling lists where the height is not fixed.
    return Stack(children: [
      Positioned.fill(child: Image.asset(sampleAsset(type), fit: fit)),
      if (coverUrl != null)
        Positioned.fill(
          child: Image.network(
            coverUrl!,
            fit: fit,
            webHtmlElementStrategy: WebHtmlElementStrategy.prefer,
            frameBuilder: (c, child, frame, sync) => AnimatedOpacity(opacity: frame == null && !sync ? 0 : 1, duration: const Duration(milliseconds: 300), child: child),
            errorBuilder: (_, _, _) => const SizedBox.shrink(),
          ),
        ),
      if (overlay != null) Positioned.fill(child: DecoratedBox(decoration: BoxDecoration(gradient: overlay))),
      ?child,
    ]);
  }
}

/// Standard dark-at-the-bottom overlay for text on photos.
const photoShade = LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x14080A14), Color(0x33080A14), Color(0xCC080A14)], stops: [0, .45, 1]);
