import 'package:camera/camera.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:uuid/uuid.dart';

import '../data/file_ops.dart';
import '../data/models.dart';
import '../l10n/app_localizations.dart';
import '../services/app_services.dart';
import '../services/background.dart';
import 'common.dart';
import 'event_photo.dart';
import 'theme.dart';

/// Camera-first capture, gallery picker, drafts (explicit delete) and the "original on Wi-Fi" option.
class CaptureTab extends StatefulWidget {
  const CaptureTab({super.key, required this.event});
  final JoinedEvent event;
  @override
  State<CaptureTab> createState() => _CaptureTabState();
}

class _CaptureTabState extends State<CaptureTab> {
  List<Draft> _drafts = const [];
  bool _original = false;
  final _caption = TextEditingController();

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _loadDrafts();
  }

  Future<void> _loadDrafts() async {
    final d = await Services.of(context).store.drafts(eventLocator: widget.event.locator);
    if (mounted) setState(() => _drafts = d);
  }

  Future<void> _addDraft(XFile file) async {
    final s = Services.of(context);
    final dest = await importPhoto(file);
    await s.store.putDraft(Draft(id: const Uuid().v4(), eventLocator: widget.event.locator, path: dest, createdAt: DateTime.now()));
    await _loadDrafts();
  }

  Future<void> _camera() async {
    if (kIsWeb) {
      // Browsers: the system camera/file dialog (the in-app preview needs native camera access).
      final x = await ImagePicker().pickImage(source: ImageSource.camera);
      if (x != null) await _addDraft(x);
      return;
    }
    final path = await Navigator.push<String>(context, MaterialPageRoute(builder: (_) => const CameraScreen()));
    if (path != null) await _addDraft(XFile(path));
  }

  Future<void> _pick() async {
    final files = await ImagePicker().pickMultiImage(requestFullMetadata: false);
    for (final f in files) {
      await _addDraft(f);
    }
  }

  Future<void> _queueAll() async {
    final s = Services.of(context);
    final caption = _caption.text.trim();
    for (final d in _drafts) {
      await s.engine.add(widget.event.locator, d.path, caption: widget.event.captionsEnabled && caption.isNotEmpty ? caption : null, requireOriginal: _original);
      await s.store.deleteDraft(d.id);
    }
    _caption.clear();
    await _loadDrafts();
    if (!kIsWeb) await BackgroundUploads.kick(); // keep uploading even if the app is closed (OS constraints permitting)
    if (mounted) snack(context, L10n.of(context).savedOnDevice);
  }

  Future<void> _deleteDraft(Draft d) async {
    await Services.of(context).store.deleteDraft(d.id);
    try {
      await fileDelete(d.path);
    } catch (_) {}
    await _loadDrafts();
  }

  @override
  Widget build(BuildContext context) {
    final l = L10n.of(context);
    final s = Services.of(context);
    final e = widget.event;
    return ListView(padding: const EdgeInsets.all(16), children: [
      Container(
        height: 150,
        margin: const EdgeInsets.only(bottom: 16),
        decoration: BoxDecoration(borderRadius: BorderRadius.circular(24)),
        clipBehavior: Clip.antiAlias,
        child: EventPhoto(
          type: e.type,
          coverUrl: e.coverUrl,
          overlay: photoShade,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(mainAxisAlignment: MainAxisAlignment.end, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(e.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w800, letterSpacing: -.4, height: 1.1)),
              if ((e.city ?? '').isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text([e.city, e.venue].where((x) => (x ?? '').isNotEmpty).join(' · '), style: const TextStyle(color: Colors.white70, fontSize: 13))),
            ]),
          ),
        ),
      ),
      if (!e.canUpload || e.status != 'open') Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(e.status == 'not_started' ? l.statusNotStarted : l.statusClosed)),
      Row(children: [
        Expanded(child: _ActionTile(icon: Icons.photo_camera_outlined, label: l.takePhoto, colors: const [Color(0xFFFF5D70), Color(0xFFD92F45)], onTap: _camera)),
        const SizedBox(width: 12),
        Expanded(child: _ActionTile(icon: Icons.photo_library_outlined, label: l.choosePhotos, colors: const [Brand.navy2, Brand.navy], onTap: _pick)),
      ]),
      const SizedBox(height: 12),
      ListenableBuilder(
        listenable: s.settings,
        builder: (c, _) => Card(child: Column(children: [
          SwitchListTile(title: Text(l.dataSaver), subtitle: Text(l.dataSaverHint), value: s.settings.dataSaver, onChanged: s.settings.setDataSaver),
          if (!s.settings.dataSaver) SwitchListTile(title: Text(l.wifiOnlyOriginals), subtitle: Text(l.wifiOnlyOriginalsHint), value: _original, onChanged: (v) => setState(() => _original = v)),
        ])),
      ),
      if (_drafts.isNotEmpty) ...[
        const SizedBox(height: 16),
        Text(l.draftsTitle, style: Theme.of(context).textTheme.titleMedium),
        Text(l.draftsHint, style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 8),
        SizedBox(
          height: 110,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: _drafts.length,
            separatorBuilder: (_, _) => const SizedBox(width: 8),
            itemBuilder: (c, i) => Stack(children: [
              ClipRRect(borderRadius: BorderRadius.circular(10), child: photoImage(_drafts[i].path, width: 110, height: 110, cacheWidth: 220)), // decode small: low-RAM devices
              Positioned(right: 0, top: 0, child: IconButton.filled(iconSize: 18, tooltip: l.deleteDraft, onPressed: () => _deleteDraft(_drafts[i]), icon: const Icon(Icons.close))),
            ]),
          ),
        ),
        if (e.captionsEnabled) Padding(padding: const EdgeInsets.only(top: 8), child: TextField(controller: _caption, maxLength: 300, decoration: InputDecoration(labelText: '…'))),
        const SizedBox(height: 8),
        FilledButton.icon(
          style: const ButtonStyle(minimumSize: WidgetStatePropertyAll(Size.fromHeight(56))),
          onPressed: e.canUpload ? _queueAll : null,
          icon: const Icon(Icons.cloud_upload),
          label: Text('${l.usePhoto} (${_drafts.length})'),
        ),
      ],
    ]);
  }
}

