import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/deep_links.dart';
import '../data/models.dart';
import '../l10n/app_localizations.dart';
import '../services/app_services.dart';
import 'common.dart';
import 'event_photo.dart';
import 'event_screen.dart';

/// Event landing -> notice -> credentials -> join. No account; consent is an explicit, separate action.
class JoinScreen extends StatefulWidget {
  const JoinScreen({super.key, required this.locator});
  final EventLocator locator;
  @override
  State<JoinScreen> createState() => _JoinScreenState();
}

class _JoinScreenState extends State<JoinScreen> {
  Map<String, dynamic>? _ctx;
  Object? _error;
  bool _busy = false, _agree = false, _otpSent = false;
  late final TextEditingController _code = TextEditingController(text: widget.locator.code ?? (widget.locator.isToken ? '' : widget.locator.value));
  final _pass = TextEditingController(), _name = TextEditingController(), _phone = TextEditingController(), _otp = TextEditingController();
  String? _proof;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_ctx == null && _error == null) _load();
  }

  Future<void> _load() async {
    final s = Services.of(context);
    try {
      final c = await s.sessions.context(widget.locator.value, lang: Localizations.localeOf(context).languageCode);
      if (mounted) setState(() => _ctx = c);
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  Set<String> get _needs => {
        for (final sc in ((_ctx!['scopes'] as List).cast<Map>()))
          if (!(sc['credential'] == 'code' && sc['credential_satisfied_by_locator'] == true) && sc['credential'] != 'none') sc['credential'] as String,
      };
  bool get _hasUpload => (_ctx!['scopes'] as List).any((s) => (s as Map)['scope'] == 'upload');

  Future<void> _run(Future<void> Function() fn) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await fn();
    } catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _join() => _run(() async {
        final s = Services.of(context);
        final ctx = _ctx!;
        final body = <String, dynamic>{
          if (_needs.contains('code') && _code.text.trim().isNotEmpty) 'code': _code.text.trim(),
          if (_needs.contains('passcode')) 'passcode': _pass.text,
          'verification_proof': ?_proof,
          if (_name.text.trim().isNotEmpty) 'display_name': _name.text.trim(),
          if (_hasUpload && ctx['notice'] != null) 'consent': {'notice_version': (ctx['notice'] as Map)['version'], 'accepted': true},
        };
        final joined = await s.sessions.join(widget.locator, ctx, body);
        if (!mounted) return;
        Navigator.pushReplacement(context, MaterialPageRoute<void>(builder: (_) => EventScreen(event: joined)));
      });

  @override
  Widget build(BuildContext context) {
    final l = L10n.of(context);
    final ctx = _ctx;
    return Scaffold(
      appBar: AppBar(title: Text(l.joinEvent)),
      body: ctx == null
          ? Center(child: _error == null ? const CircularProgressIndicator() : Padding(padding: const EdgeInsets.all(24), child: Text(errorText(l, _error), textAlign: TextAlign.center)))
          : _form(context, l, ctx),
    );
  }

  Widget _form(BuildContext context, L10n l, Map<String, dynamic> ctx) {
    final ev = (ctx['event'] as Map).cast<String, dynamic>();
    final status = ctx['status'] as String;
    final notice = (ctx['notice'] as Map?)?.cast<String, dynamic>();
    final nameRequired = ctx['guest_name_required'] == true;
    final ready = (!_hasUpload || _agree || notice == null) && (!_needs.contains('code') || _code.text.trim().length >= 6) && (!_needs.contains('passcode') || _pass.text.isNotEmpty) && (!_needs.contains('otp') || _proof != null) && (!(nameRequired && _hasUpload) || _name.text.trim().isNotEmpty);
    return ListView(padding: const EdgeInsets.all(16), children: [
      Container(
        height: 200,
        decoration: BoxDecoration(borderRadius: BorderRadius.circular(26)),
        clipBehavior: Clip.antiAlias,
        child: EventPhoto(
          type: ev['type'] as String?,
          coverUrl: ev['cover_url'] as String?,
          overlay: photoShade,
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(mainAxisAlignment: MainAxisAlignment.end, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(ev['name'] as String, style: const TextStyle(color: Colors.white, fontSize: 28, fontWeight: FontWeight.w800, letterSpacing: -.6, height: 1.1)),
              if (ev['host_name'] != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(l.hostedBy(ev['host_name'] as String), style: const TextStyle(color: Colors.white70, fontSize: 15, fontWeight: FontWeight.w500))),
            ]),
          ),
        ),
      ),
      if (status == 'not_started') Padding(padding: const EdgeInsets.only(top: 8), child: Text(l.statusNotStarted)),
      if (status == 'closed') Padding(padding: const EdgeInsets.only(top: 8), child: Text(l.statusClosed)),
      if (status == 'unavailable') Padding(padding: const EdgeInsets.only(top: 8), child: Text(l.statusUnavailable))
      else ...[
        const SizedBox(height: 12),
        if (_needs.contains('code')) TextField(controller: _code, textCapitalization: TextCapitalization.characters, onChanged: (_) => setState(() {}), decoration: InputDecoration(labelText: l.joinCodeLabel)),
        if (_needs.contains('passcode')) Padding(padding: const EdgeInsets.only(top: 12), child: TextField(controller: _pass, obscureText: true, onChanged: (_) => setState(() {}), decoration: InputDecoration(labelText: l.passcodeLabel))),
        if (_needs.contains('otp')) ..._otpFields(l),
        if (_hasUpload) Padding(padding: const EdgeInsets.only(top: 12), child: TextField(controller: _name, maxLength: 60, onChanged: (_) => setState(() {}), decoration: InputDecoration(labelText: nameRequired ? l.nameRequired : l.nameLabel))),
        if (_hasUpload && notice != null) ...[
          Card(child: Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(l.noticeTitle, style: const TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            Text(notice['body'] as String),
            if (notice['legal_status'] != 'approved') Text(l.noticeDraft, style: Theme.of(context).textTheme.bodySmall),
          ]))),
          CheckboxListTile(value: _agree, onChanged: (v) => setState(() => _agree = v ?? false), title: Text(l.noticeAccept), controlAffinity: ListTileControlAffinity.leading, contentPadding: EdgeInsets.zero),
        ],
        if (_error != null) Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(errorText(l, _error), style: TextStyle(color: Theme.of(context).colorScheme.error))),
        const SizedBox(height: 8),
        FilledButton(style: const ButtonStyle(minimumSize: WidgetStatePropertyAll(Size.fromHeight(56))), onPressed: ready && !_busy ? _join : null, child: Text(_busy ? l.joining : l.join)),
      ],
    ]);
  }

  List<Widget> _otpFields(L10n l) => [
        Padding(padding: const EdgeInsets.only(top: 12), child: TextField(controller: _phone, keyboardType: TextInputType.phone, enabled: _proof == null, decoration: InputDecoration(labelText: l.phoneLabel))),
        if (_proof == null && !_otpSent) Padding(padding: const EdgeInsets.only(top: 8), child: OutlinedButton(onPressed: _busy ? null : () => _run(() async { await Services.of(context).guestApi.verify(widget.locator.value, {'phone': _phone.text}); setState(() => _otpSent = true); }), child: Text(l.sendCode))),
        if (_otpSent && _proof == null) ...[
          Padding(padding: const EdgeInsets.only(top: 12), child: TextField(controller: _otp, keyboardType: TextInputType.number, inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(8)], decoration: InputDecoration(labelText: l.smsCodeLabel))),
          OutlinedButton(onPressed: _busy ? null : () => _run(() async { final r = await Services.of(context).guestApi.verify(widget.locator.value, {'phone': _phone.text, 'code': _otp.text}); setState(() => _proof = r['verification_proof'] as String?); }), child: Text(l.verify)),
        ],
        if (_proof != null) const Padding(padding: EdgeInsets.only(top: 8), child: Row(children: [Icon(Icons.verified, color: Colors.green), SizedBox(width: 8), Text('✓')])),
      ];
}

extension JoinedEventLabel on JoinedEvent {
  String get title => name;
}
