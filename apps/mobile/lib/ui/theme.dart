import 'package:flutter/material.dart';

/// EventSnap design tokens: coral accent, deep navy, soft cool-grey canvas, generously rounded surfaces.
class Brand {
  static const coral = Color(0xFFF0475A);
  static const coralDark = Color(0xFFD92F45);
  static const navy = Color(0xFF0F1524);
  static const navy2 = Color(0xFF1A2236);
  static const canvas = Color(0xFFF6F7FB);
  static const line = Color(0xFFE8EAF1);
  static const muted = Color(0xFF667085);

  /// Dusk gradient used on splash-style headers (works without any network image).
  static const dusk = LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xFF120D2B), Color(0xFF3B1D5A), Color(0xFFB2406A), Color(0xFFF08A4B)]);

  /// Deterministic cover gradient per event name (same idea as the web console cards).
  static LinearGradient cover(String seed) {
    final hue = seed.runes.fold<int>(7, (n, c) => (n * 31 + c) % 360).toDouble();
    return LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [HSLColor.fromAHSL(1, hue, .68, .40).toColor(), HSLColor.fromAHSL(1, (hue + 40) % 360, .62, .22).toColor()]);
  }
}

ThemeData buildTheme(Brightness brightness) {
  final dark = brightness == Brightness.dark;
  final scheme = ColorScheme.fromSeed(seedColor: Brand.coral, brightness: brightness).copyWith(
    primary: dark ? const Color(0xFFFF5A6E) : Brand.coral,
    onPrimary: Colors.white,
    secondary: Brand.navy,
    surface: dark ? const Color(0xFF131A2A) : Colors.white,
    surfaceContainerHighest: dark ? const Color(0xFF1B2438) : const Color(0xFFF1F3F8),
    outlineVariant: dark ? const Color(0xFF243049) : Brand.line,
  );
  final canvas = dark ? const Color(0xFF0B101C) : Brand.canvas;
  final ink = dark ? const Color(0xFFEEF1F8) : const Color(0xFF121826);
  final radius = BorderRadius.circular(14);
  OutlineInputBorder border(Color c, [double w = 1]) => OutlineInputBorder(borderRadius: radius, borderSide: BorderSide(color: c, width: w));

  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: canvas,
    fontFamily: null,
    appBarTheme: AppBarTheme(backgroundColor: canvas, foregroundColor: ink, elevation: 0, scrolledUnderElevation: 0, surfaceTintColor: Colors.transparent, centerTitle: false, titleTextStyle: TextStyle(color: ink, fontSize: 19, fontWeight: FontWeight.w700)),
    cardTheme: CardThemeData(color: scheme.surface, elevation: 0, margin: EdgeInsets.zero, surfaceTintColor: Colors.transparent, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18), side: BorderSide(color: scheme.outlineVariant))),
    filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(backgroundColor: scheme.primary, foregroundColor: Colors.white, minimumSize: const Size(64, 52), shape: RoundedRectangleBorder(borderRadius: radius), textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700))),
    outlinedButtonTheme: OutlinedButtonThemeData(style: OutlinedButton.styleFrom(foregroundColor: ink, minimumSize: const Size(64, 52), side: BorderSide(color: scheme.outlineVariant), shape: RoundedRectangleBorder(borderRadius: radius), textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600))),
    textButtonTheme: TextButtonThemeData(style: TextButton.styleFrom(foregroundColor: scheme.primary, textStyle: const TextStyle(fontWeight: FontWeight.w700))),
    floatingActionButtonTheme: FloatingActionButtonThemeData(backgroundColor: scheme.primary, foregroundColor: Colors.white, elevation: 4, shape: const StadiumBorder()),
    inputDecorationTheme: InputDecorationTheme(filled: true, fillColor: scheme.surface, contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16), border: border(scheme.outlineVariant), enabledBorder: border(scheme.outlineVariant), focusedBorder: border(scheme.primary, 1.6), errorBorder: border(scheme.error)),
    chipTheme: ChipThemeData(shape: const StadiumBorder(), side: BorderSide(color: scheme.outlineVariant), backgroundColor: scheme.surface, selectedColor: Brand.navy, checkmarkColor: Colors.white, labelStyle: TextStyle(color: ink, fontWeight: FontWeight.w600), secondaryLabelStyle: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600), showCheckmark: false),
    navigationBarTheme: NavigationBarThemeData(backgroundColor: scheme.surface, surfaceTintColor: Colors.transparent, elevation: 8, height: 68, indicatorColor: scheme.primary.withValues(alpha: .14), labelTextStyle: WidgetStatePropertyAll(TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: ink)), iconTheme: WidgetStateProperty.resolveWith((s) => IconThemeData(color: s.contains(WidgetState.selected) ? scheme.primary : Brand.muted))),
    switchTheme: SwitchThemeData(thumbColor: const WidgetStatePropertyAll(Colors.white), trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? scheme.primary : null)),
    dialogTheme: DialogThemeData(backgroundColor: scheme.surface, surfaceTintColor: Colors.transparent, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(22))),
    snackBarTheme: SnackBarThemeData(behavior: SnackBarBehavior.floating, backgroundColor: Brand.navy, contentTextStyle: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14))),
    dividerTheme: DividerThemeData(color: scheme.outlineVariant, space: 1),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: scheme.primary, linearTrackColor: scheme.surfaceContainerHighest, linearMinHeight: 6),
  );
}

/// Round brand mark: coral rounded square with a camera.
class LogoMark extends StatelessWidget {
  const LogoMark({super.key, this.size = 40});
  final double size;
  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(color: Brand.coral, borderRadius: BorderRadius.circular(size * .3), boxShadow: [BoxShadow(color: Brand.coral.withValues(alpha: .4), blurRadius: size * .4, offset: Offset(0, size * .15))]),
        child: Icon(Icons.photo_camera_outlined, color: Colors.white, size: size * .56),
      );
}
