import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// User preferences (data saver, Wi-Fi-only originals, notifications, language). Observable so screens update live.
class AppSettings extends ChangeNotifier {
  AppSettings._(this._prefs);
  final SharedPreferences _prefs;

  static Future<AppSettings> load() async => AppSettings._(await SharedPreferences.getInstance());

  bool get dataSaver => _prefs.getBool('dataSaver') ?? false;
  bool get wifiOnlyOriginals => _prefs.getBool('wifiOnlyOriginals') ?? true;
  bool get notifications => _prefs.getBool('notifications') ?? false;
  String? get languageCode => _prefs.getString('lang');

  Future<void> setDataSaver(bool v) => _set('dataSaver', v);
  Future<void> setWifiOnlyOriginals(bool v) => _set('wifiOnlyOriginals', v);
  Future<void> setNotifications(bool v) => _set('notifications', v);
  Future<void> setLanguage(String? code) async {
    if (code == null) {
      await _prefs.remove('lang');
    } else {
      await _prefs.setString('lang', code);
    }
    notifyListeners();
  }

  Future<void> _set(String k, bool v) async {
    await _prefs.setBool(k, v);
    notifyListeners();
  }
}
