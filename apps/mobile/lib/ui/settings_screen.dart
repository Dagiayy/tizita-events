import 'package:flutter/material.dart';

import '../core/config.dart';
import '../data/models.dart';
import '../l10n/app_localizations.dart';
import '../services/app_services.dart';
import 'common.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  UsageTotals _usage = const UsageTotals();

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _loadUsage();
  }

  Future<void> _loadUsage() async {
    final u = await Services.of(context).store.usage();
    if (mounted) setState(() => _usage = u);
  }

  @override
  Widget build(BuildContext context) {
    final l = L10n.of(context);
    final s = Services.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l.settings)),
      body: ListenableBuilder(
        listenable: s.settings,
        builder: (c, _) => ListView(padding: const EdgeInsets.all(8), children: [
          ListTile(
            title: Text(l.language),
            trailing: DropdownButton<String?>(
              value: s.settings.languageCode,
              onChanged: (v) => s.settings.setLanguage(v),
              items: const [DropdownMenuItem(value: null, child: Text('Auto')), DropdownMenuItem(value: 'en', child: Text('English')), DropdownMenuItem(value: 'am', child: Text('አማርኛ'))],
            ),
          ),
          SwitchListTile(title: Text(l.dataSaver), subtitle: Text(l.dataSaverHint), value: s.settings.dataSaver, onChanged: s.settings.setDataSaver),
          SwitchListTile(title: Text(l.wifiOnlyOriginals), subtitle: Text(l.wifiOnlyOriginalsHint), value: s.settings.wifiOnlyOriginals, onChanged: s.settings.setWifiOnlyOriginals),
          SwitchListTile(
            title: Text(l.notificationsLabel),
            subtitle: Text(l.notificationsHint),
            value: s.settings.notifications,
            onChanged: (v) async {
              await s.settings.setNotifications(v);
              if (v) await s.notifier.init();
            },
          ),
          const Divider(),
          ListTile(title: Text(l.dataUsage), subtitle: Text('${l.dataUsageMobile(fmtBytes(_usage.mobileBytes))}\n${l.dataUsageWifi(fmtBytes(_usage.wifiBytes))}'), isThreeLine: true, trailing: TextButton(onPressed: () async { await s.store.resetUsage(); _loadUsage(); }, child: Text(l.dataUsageReset))),
          const Divider(),
          ListTile(leading: const Icon(Icons.privacy_tip_outlined), title: Text(l.privacyRequests), subtitle: Text(l.privacyBody(AppConfig.webOrigin))),
        ]),
      ),
    );
  }
}