/// In-app camera (low-end friendly: medium preset, single capture at a time, controller disposed with the screen).
class CameraScreen extends StatefulWidget {
  const CameraScreen({super.key});
  @override
  State<CameraScreen> createState() => _CameraScreenState();
}

class _CameraScreenState extends State<CameraScreen> with WidgetsBindingObserver {
  CameraController? _c;
  Object? _error;
  bool _busy = false;
  FlashMode _flash = FlashMode.off;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _init();
  }

  Future<void> _init() async {
    try {
      final cams = await availableCameras();
      if (cams.isEmpty) throw StateError('no camera');
      final back = cams.firstWhere((c) => c.lensDirection == CameraLensDirection.back, orElse: () => cams.first);
      final c = CameraController(back, ResolutionPreset.high, enableAudio: false);
      await c.initialize();
      if (!mounted) return c.dispose();
      setState(() => _c = c);
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.inactive) {
      _c?.dispose();
      _c = null;
    } else if (state == AppLifecycleState.resumed && _c == null) {
      _init();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _c?.dispose();
    super.dispose();
  }

  Future<void> _shoot() async {
    final c = _c;
    if (c == null || _busy || c.value.isTakingPicture) return;
    setState(() => _busy = true);
    try {
      final f = await c.takePicture();
      if (mounted) Navigator.pop(context, f.path);
    } catch (_) {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = L10n.of(context);
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(backgroundColor: Colors.black, foregroundColor: Colors.white, titleTextStyle: const TextStyle(color: Colors.white, fontSize: 19, fontWeight: FontWeight.w700), title: Text(l.takePhoto), actions: [
        IconButton(
          icon: Icon(_flash == FlashMode.off ? Icons.flash_off : Icons.flash_auto),
          onPressed: () async {
            _flash = _flash == FlashMode.off ? FlashMode.auto : FlashMode.off;
            await _c?.setFlashMode(_flash);
            setState(() {});
          },
        ),
      ]),
      body: _error != null
          ? Center(child: Padding(padding: const EdgeInsets.all(24), child: Text(l.cameraDenied, style: const TextStyle(color: Colors.white), textAlign: TextAlign.center)))
          : _c == null || !_c!.value.isInitialized
              ? const Center(child: CircularProgressIndicator())
              : Column(children: [
                  Expanded(child: Center(child: CameraPreview(_c!))),
                  Padding(padding: const EdgeInsets.all(20), child: GestureDetector(onTap: _shoot, child: Container(width: 76, height: 76, decoration: BoxDecoration(shape: BoxShape.circle, color: Colors.white, border: Border.all(color: Colors.white54, width: 6))))),
                ]),
    );
  }
}

class _ActionTile extends StatelessWidget {
  const _ActionTile({required this.icon, required this.label, required this.colors, required this.onTap});
  final IconData icon;
  final String label;
  final List<Color> colors;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(24),
          onTap: onTap,
          child: Ink(
            height: 150,
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(24), gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: colors), boxShadow: [BoxShadow(color: colors.last.withValues(alpha: .35), blurRadius: 16, offset: const Offset(0, 8))]),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              Icon(icon, color: Colors.white, size: 34),
              Text(label, style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700, height: 1.2)),
            ]),
          ),
        ),
      );
}
