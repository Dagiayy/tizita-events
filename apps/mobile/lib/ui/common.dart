import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../l10n/app_localizations.dart';

String fmtBytes(int n) => n >= 1048576 ? '${(n / 1048576).toStringAsFixed(1)} MB' : '${(n / 1024).ceil().clamp(1, 1 << 30)} KB';

/// Maps an API error code to a localized, user-friendly message.
String errorText(L10n l, Object? error) {
  final code = error is ApiException ? (error.isNetwork ? 'network' : error.code) : (error is String ? error : null);
  switch (code) {
    case 'network':
    case 'timeout':
    case 'tls':
      return l.errNetwork;
    case 'rate_limited':
      return l.errRateLimited;
    case 'otp_invalid':
    case 'otp_locked':
      return l.errOtpInvalid;
    case 'event_not_found':
      return l.errEventNotFound;
    case 'credential_required':
      return l.errCredentialRequired;
    case 'consent_required':
      return l.errConsentRequired;
    case 'name_required':
      return l.nameRequired;
    case 'file_too_large':
      return l.errFileTooLarge;
    case 'unsupported_type':
      return l.errUnsupportedType;
    case 'event_storage_full':
      return l.errStorageFull;
    case 'event_media_limit':
      return l.errMediaLimit;
    case 'outside_upload_window':
    case 'event_not_accepting_uploads':
    case 'uploads_disabled':
      return l.errOutsideWindow;
    case 'session_blocked':
      return l.errSessionBlocked;
    case 'guest_session_expired':
      return l.errSessionExpired;
    case 'event_state_forbids':
      return l.errEventState;
    default:
      return l.errGeneric;
  }
}

void snack(BuildContext c, String msg) => ScaffoldMessenger.of(c).showSnackBar(SnackBar(content: Text(msg)));

/// Large, thumb-friendly action button (low-end phones, bright outdoor light).
class BigButton extends StatelessWidget {
  const BigButton({super.key, required this.icon, required this.label, required this.onPressed, this.primary = false});
  final IconData icon;
  final String label;
  final VoidCallback? onPressed;
  final bool primary;

  @override
  Widget build(BuildContext context) {
    final style = ButtonStyle(minimumSize: const WidgetStatePropertyAll(Size.fromHeight(60)), textStyle: const WidgetStatePropertyAll(TextStyle(fontSize: 17, fontWeight: FontWeight.w700)));
    return primary ? FilledButton.icon(onPressed: onPressed, icon: Icon(icon), label: Text(label), style: style) : OutlinedButton.icon(onPressed: onPressed, icon: Icon(icon), label: Text(label), style: style);
  }
}
